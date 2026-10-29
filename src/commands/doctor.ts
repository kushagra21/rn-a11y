import pc from "picocolors";
import { findAdb, listAndroidDevices } from "../devices/android.js";
import { DeviceToolError, ToolMissingError, exec, type Exec } from "../devices/exec.js";
import { TREE_TOOLS, listBootedSimulators } from "../devices/ios.js";

interface Line {
  ok: boolean | "warn";
  label: string;
  detail: string;
}

async function hasTool(run: Exec, name: string, args: string[]) {
  try {
    return (await run(name, args)).exitCode === 0;
  } catch (error) {
    if (error instanceof ToolMissingError) return false;
    throw error;
  }
}

export async function doctor(run: Exec = exec): Promise<Line[]> {
  const lines: Line[] = [];

  if (process.platform === "darwin") {
    try {
      const sims = await listBootedSimulators(run);
      lines.push({ ok: sims.length ? true : "warn", label: "iOS simulators", detail: sims.length ? sims.map((s) => `${s.name} (${s.detail})`).join(", ") : "none booted" });
    } catch (error) {
      if (!(error instanceof DeviceToolError)) throw error;
      lines.push({ ok: false, label: "Xcode", detail: error.message });
    }
    const found = [];
    for (const tool of TREE_TOOLS) if (await hasTool(run, tool.name, ["--help"])) found.push(tool.name);
    lines.push({
      ok: found.length > 0,
      label: "iOS accessibility tree",
      detail: found.length ? `using ${found[0]}` : `AXe or idb is needed. Install AXe: ${TREE_TOOLS[0].install}`,
    });
  } else {
    lines.push({ ok: "warn", label: "iOS", detail: "iOS simulators need macOS with Xcode" });
  }

  try {
    const { devices, unusable } = await listAndroidDevices(run, findAdb());
    lines.push({
      ok: devices.length ? true : "warn",
      label: "Android devices",
      detail: [devices.map((d) => `${d.name} (${d.detail})`).join(", ") || "none connected", ...unusable].join("; "),
    });
  } catch (error) {
    if (!(error instanceof DeviceToolError)) throw error;
    lines.push({ ok: false, label: "adb", detail: error.message });
  }
  return lines;
}

export async function doctorCommand() {
  for (const line of await doctor()) {
    const icon = line.ok === true ? pc.green("✔") : line.ok === "warn" ? pc.yellow("!") : pc.red("✖");
    console.log(`${icon} ${pc.bold(line.label)}: ${line.detail}`);
  }
}
