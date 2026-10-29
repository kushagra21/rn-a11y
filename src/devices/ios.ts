import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePng } from "../core/image.js";
import { extractJson, parseAxTree } from "../core/readers/ios.js";
import type { DeviceInfo } from "../core/types.js";
import { DeviceToolError, ToolMissingError, lastLine, type DeviceSession, type Exec } from "./exec.js";

/** `com.apple.CoreSimulator.SimRuntime.iOS-18-2` → `iOS 18.2` */
export function runtimeLabel(runtime: string): string {
  const name = runtime.replace(/^.*SimRuntime\./, "");
  const m = /^(\w+?)-(\d+)-(\d+)$/.exec(name);
  return m ? `${m[1]} ${m[2]}.${m[3]}` : name;
}

async function simctl(run: Exec, args: string[]) {
  try {
    return await run("xcrun", ["simctl", ...args]);
  } catch (error) {
    if (error instanceof ToolMissingError) throw new DeviceToolError("xcrun isn't available. Install Xcode from the App Store.");
    throw error;
  }
}

export async function listBootedSimulators(run: Exec, hostPlatform: NodeJS.Platform = process.platform): Promise<DeviceInfo[]> {
  if (hostPlatform !== "darwin") throw new DeviceToolError("iOS simulators need macOS with Xcode.");
  const result = await simctl(run, ["list", "devices", "booted", "--json"]);
  if (result.exitCode !== 0) {
    const missing = /unable to find utility "simctl"|xcode-select/i.test(result.stderr);
    throw new DeviceToolError(
      missing
        ? "simctl isn't available, usually because the command line tools point at CommandLineTools instead of Xcode. Run: sudo xcode-select -s /Applications/Xcode.app"
        : `simctl failed: ${lastLine(result.stderr)}`,
    );
  }
  const json = JSON.parse(result.stdout) as { devices?: Record<string, { udid: string; name: string; state: string }[]> };
  return Object.entries(json.devices ?? {})
    .filter(([runtime]) => /iOS/.test(runtime))
    .flatMap(([runtime, devices]) =>
      devices.filter((d) => d.state === "Booted").map((d) => ({ platform: "ios" as const, id: d.udid, name: d.name, detail: runtimeLabel(runtime) })),
    );
}

/** Tools that read a simulator's accessibility tree, in the order they're tried. */
export const TREE_TOOLS = [
  { name: "axe", args: (udid: string) => ["describe-ui", "--udid", udid], install: "brew install cameroncooke/axe/axe" },
  { name: "idb", args: (udid: string) => ["ui", "describe-all", "--udid", udid, "--json", "--nested"], install: "brew install facebook/fb/idb-companion && pipx install fb-idb" },
] as const;

export const NO_TREE_TOOL = `Reading the iOS accessibility tree needs AXe or idb. Install AXe with: ${TREE_TOOLS[0].install}`;

async function describeUi(run: Exec, udid: string): Promise<{ tool: string; output: string }> {
  for (const tool of TREE_TOOLS) {
    let result;
    try {
      result = await run(tool.name, tool.args(udid));
      // Right after a simulator boots, AXe's first connection can time out; the next one works.
      if (result.exitCode !== 0 && /timed out/i.test(result.stderr + result.stdout)) result = await run(tool.name, tool.args(udid));
    } catch (error) {
      if (error instanceof ToolMissingError) continue;
      throw error;
    }
    if (result.exitCode !== 0) throw new DeviceToolError(`${tool.name} couldn't read the accessibility tree: ${lastLine(result.stderr || result.stdout)}`);
    return { tool: tool.name, output: result.stdout };
  }
  throw new DeviceToolError(NO_TREE_TOOL);
}

export function iosSession(run: Exec, device: DeviceInfo, options: { tmpDir: string }): DeviceSession {
  return {
    device,
    async readTree() {
      const { output } = await describeUi(run, device.id);
      const root = parseAxTree(extractJson(output));
      if (root.frame.width <= 0) throw new DeviceToolError("The accessibility tree has no screen size. Is an app open on the simulator?");
      return { root, raw: output };
    },
    async snapshot({ root, raw }, { screenshot: wanted }) {
      let screenshot: Buffer | undefined;
      if (wanted) {
        const local = join(options.tmpDir, "ios-screenshot.png");
        const shot = await simctl(run, ["io", device.id, "screenshot", "--type=png", local]);
        if (shot.exitCode === 0) screenshot = await readFile(local);
      }
      const image = screenshot ? decodePng(screenshot) : undefined;
      return {
        snapshot: {
          platform: "ios",
          device,
          ...(root.label ? { app: root.label } : {}),
          screen: { width: root.frame.width, height: root.frame.height },
          scale: image ? image.width / root.frame.width : 1,
          capturedAt: new Date().toISOString(),
          root,
          ...(image ? { screenshot: image } : {}),
        },
        raw: { tree: raw, ...(screenshot ? { screenshot } : {}) },
      };
    },
  };
}
