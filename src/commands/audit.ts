import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import pc from "picocolors";
import { atLeast, audit } from "../core/audit.js";
import { PROFILES, loadConfig } from "../core/config.js";
import { loadSnapshot, saveSnapshot, snapshotDirs } from "../core/store.js";
import { SEVERITIES, type AuditResult, type DeviceInfo, type Platform, type ProfileName, type Severity, type Snapshot } from "../core/types.js";
import { androidSession, findAdb, listAndroidDevices } from "../devices/android.js";
import { DeviceToolError, exec, type DeviceSession, type Exec } from "../devices/exec.js";
import { iosSession, listBootedSimulators } from "../devices/ios.js";
import { renderHtml, type ReportSection } from "../report/html.js";
import { formatResult } from "../report/terminal.js";

export interface AuditOptions {
  cwd: string;
  platform: "ios" | "android" | "both";
  device?: string;
  package?: string;
  profile?: string;
  out?: string;
  name?: string;
  report: boolean;
  screenshot: boolean;
  from?: string;
  failOn?: string;
  ignore?: string[];
  json?: boolean;
}

export interface Captured {
  snapshot: Snapshot;
  /** Fresh from a device: the tool output to save next to the report. */
  raw?: { tree: string; screenshot?: Buffer };
  /** Loaded with --from: the folder it came from. */
  dir?: string;
}

const pickDevice = (devices: DeviceInfo[], wanted: string | undefined, platform: string): { device?: DeviceInfo; note?: string } => {
  if (wanted) {
    const w = wanted.toLowerCase();
    const device = devices.find((d) => d.id === wanted) ?? devices.find((d) => d.name.toLowerCase().includes(w));
    return device ? { device } : {};
  }
  const [device] = devices;
  return devices.length > 1 ? { device, note: `${devices.length} ${platform} devices are running; using ${device!.name}. Pick one with --device.` } : { ...(device ? { device } : {}) };
};

/** Finds the device to use on one platform and opens a session on it. */
export async function openSession(
  run: Exec,
  platform: Platform,
  options: { device?: string; package?: string; tmpDir: string },
): Promise<{ session: DeviceSession; notes: string[] }> {
  const notes: string[] = [];
  if (platform === "ios") {
    const { device, note } = pickDevice(await listBootedSimulators(run), options.device, "iOS");
    if (!device) throw new DeviceToolError(options.device ? `No booted iOS simulator matches "${options.device}".` : "No iOS simulator is booted. Boot one and open your app.");
    if (note) notes.push(note);
    return { session: iosSession(run, device, { tmpDir: options.tmpDir }), notes };
  }
  const adbPath = findAdb();
  const { devices, unusable } = await listAndroidDevices(run, adbPath);
  notes.push(...unusable);
  const { device, note } = pickDevice(devices, options.device, "Android");
  if (!device) throw new DeviceToolError(options.device ? `No Android device matches "${options.device}".` : "No Android emulator or device is connected. Start one and open your app.");
  if (note) notes.push(note);
  return { session: androidSession(run, adbPath, device, { tmpDir: options.tmpDir, ...(options.package ? { package: options.package } : {}) }), notes };
}

/** Captures every requested platform. A platform asked for by name must work; with "both", missing ones are skipped. */
export async function captureAll(options: AuditOptions & { package?: string }, run: Exec = exec): Promise<{ captured: Captured[]; notes: string[] }> {
  const platforms: Platform[] = options.platform === "both" ? ["ios", "android"] : [options.platform];
  const strict = options.platform !== "both";
  const captured: Captured[] = [];
  const notes: string[] = [];
  const skipped: string[] = [];
  const tmpDir = await mkdtemp(join(tmpdir(), "rn-a11y-"));
  try {
    for (const platform of platforms) {
      try {
        if (platform === "ios" && !strict && process.platform !== "darwin") continue;
        const opened = await openSession(run, platform, {
          tmpDir,
          ...(options.device ? { device: options.device } : {}),
          ...(options.package ? { package: options.package } : {}),
        });
        notes.push(...opened.notes);
        const tree = await opened.session.readTree();
        captured.push(await opened.session.snapshot(tree, { screenshot: options.screenshot }));
      } catch (error) {
        if (strict || !(error instanceof DeviceToolError)) throw error;
        skipped.push(`${platform === "ios" ? "iOS" : "Android"}: ${error.message}`);
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
  if (captured.length === 0) throw new DeviceToolError(`Nothing to audit.\n  ${skipped.join("\n  ")}`);
  // Say why a platform was skipped only when the device was there but the tooling failed.
  notes.push(...skipped.filter((s) => !/is booted|is connected|isn't installed|need macOS/.test(s)));
  return { captured, notes };
}

/** Flags merged over rn-a11y.config.json. */
export async function loadSettings(options: Pick<AuditOptions, "cwd" | "profile" | "failOn" | "ignore" | "package">) {
  const config = await loadConfig(options.cwd);
  const profile = (options.profile ?? config.profile ?? "wcag22-aa") as ProfileName;
  if (!PROFILES.includes(profile)) throw new DeviceToolError(`--profile must be one of ${PROFILES.join(", ")}.`);
  const failOn = (options.failOn ?? config.failOn) as Severity | undefined;
  if (failOn && !SEVERITIES.includes(failOn)) throw new DeviceToolError(`--fail-on must be one of ${SEVERITIES.join(", ")}.`);
  const ignore = [...(config.ignore ?? []), ...(options.ignore ?? []).map((rule) => ({ rule }))];
  const pkg = options.package ?? config.package;
  return { profile, failOn, ignore, ...(pkg ? { package: pkg } : {}) };
}

export const failedAt = (results: AuditResult[], failOn: Severity | undefined) =>
  failOn ? results.some((r) => r.findings.some((f) => atLeast(f.severity, failOn))) : false;

export async function runAudit(options: AuditOptions, run: Exec = exec, version = "0.0.0") {
  const { profile, failOn, ignore, package: pkg } = await loadSettings(options);

  let captured: Captured[];
  let notes: string[] = [];
  if (options.from) {
    const dirs = snapshotDirs(resolve(options.cwd, options.from));
    if (dirs.length === 0) throw new DeviceToolError(`No snapshot found in ${options.from}. Point --from at a report folder or one of its ios/ or android/ folders.`);
    captured = await Promise.all(dirs.map(async (dir) => ({ snapshot: await loadSnapshot(dir), dir })));
  } else {
    ({ captured, notes } = await captureAll({ ...options, ...(pkg ? { package: pkg } : {}) }, run));
  }

  const results: AuditResult[] = captured.map(({ snapshot }) => audit(snapshot, { profile, ignore }));

  let reportPath: string | undefined;
  if (options.report) {
    const base = resolve(options.cwd, options.out ?? (options.from ? options.from : "a11y-report"));
    const dir = options.name && !options.from ? join(base, options.name) : base;
    await mkdir(dir, { recursive: true });
    const sections: ReportSection[] = [];
    for (const [i, { snapshot, raw, dir: from }] of captured.entries()) {
      if (raw) await saveSnapshot(join(dir, snapshot.platform), snapshot, raw);
      const png = raw?.screenshot ?? (from && snapshot.screenshot ? await readFile(join(from, "screenshot.png")) : undefined);
      sections.push({ result: results[i]!, screen: snapshot.screen, ...(snapshot.name ? { title: snapshot.name } : {}), ...(png ? { screenshot: png } : {}) });
    }
    await writeFile(join(dir, "report.json"), `${JSON.stringify({ version, results }, null, 2)}\n`);
    reportPath = join(dir, "report.html");
    await writeFile(reportPath, renderHtml(sections, { ...(options.name ? { title: options.name } : {}), version }));
  }

  return { results, notes, reportPath, failed: failedAt(results, failOn), failOn };
}

export async function auditCommand(options: AuditOptions, version: string) {
  const { results, notes, reportPath, failed, failOn } = await runAudit(options, exec, version);
  if (options.json) {
    console.log(JSON.stringify({ version, results, notes, ...(reportPath ? { report: reportPath } : {}) }, null, 2));
  } else {
    console.log(results.map(formatResult).join("\n\n"));
    for (const note of notes) console.log(pc.dim(`note: ${note}`));
    if (reportPath) {
      const shown = relative(process.cwd(), reportPath);
      console.log(`\nReport: ${shown.startsWith("..") ? reportPath : shown}`);
    }
    if (failed) console.log(pc.red(`\nFailed: found an issue rated ${failOn}${failOn === "critical" ? "" : " or worse"} (--fail-on ${failOn}).`));
  }
  if (failed) process.exitCode = 1;
}
