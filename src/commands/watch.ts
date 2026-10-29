import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import pc from "picocolors";
import { audit } from "../core/audit.js";
import { SAME_SCREEN, layoutKey, screenName, signature, similarity, slug } from "../core/screens.js";
import { saveSnapshot } from "../core/store.js";
import type { AuditResult, Platform, Snapshot } from "../core/types.js";
import { BusyError, DeviceToolError, exec, type DeviceSession, type Exec } from "../devices/exec.js";
import { renderHtml, type ReportSection } from "../report/html.js";
import { counts, formatResult } from "../report/terminal.js";
import { failedAt, loadSettings, openSession } from "./audit.js";

export interface WatchOptions {
  cwd: string;
  platform: "ios" | "android" | "both";
  device?: string;
  package?: string;
  profile?: string;
  out?: string;
  failOn?: string;
  ignore?: string[];
  screenshot: boolean;
  /** Milliseconds between tree reads. */
  interval: number;
  /** Print every issue of each new screen, not just the counts. */
  verbose?: boolean;
}

export interface WatchedScreen {
  name: string;
  platform: Platform;
  dir: string;
  result: AuditResult;
  section: ReportSection;
}

export type WatchEvent =
  | { type: "watching"; sessions: DeviceSession[]; notes: string[] }
  | { type: "screen"; screen: WatchedScreen; index: number }
  | { type: "skipped"; platform: Platform; message: string };

interface Hooks {
  signal: AbortSignal;
  onEvent?: (event: WatchEvent) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
  });

interface PlatformState {
  session: DeviceSession;
  /** Layout of the previous read: a screen is audited once two reads in a row agree. */
  lastLayout?: string;
  /** Layout last handled, so a screen that stays put isn't checked again. */
  handledLayout?: string;
  /** Last error reported, so a lasting problem is printed once. */
  lastError?: string;
}

/**
 * Reads the open screen of each device over and over. When the screen has settled
 * and isn't one already audited, it takes a screenshot, audits it and adds it to
 * one report, until the signal aborts.
 */
export async function runWatch(options: WatchOptions, run: Exec = exec, version = "0.0.0", hooks: Hooks) {
  const settings = await loadSettings(options);
  const sleep = hooks.sleep ?? abortableSleep;
  const out = resolve(options.cwd, options.out ?? join("a11y-report", "watch"));
  const reportPath = join(out, "report.html");
  const tmpDir = await mkdtemp(join(tmpdir(), "rn-a11y-"));
  const screens: WatchedScreen[] = [];
  const signatures: { platform: Platform; signature: Set<string> }[] = [];

  try {
    const platforms: Platform[] = options.platform === "both" ? ["ios", "android"] : [options.platform];
    const states: PlatformState[] = [];
    const notes: string[] = [];
    const skipped: string[] = [];
    for (const platform of platforms) {
      if (platform === "ios" && options.platform === "both" && process.platform !== "darwin") continue;
      try {
        const opened = await openSession(run, platform, {
          tmpDir,
          ...(options.device ? { device: options.device } : {}),
          ...(settings.package ? { package: settings.package } : {}),
        });
        states.push({ session: opened.session });
        notes.push(...opened.notes);
      } catch (error) {
        if (options.platform !== "both" || !(error instanceof DeviceToolError)) throw error;
        skipped.push(`${platform === "ios" ? "iOS" : "Android"}: ${error.message}`);
      }
    }
    if (states.length === 0) throw new DeviceToolError(`Nothing to watch.\n  ${skipped.join("\n  ")}`);
    // Each run replaces the last one's screens, which this tool wrote.
    await rm(join(out, "screens"), { recursive: true, force: true });
    hooks.onEvent?.({ type: "watching", sessions: states.map((s) => s.session), notes });

    while (!hooks.signal.aborted) {
      for (const state of states) {
        if (hooks.signal.aborted) break;
        const platform = state.session.device.platform;
        let tree;
        try {
          tree = await state.session.readTree();
          state.lastError = undefined;
        } catch (error) {
          if (!(error instanceof DeviceToolError)) throw error;
          // Busy (animating) or the app is between screens: try again on the next round.
          if (!(error instanceof BusyError) && state.lastError !== error.message) hooks.onEvent?.({ type: "skipped", platform, message: error.message });
          state.lastError = error.message;
          continue;
        }

        const screenSize = { width: tree.root.frame.width, height: tree.root.frame.height };
        const layout = layoutKey(tree.root, screenSize);
        const settled = layout === state.lastLayout;
        state.lastLayout = layout;
        if (!settled || layout === state.handledLayout) continue;
        state.handledLayout = layout;

        const sig = signature(tree.root, screenSize);
        if (sig.size === 0 || signatures.some((s) => s.platform === platform && similarity(s.signature, sig) >= SAME_SCREEN)) continue;
        signatures.push({ platform, signature: sig });

        const { snapshot, raw } = await state.session.snapshot(tree, { screenshot: options.screenshot });
        const index = screens.length + 1;
        const name = uniqueName(screenName(snapshot.root, snapshot.screen) ?? `Screen ${index}`, screens);
        const named: Snapshot = { ...snapshot, name };
        const result = audit(named, { profile: settings.profile, ignore: settings.ignore });
        const dir = join(out, "screens", `${String(index).padStart(2, "0")}-${slug(name)}`);
        await saveSnapshot(join(dir, platform), named, raw);
        const screen: WatchedScreen = {
          name,
          platform,
          dir,
          result,
          section: { result, title: name, screen: named.screen, ...(raw.screenshot ? { screenshot: raw.screenshot } : {}) },
        };
        screens.push(screen);
        await writeReport(out, screens, version);
        hooks.onEvent?.({ type: "screen", screen, index });
      }
      await sleep(options.interval, hooks.signal);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  const results = screens.map((s) => s.result);
  return { screens, reportPath: screens.length ? reportPath : undefined, failed: failedAt(results, settings.failOn), failOn: settings.failOn };
}

/** Two different screens can share a heading ("Settings"); number the later ones. */
function uniqueName(name: string, screens: WatchedScreen[]) {
  const taken = new Set(screens.map((s) => s.name));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} (${n})`)) n++;
  return `${name} (${n})`;
}

async function writeReport(out: string, screens: WatchedScreen[], version: string) {
  await mkdir(out, { recursive: true });
  const results = screens.map((s) => s.result);
  await writeFile(join(out, "report.json"), `${JSON.stringify({ version, results }, null, 2)}\n`);
  await writeFile(join(out, "report.html"), renderHtml(screens.map((s) => s.section), { title: "Watch", version }));
}

const show = (path: string) => {
  const rel = relative(process.cwd(), path);
  return rel.startsWith("..") ? path : rel;
};

export async function watchCommand(options: WatchOptions, version: string) {
  const controller = new AbortController();
  let stops = 0;
  const onSigint = () => {
    // The first Ctrl+C finishes the report; a second one quits at once.
    if (++stops > 1) process.exit(130);
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  try {
    const { screens, reportPath, failed, failOn } = await runWatch(options, exec, version, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "watching") {
          for (const note of event.notes) console.log(pc.dim(`note: ${note}`));
          const devices = event.sessions.map((s) => `${s.device.platform === "ios" ? "iOS" : "Android"} · ${s.device.name}`).join(" and ");
          console.log(`Watching ${devices}. Move through your app; each new screen is audited once it settles.`);
          console.log(pc.dim("Press Ctrl+C to finish.\n"));
        } else if (event.type === "skipped") {
          console.log(pc.yellow(`! ${event.platform === "ios" ? "iOS" : "Android"}: ${event.message}`));
        } else {
          const { screen, index } = event;
          const summary = screen.result.findings.length
            ? counts(screen.result.findings)
                .map(([sev, n]) => `${n} ${sev}`)
                .join(", ")
            : pc.green("no issues");
          if (options.verbose) console.log(`${formatResult(screen.result)}\n`);
          else console.log(`${pc.bold(`${String(index).padStart(2)}. ${screen.name}`)} ${pc.dim(screen.platform === "ios" ? "iOS" : "Android")} · ${summary}`);
        }
      },
    });
    console.log("");
    if (!screens.length) {
      console.log("No screens were audited.");
      return;
    }
    const total = screens.reduce((n, s) => n + s.result.findings.length, 0);
    console.log(`${screens.length} screen${screens.length === 1 ? "" : "s"}, ${total} issue${total === 1 ? "" : "s"}.`);
    if (reportPath) console.log(`Report: ${show(reportPath)}`);
    if (failed) {
      console.log(pc.red(`Failed: found an issue rated ${failOn}${failOn === "critical" ? "" : " or worse"} (--fail-on ${failOn}).`));
      process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}
