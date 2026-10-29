import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAudit, type AuditOptions } from "../src/commands/audit.js";
import { doctor } from "../src/commands/doctor.js";
import { ToolMissingError, type Exec, type ExecResult } from "../src/devices/exec.js";
import { androidScreenshot, fixture, iosScreenshot } from "./helpers.js";

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });

const SIMS = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: "SIM-1", name: "iPhone 18 Pro", state: "Booted" }],
    "com.apple.CoreSimulator.SimRuntime.watchOS-27-0": [{ udid: "WATCH", name: "Apple Watch", state: "Booted" }],
  },
});

/** A fake machine with a booted simulator (and AXe) and/or a running emulator. */
function fakeExec(machine: { ios?: boolean; android?: boolean; axe?: boolean; idleFails?: boolean } = {}): Exec & { calls: string[][] } {
  const { ios = true, android = true, axe = true } = machine;
  const calls: string[][] = [];
  const run = (async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (file === "xcrun") {
      if (args[1] === "list") return ok(ios ? SIMS : JSON.stringify({ devices: {} }));
      if (args[1] === "io") {
        writeFileSync(args.at(-1)!, iosScreenshot());
        return ok();
      }
    }
    if (file === "axe") {
      if (!axe) throw new ToolMissingError("axe");
      return ok(fixture("ios-checkout.json"));
    }
    if (file === "idb") throw new ToolMissingError("idb");
    if (file.endsWith("adb")) {
      if (!android) throw new ToolMissingError(file);
      if (args[0] === "devices") return ok("List of devices attached\nemulator-5554          device product:sdk model:Pixel_9 device:emu\n");
      if (args.includes("uiautomator")) return machine.idleFails ? { stdout: "", stderr: "ERROR: could not get idle state.", exitCode: 1 } : ok("UI hierchary dumped to: /data/local/tmp/rn-a11y.xml");
      if (args.includes("screencap")) return ok();
      if (args.includes("pull")) {
        writeFileSync(args.at(-1)!, androidScreenshot());
        return ok("1 file pulled");
      }
      if (args.includes("cat")) return ok(fixture("android-checkout.xml"));
      if (args.includes("density")) return ok("Physical density: 420\n");
    }
    return { stdout: "", stderr: `unexpected: ${file} ${args.join(" ")}`, exitCode: 1 };
  }) as Exec & { calls: string[][] };
  run.calls = calls;
  return run;
}

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "rn-a11y-test-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const options = (extra: Partial<AuditOptions> = {}): AuditOptions => ({ cwd, platform: "both", report: true, screenshot: true, ...extra });
const isMac = process.platform === "darwin";

describe("audit command", () => {
  it.runIf(isMac)("audits both platforms and writes the report and snapshots", async () => {
    const { results, reportPath, failed } = await runAudit(options(), fakeExec(), "0.1.0");
    expect(results.map((r) => r.platform)).toEqual(["ios", "android"]);
    expect(failed).toBe(false);
    expect(reportPath).toBe(join(cwd, "a11y-report", "report.html"));
    for (const file of ["report.html", "report.json", "ios/snapshot.json", "ios/raw.json", "ios/screenshot.png", "android/snapshot.json", "android/raw.xml", "android/screenshot.png"]) {
      expect(existsSync(join(cwd, "a11y-report", file)), file).toBe(true);
    }
    const html = readFileSync(reportPath!, "utf8");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("Text field has no label");
    expect(html).toContain("2.5.8");
  });

  it("uses only the platform asked for, and saves under --name", async () => {
    const run = fakeExec();
    const { results, reportPath } = await runAudit(options({ platform: "android", name: "checkout" }), run, "0.1.0");
    expect(results.map((r) => r.platform)).toEqual(["android"]);
    expect(reportPath).toBe(join(cwd, "a11y-report", "checkout", "report.html"));
    expect(run.calls.some(([f]) => f === "xcrun")).toBe(false);
  });

  it("re-audits a saved report with --from, without a device", async () => {
    await runAudit(options({ platform: "android" }), fakeExec(), "0.1.0");
    const offline = fakeExec({ ios: false, android: false });
    const { results } = await runAudit(options({ from: "a11y-report", profile: "platform" }), offline, "0.1.0");
    expect(offline.calls).toEqual([]);
    expect(results[0]!.profile).toBe("platform");
    expect(results[0]!.findings.some((f) => f.rule === "text-contrast")).toBe(true);
  });

  it("fails at the --fail-on threshold", async () => {
    expect((await runAudit(options({ platform: "android", failOn: "critical", report: false }), fakeExec(), "0")).failed).toBe(true);
    const ignoreAll = { platform: "android" as const, failOn: "serious", report: false, ignore: ["control-name", "input-name", "missing-role", "target-size", "text-contrast"] };
    expect((await runAudit(options(ignoreAll), fakeExec(), "0")).failed).toBe(false);
  });

  it("reads rn-a11y.config.json", async () => {
    writeFileSync(join(cwd, "rn-a11y.config.json"), JSON.stringify({ profile: "platform", ignore: [{ rule: "duplicate-name" }] }));
    const { results } = await runAudit(options({ platform: "android", report: false }), fakeExec(), "0");
    expect(results[0]!.profile).toBe("platform");
    expect(results[0]!.findings.some((f) => f.rule === "duplicate-name")).toBe(false);
  });

  it.runIf(isMac)("skips a missing platform with --platform both", async () => {
    const { results } = await runAudit(options({ report: false }), fakeExec({ android: false }), "0");
    expect(results.map((r) => r.platform)).toEqual(["ios"]);
  });

  it.runIf(isMac)("explains how to install a tree reader", async () => {
    await expect(runAudit(options({ platform: "ios", report: false }), fakeExec({ axe: false }), "0")).rejects.toThrow(/brew install cameroncooke\/axe\/axe/);
  });

  it("explains uiautomator's idle-state failure", async () => {
    await expect(runAudit(options({ platform: "android", report: false }), fakeExec({ idleFails: true }), "0")).rejects.toThrow(/never stops animating/);
  });

  it("says what's missing when nothing can be audited", async () => {
    await expect(runAudit(options({ report: false }), fakeExec({ ios: false, android: false }), "0")).rejects.toThrow(/Nothing to audit/);
  });
});

describe("doctor", () => {
  it("reports devices and tools", async () => {
    const lines = await doctor(fakeExec({ axe: true }));
    const android = lines.find((l) => l.label === "Android devices");
    expect(android).toMatchObject({ ok: true, detail: "Pixel 9 (emulator)" });
    if (isMac) expect(lines.find((l) => l.label === "iOS accessibility tree")).toMatchObject({ ok: true, detail: "using axe" });
  });
});
