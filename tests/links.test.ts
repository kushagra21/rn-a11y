import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLinks, parseLinks, runLinkAudit, type LinkAuditOptions, type LinkEvent } from "../src/commands/links.js";
import { DeviceToolError, type Exec, type ExecResult } from "../src/devices/exec.js";
import { androidScreenshot, fixture, iosScreenshot } from "./helpers.js";

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });

describe("iOS Open in app prompt", () => {
  it("finds the Open button in the real prompt", async () => {
    const { parseAxTree, extractJson } = await import("../src/core/readers/ios.js");
    const { findOpenPrompt } = await import("../src/devices/ios.js");
    const root = parseAxTree(extractJson(fixture("ios-open-prompt.json")));
    expect(root.label.trim()).toBe("");
    const open = findOpenPrompt(root)!;
    expect(open.label).toBe("Open");
    expect(findOpenPrompt(parseAxTree(extractJson(fixture("ios-checkout.json"))))).toBeUndefined();
  });
});

describe("reading links", () => {
  it("reads rn-deeplink's .deeplinks.json shapes", () => {
    const file = JSON.stringify({
      android: { sha256: [] },
      links: ["myapp://home", { name: "Cart", url: "myapp://cart" }, { url: "https://shop.example.com/p/1", platform: "android" }],
    });
    expect(parseLinks(file, ".deeplinks.json")).toEqual([
      { url: "myapp://home" },
      { name: "Cart", url: "myapp://cart" },
      { url: "https://shop.example.com/p/1", platform: "android" },
    ]);
    expect(parseLinks('["myapp://a"]', "x.json")).toEqual([{ url: "myapp://a" }]);
  });

  it("reads one URL per line, skipping comments", () => {
    expect(parseLinks("# screens\nmyapp://home\n\nmyapp://cart\n", "links.txt")).toEqual([{ url: "myapp://home" }, { url: "myapp://cart" }]);
  });

  it("explains bad entries", () => {
    expect(() => parseLinks('{"links":[{"name":"x"}]}', "f.json")).toThrow(/entry 1 needs a "url"/);
    expect(() => parseLinks('{"links":[{"url":"myapp://a","platform":"web"}]}', "f.json")).toThrow(/"platform" must be/);
    expect(() => parseLinks("home\n", "links.txt")).toThrow(/line 1: "home" isn't a URL/);
    expect(() => parseLinks('{"other":1}', "f.json")).toThrow(/must look like/);
  });

  it("points to rn-deeplink when there's no links file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rn-a11y-links-"));
    try {
      await expect(loadLinks(dir, true)).rejects.toThrow(/rn-deeplink links add/);
      await expect(loadLinks(dir, undefined, [])).rejects.toThrow(/No links to audit/);
      expect(await loadLinks(dir, undefined, ["myapp://x"])).toEqual([{ url: "myapp://x" }]);
      await expect(loadLinks(dir, undefined, ["nope"])).rejects.toBeInstanceOf(DeviceToolError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const shifted = (json: string, dy: number) => json.replace(/"y": (\d+)/g, (_, y) => `"y": ${Number(y) + dy}`);

/**
 * A simulator whose app shows one screen per link. Navigating takes `lag` reads: the
 * old screen first, then a moving one, then the new screen.
 */
function fakeSimulator(screens: Record<string, string>, lag = 0, prompt?: "confirm" | "late"): Exec & { opened: string[]; taps: string[][] } {
  let current = fixture("ios-checkout.json");
  let pending: string[] = [];
  let showingPrompt = false;
  let late = 0;
  const run = (async (file: string, args: string[]) => {
    if (file === "xcrun" && args[1] === "list") {
      return ok(JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: "SIM", name: "iPhone 17", state: "Booted" }] } }));
    }
    if (file === "xcrun" && args[1] === "openurl") {
      const url = args[3]!;
      run.opened.push(url);
      const next = screens[url];
      if (!next) return { stdout: "", stderr: "LSApplicationWorkspaceErrorDomain error -10814", exitCode: 1 };
      pending = [...Array(lag).fill(current), ...(lag ? [shifted(next, 50)] : []), next];
      // "confirm": iOS asks first and waits for a tap. "late": the system tree shows for a moment, by itself.
      if (prompt === "confirm") showingPrompt = true;
      if (prompt === "late") late = 3;
      return ok();
    }
    if (file === "axe" && args[0] === "tap") {
      run.taps.push(args);
      showingPrompt = false;
      return ok();
    }
    if (file === "xcrun" && args[1] === "io") {
      writeFileSync(args.at(-1)!, iosScreenshot());
      return ok();
    }
    if (file === "axe") {
      if (showingPrompt) return ok(fixture("ios-open-prompt.json"));
      if (late > 0) {
        late--;
        // The first check after opening still sees the app; then the system takes over briefly.
        if (late < 2) return ok(fixture("ios-open-prompt.json"));
      }
      if (pending.length) current = pending.shift()!;
      return ok(current);
    }
    return { stdout: "", stderr: `unexpected ${file} ${args.join(" ")}`, exitCode: 1 };
  }) as Exec & { opened: string[]; taps: string[][] };
  run.opened = [];
  run.taps = [];
  return run;
}

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "rn-a11y-links-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const options = (extra: Partial<LinkAuditOptions> = {}): LinkAuditOptions => ({ cwd, platform: "ios", report: true, screenshot: true, wait: 10000, ...extra });
const noSleep = async () => {};

describe.runIf(process.platform === "darwin")("audit --links", () => {
  const screens = { "myapp://checkout": fixture("ios-checkout.json"), "myapp://order/1": fixture("ios-order-placed.json") };

  it("opens each link, waits for the screen, and audits it under the link's name", async () => {
    writeFileSync(join(cwd, ".deeplinks.json"), JSON.stringify({ links: [{ name: "Order", url: "myapp://order/1" }, "myapp://checkout"] }));
    const run = fakeSimulator(screens, 2);
    const events: LinkEvent[] = [];
    const { screens: audited, errors, reportPath } = await runLinkAudit(options({ links: true }), run, "0.2.0", { sleep: noSleep, onEvent: (e) => events.push(e) });
    expect(run.opened).toEqual(["myapp://order/1", "myapp://checkout"]);
    expect(errors).toEqual([]);
    expect(audited.map((s) => [s.name, s.result.url])).toEqual([
      ["Order", "myapp://order/1"],
      ["Checkout", "myapp://checkout"],
    ]);
    // Audited after navigating, not the screen that was showing before the link opened.
    expect(audited[0]!.result.findings.map((f) => f.node.testID)).toEqual(["share"]);
    expect(reportPath).toBe(join(cwd, "a11y-report", "links", "report.html"));
    expect(readFileSync(reportPath!, "utf8")).toContain("<code>myapp://order/1</code>");
  });

  it("taps Open on iOS's Open in app prompt", async () => {
    const run = fakeSimulator(screens, 1, "confirm");
    const { screens: audited } = await runLinkAudit(options({ url: ["myapp://order/1"] }), run, "0", { sleep: noSleep });
    expect(run.taps).toEqual([["tap", "-x", "275", "-y", "474", "--udid", "SIM"]]);
    expect(audited.map((s) => [s.name, s.result.findings.length])).toEqual([["Order placed", 1]]);
  });

  it("never audits the system's tree in place of the app's", async () => {
    const run = fakeSimulator(screens, 0, "late");
    const { screens: audited } = await runLinkAudit(options({ url: ["myapp://order/1"] }), run, "0", { sleep: noSleep });
    expect(audited.map((s) => s.result.app)).toEqual(["Shop"]);
    expect(audited[0]!.name).toBe("Order placed");
  });

  it("records a link no app handles and carries on", async () => {
    const run = fakeSimulator(screens);
    const { screens: audited, errors } = await runLinkAudit(options({ url: ["myapp://missing", "myapp://order/1"] }), run, "0", { sleep: noSleep });
    expect(errors.map((e) => [e.link.url, e.message])).toEqual([["myapp://missing", expect.stringMatching(/No app on iPhone 17 handles myapp:\/\/ links/)]]);
    expect(audited.map((s) => s.name)).toEqual(["Order placed"]);
  });

  it("skips links meant for the other platform", async () => {
    writeFileSync(join(cwd, "links.json"), JSON.stringify([{ url: "myapp://order/1", platform: "android" }, "myapp://checkout"]));
    const run = fakeSimulator(screens);
    await runLinkAudit(options({ links: "links.json", report: false }), run, "0", { sleep: noSleep });
    expect(run.opened).toEqual(["myapp://checkout"]);
  });

  it("accepts a link that stays on the current screen once the wait for a change is over", async () => {
    const run = fakeSimulator({ "myapp://checkout": fixture("ios-checkout.json") });
    const { screens: audited } = await runLinkAudit(options({ url: ["myapp://checkout", "myapp://checkout"] }), run, "0", { sleep: noSleep });
    expect(audited.map((s) => s.name)).toEqual(["Checkout", "Checkout (2)"]);
  });

  it("fails at the --fail-on threshold", async () => {
    const { failed } = await runLinkAudit(options({ url: ["myapp://order/1"], failOn: "critical" }), fakeSimulator(screens), "0", { sleep: noSleep });
    expect(failed).toBe(true);
  });
});

describe("audit --links on Android", () => {
  it("opens links with an intent, sent straight to the package when it's known", async () => {
    const calls: string[][] = [];
    const run: Exec = async (file, args) => {
      calls.push(args);
      if (args[0] === "devices") return ok("List of devices attached\nemulator-5554 device model:Pixel_9\n");
      if (args.includes("am")) return args.includes("'myapp://nope'") ? ok("Error: Activity not started, unable to resolve Intent") : ok("Status: ok");
      if (args.includes("uiautomator")) return ok("dumped");
      if (args.includes("cat")) return ok(fixture("android-checkout.xml"));
      if (args.includes("density")) return ok("Physical density: 420");
      if (args.includes("screencap")) return ok();
      if (args.includes("pull")) {
        writeFileSync(args.at(-1)!, androidScreenshot());
        return ok();
      }
      return { stdout: "", stderr: `unexpected ${file}`, exitCode: 1 };
    };
    const { screens, errors } = await runLinkAudit(options({ platform: "android", package: "com.example.shop", url: ["myapp://cart?id=1&x=2", "myapp://nope"] }), run, "0", { sleep: noSleep });
    expect(screens.map((s) => s.platform)).toEqual(["android"]);
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/No app on Pixel 9 handles myapp:\/\/nope/)]);
    const open = calls.find((a) => a.includes("am"))!;
    expect(open.slice(-2)).toEqual(["'myapp://cart?id=1&x=2'", "com.example.shop"]);
  });
});
