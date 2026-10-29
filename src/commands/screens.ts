import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { audit, type Ignore } from "../core/audit.js";
import { screenName, slug } from "../core/screens.js";
import { saveSnapshot } from "../core/store.js";
import type { A11yNode, AuditResult, Platform, ProfileName, Snapshot } from "../core/types.js";
import { DeviceToolError, type DeviceSession, type Exec } from "../devices/exec.js";
import { renderHtml, type ReportSection } from "../report/html.js";
import { openSession } from "./audit.js";

/** A screen audited by watch or --links, saved under <out>/screens/<nn-name>/<platform>. */
export interface AuditedScreen {
  name: string;
  platform: Platform;
  dir: string;
  result: AuditResult;
  section: ReportSection;
}

/** Opens a session on each requested platform; with "both", platforms without a device are skipped. */
export async function openSessions(
  run: Exec,
  options: { platform: "ios" | "android" | "both"; device?: string; package?: string; tmpDir: string },
): Promise<{ sessions: DeviceSession[]; notes: string[] }> {
  const platforms: Platform[] = options.platform === "both" ? ["ios", "android"] : [options.platform];
  const sessions: DeviceSession[] = [];
  const notes: string[] = [];
  const skipped: string[] = [];
  for (const platform of platforms) {
    if (platform === "ios" && options.platform === "both" && process.platform !== "darwin") continue;
    try {
      const opened = await openSession(run, platform, {
        tmpDir: options.tmpDir,
        ...(options.device ? { device: options.device } : {}),
        ...(options.package ? { package: options.package } : {}),
      });
      sessions.push(opened.session);
      notes.push(...opened.notes);
    } catch (error) {
      if (options.platform !== "both" || !(error instanceof DeviceToolError)) throw error;
      skipped.push(`${platform === "ios" ? "iOS" : "Android"}: ${error.message}`);
    }
  }
  if (sessions.length === 0) throw new DeviceToolError(`No device to audit.\n  ${skipped.join("\n  ")}`);
  return { sessions, notes };
}

/** Each run replaces the last one's screens, which this tool wrote. */
export const clearScreens = (out: string) => rm(join(out, "screens"), { recursive: true, force: true });

/** Two different screens can share a heading ("Settings"); number the later ones. */
function uniqueName(name: string, screens: AuditedScreen[]) {
  const taken = new Set(screens.map((s) => s.name));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} (${n})`)) n++;
  return `${name} (${n})`;
}

/** Screenshots, audits and saves a screen whose tree was just read. */
export async function recordScreen(
  session: DeviceSession,
  tree: { root: A11yNode; raw: string },
  context: {
    out: string;
    screens: AuditedScreen[];
    screenshot: boolean;
    profile: ProfileName;
    ignore: Ignore[];
    /** Name to use instead of the screen's heading, e.g. the link's name. */
    name?: string;
    url?: string;
  },
): Promise<AuditedScreen> {
  const { snapshot, raw } = await session.snapshot(tree, { screenshot: context.screenshot });
  const index = context.screens.length + 1;
  const name = uniqueName(context.name ?? screenName(snapshot.root, snapshot.screen) ?? `Screen ${index}`, context.screens);
  const named: Snapshot = { ...snapshot, name, ...(context.url ? { url: context.url } : {}) };
  const result = audit(named, { profile: context.profile, ignore: context.ignore });
  const dir = join(context.out, "screens", `${String(index).padStart(2, "0")}-${slug(name)}`);
  await saveSnapshot(join(dir, snapshot.platform), named, raw);
  const screen: AuditedScreen = {
    name,
    platform: snapshot.platform,
    dir,
    result,
    section: { result, title: name, screen: named.screen, ...(raw.screenshot ? { screenshot: raw.screenshot } : {}) },
  };
  context.screens.push(screen);
  return screen;
}

export async function writeScreensReport(out: string, screens: AuditedScreen[], version: string, title?: string) {
  await mkdir(out, { recursive: true });
  const results = screens.map((s) => s.result);
  await writeFile(join(out, "report.json"), `${JSON.stringify({ version, results }, null, 2)}\n`);
  await writeFile(join(out, "report.html"), renderHtml(screens.map((s) => s.section), { ...(title ? { title } : {}), version }));
}
