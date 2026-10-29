import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAudit } from "../src/commands/audit.js";
import { runWatch, type WatchEvent, type WatchOptions } from "../src/commands/watch.js";
import { extractJson, parseAxTree } from "../src/core/readers/ios.js";
import { SAME_SCREEN, layoutKey, screenName, signature, similarity, slug } from "../src/core/screens.js";
import type { Exec, ExecResult } from "../src/devices/exec.js";
import { androidScreenshot, fixture, iosScreenshot } from "./helpers.js";

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
const screen = { width: 402, height: 874 };
const tree = (name: string) => parseAxTree(extractJson(fixture(name)));

/** The same tree with every element moved down, as in the middle of a transition. */
const shifted = (json: string, dy: number) => json.replace(/"y": (\d+)/g, (_, y) => `"y": ${Number(y) + dy}`);

describe("screen fingerprints", () => {
  const checkout = tree("ios-checkout.json");
  const placed = tree("ios-order-placed.json");

  it("tells screens apart and ignores changing numbers", () => {
    expect(similarity(signature(checkout, screen), signature(placed, screen))).toBeLessThan(SAME_SCREEN);
    const later = parseAxTree(extractJson(fixture("ios-order-placed.json").replace("#10234", "#10299")));
    expect(similarity(signature(placed, screen), signature(later, screen))).toBe(1);
  });

  it("sees movement in the layout key but not in the signature", () => {
    const moved = parseAxTree(extractJson(shifted(fixture("ios-order-placed.json"), 40)));
    expect(layoutKey(moved, screen)).not.toBe(layoutKey(placed, screen));
    expect(similarity(signature(moved, screen), signature(placed, screen))).toBe(1);
  });

  it("names a screen by its heading, else its biggest text near the top", () => {
    expect(screenName(placed, screen)).toBe("Order placed");
    expect(screenName(checkout, screen)).toBe("Checkout");
    expect(slug("Order placed!")).toBe("order-placed");
    expect(slug("✓")).toBe("screen");
  });
});

/** A simulator whose screen follows a script, one entry per tree read; the last one repeats. */
function scriptedIos(script: string[]): Exec & { reads: number } {
  const run = (async (file: string, args: string[]) => {
    if (file === "xcrun" && args[1] === "list") {
      return ok(JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: "SIM", name: "iPhone 17", state: "Booted" }] } }));
    }
    if (file === "xcrun" && args[1] === "io") {
      writeFileSync(args.at(-1)!, iosScreenshot());
      return ok();
    }
    if (file === "axe") {
      const step = script[Math.min(run.reads, script.length - 1)]!;
      run.reads++;
      return step === "fail" ? { stdout: "", stderr: "Error: no app in the foreground", exitCode: 1 } : ok(step);
    }
    return { stdout: "", stderr: `unexpected ${file} ${args.join(" ")}`, exitCode: 1 };
  }) as Exec & { reads: number };
  run.reads = 0;
  return run;
}

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "rn-a11y-watch-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const options = (extra: Partial<WatchOptions> = {}): WatchOptions => ({ cwd, platform: "ios", screenshot: true, interval: 0, ...extra });

/** Runs watch until the script has been read through `rounds` times. */
async function watch(run: Exec & { reads: number }, rounds: number, extra: Partial<WatchOptions> = {}) {
  const controller = new AbortController();
  const events: WatchEvent[] = [];
  const result = await runWatch(options(extra), run, "0.2.0", {
    signal: controller.signal,
    onEvent: (e) => events.push(e),
    sleep: async () => {
      if (run.reads >= rounds) controller.abort();
    },
  });
  return { ...result, events };
}

describe.runIf(process.platform === "darwin")("watch", () => {
  const checkout = fixture("ios-checkout.json");
  const placed = fixture("ios-order-placed.json");

  it("audits each screen once it settles, and doesn't repeat a screen", async () => {
    const run = scriptedIos([checkout, checkout, checkout, shifted(placed, 300), placed, placed, checkout, checkout, placed, placed]);
    const { screens, events } = await watch(run, 12);
    expect(screens.map((s) => s.name)).toEqual(["Checkout", "Order placed"]);
    expect(events.filter((e) => e.type === "screen")).toHaveLength(2);
    expect(screens[1]!.result.findings.map((f) => [f.rule, f.node.testID])).toEqual([["control-name", "share"]]);
  });

  it("writes one report with a section per screen, which --from can re-audit", async () => {
    const run = scriptedIos([checkout, checkout, placed, placed]);
    const { reportPath } = await watch(run, 6);
    expect(reportPath).toBe(join(cwd, "a11y-report", "watch", "report.html"));
    for (const dir of ["01-checkout/ios", "02-order-placed/ios"]) {
      expect(existsSync(join(cwd, "a11y-report", "watch", "screens", dir, "snapshot.json")), dir).toBe(true);
    }
    const html = readFileSync(reportPath!, "utf8");
    expect(html).toContain("2 screens");
    expect(html).toContain('href="#s1"');

    const again = await runAudit({ cwd, platform: "both", from: "a11y-report/watch", report: false, screenshot: true }, scriptedIos([]), "0.2.0");
    expect(again.results.map((r) => r.name)).toEqual(["Checkout", "Order placed"]);
  });

  it("waits out a transition instead of auditing it", async () => {
    // Every read differs until the last two, so only the final screen is audited.
    const run = scriptedIos([shifted(placed, 30), shifted(placed, 20), shifted(placed, 10), placed, placed]);
    const { screens } = await watch(run, 7);
    expect(screens).toHaveLength(1);
    expect(screens[0]!.result.findings[0]!.node.frame.y).toBe(70);
  });

  it("reports a read failure once and keeps going", async () => {
    const run = scriptedIos(["fail", "fail", "fail", placed, placed]);
    const { screens, events } = await watch(run, 7);
    expect(events.filter((e) => e.type === "skipped")).toHaveLength(1);
    expect(screens.map((s) => s.name)).toEqual(["Order placed"]);
  });

  it("starts from a clean screens folder", async () => {
    await watch(scriptedIos([checkout, checkout, placed, placed]), 6);
    await watch(scriptedIos([placed, placed]), 4);
    const again = await runAudit({ cwd, platform: "both", from: "a11y-report/watch", report: false, screenshot: true }, scriptedIos([]), "0");
    expect(again.results.map((r) => r.name)).toEqual(["Order placed"]);
  });

  it("fails at the --fail-on threshold", async () => {
    expect((await watch(scriptedIos([placed, placed]), 4, { failOn: "critical" })).failed).toBe(true);
    expect((await watch(scriptedIos([placed, placed]), 4, { failOn: "critical", ignore: ["control-name"] })).failed).toBe(false);
  });
});

describe("watch on Android", () => {
  it("skips moments when uiautomator can't read an animating screen", async () => {
    let dumps = 0;
    const run = (async (file: string, args: string[]) => {
      if (args[0] === "devices") return ok("List of devices attached\nemulator-5554 device model:Pixel_9\n");
      if (args.includes("uiautomator")) return ++dumps <= 2 ? { stdout: "", stderr: "ERROR: could not get idle state.", exitCode: 1 } : ok("dumped");
      if (args.includes("cat")) return ok(fixture("android-checkout.xml"));
      if (args.includes("density")) return ok("Physical density: 420");
      if (args.includes("screencap")) return ok();
      if (args.includes("pull")) {
        writeFileSync(args.at(-1)!, androidScreenshot());
        return ok();
      }
      return { stdout: "", stderr: `unexpected ${file}`, exitCode: 1 };
    }) as Exec & { reads: number };
    Object.defineProperty(run, "reads", { get: () => dumps });
    const { screens, events } = await watch(run, 6, { platform: "android" });
    expect(events.filter((e) => e.type === "skipped")).toHaveLength(0);
    expect(screens.map((s) => [s.name, s.platform])).toEqual([["Checkout", "android"]]);
  });
});
