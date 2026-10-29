import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodePng } from "../core/image.js";
import { parseDensity, parseUiAutomator } from "../core/readers/android.js";
import type { DeviceInfo, Snapshot } from "../core/types.js";
import { DeviceToolError, ToolMissingError, lastLine, type Exec } from "./exec.js";

/** adb from ANDROID_HOME / ANDROID_SDK_ROOT, the default SDK locations, then PATH. */
export function findAdb(env = process.env, home = homedir()): string {
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  const sdks = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    join(home, "Library", "Android", "sdk"),
    join(home, "Android", "Sdk"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Android", "Sdk"),
  ];
  return sdks.map((sdk) => sdk && join(sdk, "platform-tools", exe)).find((path): path is string => !!path && existsSync(path)) ?? "adb";
}

async function adb(run: Exec, adbPath: string, args: string[]) {
  try {
    return await run(adbPath, args);
  } catch (error) {
    if (error instanceof ToolMissingError) {
      throw new DeviceToolError("adb isn't installed. Install Android Studio (or the SDK Platform-Tools), or set ANDROID_HOME to your SDK.");
    }
    throw error;
  }
}

export async function listAndroidDevices(run: Exec, adbPath: string): Promise<{ devices: DeviceInfo[]; unusable: string[] }> {
  const result = await adb(run, adbPath, ["devices", "-l"]);
  if (result.exitCode !== 0) throw new DeviceToolError(`adb failed: ${lastLine(result.stderr)}`);
  const devices: DeviceInfo[] = [];
  const unusable: string[] = [];
  for (const line of result.stdout.split("\n").slice(1)) {
    const m = /^(\S+)\s+(\S+)(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, id, state, props] = m as unknown as [string, string, string, string];
    if (state !== "device") {
      const why = state === "unauthorized" ? "accept the USB debugging prompt on the device" : `it is ${state}`;
      unusable.push(`${id} can't be used: ${why}.`);
      continue;
    }
    const model = /\bmodel:(\S+)/.exec(props)?.[1]?.replaceAll("_", " ");
    devices.push({ platform: "android", id, name: model ?? id, detail: id.startsWith("emulator-") ? "emulator" : "device" });
  }
  return { devices, unusable };
}

const REMOTE_XML = "/data/local/tmp/rn-a11y.xml";
const REMOTE_PNG = "/data/local/tmp/rn-a11y.png";

export interface AndroidCapture {
  snapshot: Snapshot;
  raw: { tree: string; screenshot?: Buffer };
}

export async function captureAndroid(
  run: Exec,
  adbPath: string,
  device: DeviceInfo,
  options: { package?: string; tmpDir: string; screenshot?: boolean },
): Promise<AndroidCapture> {
  const shell = (...args: string[]) => adb(run, adbPath, ["-s", device.id, "shell", ...args]);

  const dump = await shell("uiautomator", "dump", REMOTE_XML);
  const dumpOutput = `${dump.stdout}\n${dump.stderr}`;
  if (/could not get idle state/i.test(dumpOutput)) {
    throw new DeviceToolError(
      "uiautomator couldn't read the screen because the app never stops animating (a spinner, Lottie or looping animation). Stop the animation, or turn off animations in Developer options, then try again.",
    );
  }
  if (dump.exitCode !== 0 || /ERROR/i.test(dumpOutput)) throw new DeviceToolError(`uiautomator dump failed: ${lastLine(dumpOutput)}`);
  // Take the screenshot right after the dump so they show the same moment.
  let screenshot: Buffer | undefined;
  if (options.screenshot !== false) {
    const cap = await shell("screencap", "-p", REMOTE_PNG);
    const local = join(options.tmpDir, "android-screenshot.png");
    const pull = cap.exitCode === 0 ? await adb(run, adbPath, ["-s", device.id, "pull", REMOTE_PNG, local]) : cap;
    if (pull.exitCode === 0) screenshot = await readFile(local);
  }
  const xml = await adb(run, adbPath, ["-s", device.id, "exec-out", "cat", REMOTE_XML]);
  if (xml.exitCode !== 0 || !xml.stdout.includes("<hierarchy")) throw new DeviceToolError(`Couldn't read the uiautomator dump: ${lastLine(xml.stderr)}`);
  const density = parseDensity((await shell("wm", "density")).stdout) ?? 160;

  const dpScale = density / 160;
  const root = parseUiAutomator(xml.stdout, { dpScale, ...(options.package ? { package: options.package } : {}) });
  const image = screenshot ? decodePng(screenshot) : undefined;
  const app = options.package ?? root.children.map((c) => c.package).find(Boolean);
  return {
    snapshot: {
      platform: "android",
      device,
      ...(app ? { app } : {}),
      screen: image ? { width: image.width / dpScale, height: image.height / dpScale } : { width: root.frame.width, height: root.frame.height },
      scale: dpScale,
      capturedAt: new Date().toISOString(),
      root,
      ...(image ? { screenshot: image } : {}),
    },
    raw: { tree: xml.stdout, ...(screenshot ? { screenshot } : {}) },
  };
}
