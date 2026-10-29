import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import pc from "picocolors";
import { SAME_SCREEN, layoutKey, signature, similarity } from "../core/screens.js";
import type { Platform } from "../core/types.js";
import { BusyError, DeviceToolError, exec, type DeviceSession, type Exec } from "../devices/exec.js";
import { counts, formatResult } from "../report/terminal.js";
import { failedAt, loadSettings } from "./audit.js";
import { clearScreens, openSessions, recordScreen, writeScreensReport, type AuditedScreen } from "./screens.js";

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

export type WatchedScreen = AuditedScreen;

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
    const { sessions, notes } = await openSessions(run, { ...options, ...(settings.package ? { package: settings.package } : {}), tmpDir });
    const states: PlatformState[] = sessions.map((session) => ({ session }));
    await clearScreens(out);
    hooks.onEvent?.({ type: "watching", sessions, notes });

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

        const screen = await recordScreen(state.session, tree, { out, screens, screenshot: options.screenshot, profile: settings.profile, ignore: settings.ignore });
        await writeScreensReport(out, screens, version, "Watch");
        const index = screens.length;
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
