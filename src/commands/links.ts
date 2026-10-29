import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import pc from "picocolors";
import { layoutKey } from "../core/screens.js";
import type { A11yNode, Platform } from "../core/types.js";
import { BusyError, DeviceToolError, exec, type DeviceSession, type Exec } from "../devices/exec.js";
import { counts, formatResult } from "../report/terminal.js";
import { failedAt, loadSettings, type AuditOptions } from "./audit.js";
import { clearScreens, openSessions, recordScreen, writeScreensReport, type AuditedScreen } from "./screens.js";

/** rn-deeplink's shared test links; rn-a11y only reads the file. */
export const LINKS_FILE = ".deeplinks.json";

export interface Link {
  url: string;
  name?: string;
  /** Only open this link on one platform. */
  platform?: Platform;
}

const isUrl = (value: string) => /^[a-z][a-z0-9+.-]*:\/\/?\S+$/i.test(value);

/**
 * Reads links from rn-deeplink's .deeplinks.json format (`{ "links": [...] }` or an
 * array of URLs or `{ url, name?, platform? }`), or from a text file with one URL per line.
 */
export function parseLinks(text: string, file: string): Link[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((url, i) => {
        if (!isUrl(url)) throw new DeviceToolError(`${file} line ${i + 1}: "${url}" isn't a URL with a scheme.`);
        return { url };
      });
  }
  const entries = Array.isArray(json) ? json : (json as { links?: unknown })?.links;
  if (!Array.isArray(entries)) throw new DeviceToolError(`${file} must look like { "links": [{ "name": "Cart", "url": "myapp://cart" }] }.`);
  return entries.map((entry: unknown, i) => {
    const link = typeof entry === "string" ? { url: entry } : (entry as Partial<Link>);
    if (typeof link?.url !== "string" || !isUrl(link.url)) throw new DeviceToolError(`${file} entry ${i + 1} needs a "url" with a scheme.`);
    if (link.platform !== undefined && link.platform !== "ios" && link.platform !== "android") {
      throw new DeviceToolError(`${file} entry ${i + 1}: "platform" must be "ios" or "android".`);
    }
    return { url: link.url, ...(typeof link.name === "string" ? { name: link.name } : {}), ...(link.platform ? { platform: link.platform } : {}) };
  });
}

export async function loadLinks(cwd: string, file: string | true | undefined, urls: string[] = []): Promise<Link[]> {
  const links: Link[] = [];
  if (file) {
    const path = resolve(cwd, file === true ? LINKS_FILE : file);
    if (!existsSync(path)) {
      throw new DeviceToolError(
        file === true
          ? `No ${LINKS_FILE} in ${cwd}. Pass a file with --links links.txt (one URL per line), or URLs with --url myapp://home.`
          : `Can't find ${file}.`,
      );
    }
    links.push(...parseLinks(await readFile(path, "utf8"), file === true ? LINKS_FILE : file));
  }
  for (const url of urls) {
    if (!isUrl(url)) throw new DeviceToolError(`--url "${url}" isn't a URL with a scheme.`);
    links.push({ url });
  }
  if (links.length === 0) throw new DeviceToolError(`No links to audit. Add some to ${LINKS_FILE} or pass --url.`);
  return links;
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Time for the app to start navigating before the screen is read. */
const OPEN_DELAY = 800;
const POLL = 400;
/** How long to wait for a different screen before accepting that the link stays on this one. */
const CHANGE_WAIT = 3000;

/**
 * Reads the screen until two reads in a row agree. Until CHANGE_WAIT has passed, a
 * screen that looks like the one before the link opened doesn't count, as the app may
 * not have navigated yet.
 */
/** The app a tree belongs to: the iOS app's name, or the Android package. */
export const appOf = (root: A11yNode) => root.label.trim() || root.children.find((c) => c.package)?.package || undefined;

async function waitForScreen(session: DeviceSession, before: string | undefined, app: string | undefined, timeout: number, sleep: Sleep) {
  let waited = OPEN_DELAY;
  await sleep(OPEN_DELAY);
  let last: { tree: { root: A11yNode; raw: string }; layout: string } | undefined;
  while (true) {
    try {
      const tree = await session.readTree();
      // A system prompt, the home screen or another app: keep waiting for the app.
      if (app && appOf(tree.root) !== app) {
        last = undefined;
        if (waited >= timeout) return undefined;
        await sleep(POLL);
        waited += POLL;
        continue;
      }
      const layout = layoutKey(tree.root, { width: tree.root.frame.width, height: tree.root.frame.height });
      const unchanged = layout === before && waited < CHANGE_WAIT;
      if (last && layout === last.layout && !unchanged) return { tree, layout, settled: true };
      last = { tree, layout };
    } catch (error) {
      if (!(error instanceof BusyError)) throw error;
    }
    if (waited >= timeout) return last ? { ...last, settled: false } : undefined;
    await sleep(POLL);
    waited += POLL;
  }
}

export interface LinkError {
  link: Link;
  platform: Platform;
  message: string;
}

export type LinkEvent =
  | { type: "start"; sessions: DeviceSession[]; links: Link[]; notes: string[] }
  | { type: "screen"; screen: AuditedScreen; link: Link; index: number }
  | { type: "error"; error: LinkError };

export interface LinkAuditOptions extends AuditOptions {
  links?: string | true;
  url?: string[];
  /** Milliseconds to wait for each screen to settle. */
  wait: number;
}

/** Opens each link on each device, waits for the screen to settle, and audits it into one report. */
export async function runLinkAudit(
  options: LinkAuditOptions,
  run: Exec = exec,
  version = "0.0.0",
  hooks: { onEvent?: (event: LinkEvent) => void; sleep?: Sleep } = {},
) {
  const settings = await loadSettings(options);
  const sleep = hooks.sleep ?? realSleep;
  const links = await loadLinks(options.cwd, options.links, options.url);
  const base = resolve(options.cwd, options.out ?? join("a11y-report", "links"));
  const out = options.name ? join(base, options.name) : base;
  const tmpDir = await mkdtemp(join(tmpdir(), "rn-a11y-"));
  const screens: AuditedScreen[] = [];
  const errors: LinkError[] = [];

  try {
    const { sessions, notes } = await openSessions(run, { ...options, ...(settings.package ? { package: settings.package } : {}), tmpDir });
    await clearScreens(out);
    hooks.onEvent?.({ type: "start", sessions, links, notes });

    for (const session of sessions) {
      const platform = session.device.platform;
      // What's showing now, so the first link isn't audited before the app navigates,
      // and which app it is, so a system prompt or another app is never audited instead.
      const start = await session.readTree().catch((error: unknown) => {
        if (error instanceof DeviceToolError) return undefined;
        throw error;
      });
      let before = start && layoutKey(start.root, { width: start.root.frame.width, height: start.root.frame.height });
      const app = start && appOf(start.root);
      for (const link of links.filter((l) => !l.platform || l.platform === platform)) {
        const fail = (message: string) => {
          const error = { link, platform, message };
          errors.push(error);
          hooks.onEvent?.({ type: "error", error });
        };
        try {
          await session.openUrl(link.url);
          const shown = await waitForScreen(session, before, app, options.wait, sleep);
          if (!shown) {
            const hint = platform === "ios" ? ' If iOS is asking "Open in …?", tap Open once on the simulator and run again.' : "";
            fail(`${app ?? "The app"} didn't show a screen within ${options.wait / 1000}s.${hint}`);
            continue;
          }
          before = shown.layout;
          const screen = await recordScreen(session, shown.tree, {
            out,
            screens,
            screenshot: options.screenshot,
            profile: settings.profile,
            ignore: settings.ignore,
            url: link.url,
            ...(link.name ? { name: link.name } : {}),
          });
          if (!shown.settled) screen.result.notes.push(`The screen was still changing after ${options.wait / 1000}s; this is how it looked then.`);
          await writeScreensReport(out, screens, version, options.name ?? "Deep links");
          hooks.onEvent?.({ type: "screen", screen, link, index: screens.length });
        } catch (error) {
          if (!(error instanceof DeviceToolError)) throw error;
          fail(error.message);
        }
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  const results = screens.map((s) => s.result);
  return {
    screens,
    errors,
    reportPath: screens.length ? join(out, "report.html") : undefined,
    failed: failedAt(results, settings.failOn),
    failOn: settings.failOn,
  };
}

export async function linkAuditCommand(options: LinkAuditOptions, version: string) {
  const label = (p: Platform) => (p === "ios" ? "iOS" : "Android");
  const { screens, errors, reportPath, failed, failOn } = await runLinkAudit(options, exec, version, {
    onEvent: (event) => {
      if (options.json) return;
      if (event.type === "start") {
        for (const note of event.notes) console.log(pc.dim(`note: ${note}`));
        const devices = event.sessions.map((s) => `${label(s.device.platform)} · ${s.device.name}`).join(" and ");
        console.log(`Opening ${event.links.length} link${event.links.length === 1 ? "" : "s"} on ${devices}.\n`);
      } else if (event.type === "error") {
        console.log(pc.red(`  ✖ ${event.error.link.url} ${pc.dim(label(event.error.platform))}: ${event.error.message}`));
      } else {
        const { screen, link, index } = event;
        if (options.verbose) {
          console.log(`${formatResult(screen.result)}\n`);
          return;
        }
        const summary = screen.result.findings.length
          ? counts(screen.result.findings)
              .map(([sev, n]) => `${n} ${sev}`)
              .join(", ")
          : pc.green("no issues");
        console.log(`${pc.bold(`${String(index).padStart(2)}. ${screen.name}`)} ${pc.dim(`${link.url} · ${label(screen.platform)}`)} · ${summary}`);
      }
    },
  });

  if (options.json) {
    console.log(JSON.stringify({ version, results: screens.map((s) => s.result), errors, ...(reportPath ? { report: reportPath } : {}) }, null, 2));
  } else {
    const total = screens.reduce((n, s) => n + s.result.findings.length, 0);
    console.log(`\n${screens.length} screen${screens.length === 1 ? "" : "s"}, ${total} issue${total === 1 ? "" : "s"}${errors.length ? pc.red(`, ${errors.length} link${errors.length === 1 ? "" : "s"} failed`) : ""}.`);
    if (reportPath) {
      const shown = relative(process.cwd(), reportPath);
      console.log(`Report: ${shown.startsWith("..") ? reportPath : shown}`);
    }
    if (failed) console.log(pc.red(`Failed: found an issue rated ${failOn}${failOn === "critical" ? "" : " or worse"} (--fail-on ${failOn}).`));
  }
  // A link that didn't open means part of the app went unaudited.
  if (failed || errors.length) process.exitCode = 1;
}
