import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePng } from "../core/image.js";
import { extractJson, parseAxTree } from "../core/readers/ios.js";
import { walk } from "../core/tree.js";
import type { A11yNode, DeviceInfo } from "../core/types.js";
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

/** iOS asks "Open in “App”?" before a custom-scheme link opens an app; this finds its Open button. */
export function findOpenPrompt(root: A11yNode): A11yNode | undefined {
  const nodes = [...walk(root)].map(({ node }) => node);
  // The prompt's buttons aren't inside its sheet in the tree, so look for them anywhere.
  if (!nodes.some((n) => /^Open in “.+”\?$/.test(n.label))) return undefined;
  return nodes.find((n) => n.kind === "button" && n.label === "Open");
}

/** Taps a point with whichever tree tool is installed. */
async function tapAt(run: Exec, udid: string, tool: string, x: number, y: number) {
  const [px, py] = [String(Math.round(x)), String(Math.round(y))];
  const result = tool === "axe" ? await run("axe", ["tap", "-x", px, "-y", py, "--udid", udid]) : await run("idb", ["ui", "tap", px, py, "--udid", udid]);
  if (result.exitCode !== 0) throw new DeviceToolError(`Couldn't tap Open on iOS's "Open in app?" prompt: ${lastLine(result.stderr || result.stdout)}`);
}

const PROMPT_CHECKS = 12;
const PROMPT_POLL = 300;

export function iosSession(
  run: Exec,
  device: DeviceInfo,
  options: { tmpDir: string; sleep?: (ms: number) => Promise<void> },
): DeviceSession {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  return {
    device,
    async openUrl(url) {
      const result = await simctl(run, ["openurl", device.id, url]);
      if (result.exitCode === 0) {
        // Confirm iOS's "Open in “App”?" prompt until an app is in front. Prompts queue up,
        // one per link opened, so there may be more than one.
        for (let i = 0; i < PROMPT_CHECKS; i++) {
          const { tool, output } = await describeUi(run, device.id);
          const root = parseAxTree(extractJson(output));
          const open = findOpenPrompt(root);
          if (open) await tapAt(run, device.id, tool, open.frame.x + open.frame.width / 2, open.frame.y + open.frame.height / 2);
          else if (root.label.trim()) return;
          await sleep(PROMPT_POLL);
        }
        return;
      }
      // -10814 is kLSApplicationNotFoundErr: no installed app registers this scheme.
      if (/-10814|LSApplicationWorkspaceErrorDomain/.test(result.stderr)) {
        throw new DeviceToolError(`No app on ${device.name} handles ${new URL(url).protocol}// links. Check the scheme with rn-deeplink scan.`);
      }
      throw new DeviceToolError(`simctl couldn't open ${url}: ${lastLine(result.stderr)}`);
    },
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
