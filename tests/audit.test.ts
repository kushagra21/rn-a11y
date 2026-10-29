import { describe, expect, it } from "vitest";
import { audit } from "../src/core/audit.js";
import { decodePng } from "../src/core/image.js";
import { parseUiAutomator } from "../src/core/readers/android.js";
import { extractJson, parseAxTree } from "../src/core/readers/ios.js";
import { walk } from "../src/core/tree.js";
import type { A11yNode, AuditResult, Snapshot } from "../src/core/types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { androidScreenshot, fixture, iosScreenshot } from "./helpers.js";

const androidSnapshot = (withScreenshot = true): Snapshot => {
  const dpScale = 420 / 160;
  return {
    platform: "android",
    device: { platform: "android", id: "emulator-5554", name: "Pixel 9", detail: "emulator" },
    app: "com.example.shop",
    screen: { width: 1080 / dpScale, height: 2400 / dpScale },
    scale: dpScale,
    capturedAt: "2026-10-29T10:00:00.000Z",
    root: parseUiAutomator(fixture("android-checkout.xml"), { dpScale }),
    ...(withScreenshot ? { screenshot: decodePng(androidScreenshot()) } : {}),
  };
};

const iosSnapshot = (): Snapshot => {
  const root = parseAxTree(extractJson(fixture("ios-checkout.json")));
  return {
    platform: "ios",
    device: { platform: "ios", id: "UDID", name: "iPhone 18 Pro", detail: "iOS 27.0" },
    app: "Shop",
    screen: { width: 402, height: 874 },
    scale: 3,
    capturedAt: "2026-10-29T10:00:00.000Z",
    root,
    screenshot: decodePng(iosScreenshot()),
  };
};

const by = (result: AuditResult, rule: string) => result.findings.filter((f) => f.rule === rule).map((f) => f.node.testID ?? f.node.name);

describe("audit on Android", () => {
  const result = audit(androidSnapshot());

  it("flags controls and fields with no name", () => {
    expect(by(result, "control-name")).toEqual(["close"]);
    expect(by(result, "input-name")).toEqual(["coupon-input"]);
    expect(result.findings.find((f) => f.rule === "control-name")!.severity).toBe("critical");
  });

  it("flags a meaningful-looking image, but not the icon inside a control", () => {
    expect(by(result, "image-name")).toEqual(["promo-banner"]);
  });

  it("flags a Pressable with no accessibilityRole", () => {
    expect(by(result, "missing-role")).toEqual(["place-order"]);
  });

  it("applies WCAG 2.5.8 with its spacing exception", () => {
    // favorite is 18dp and its 24dp circle reaches the close button.
    expect(by(result, "target-size")).toEqual(["favorite"]);
  });

  it("checks text contrast against the screenshot", () => {
    const contrast = result.findings.filter((f) => f.rule === "text-contrast");
    expect(contrast.map((f) => f.node.name)).toEqual(["Apply coupon"]);
    expect(contrast[0]).toMatchObject({ severity: "serious" });
    expect(contrast[0]!.message).toContain("2.54:1 (#9CA3AF on #FFFFFF)");
  });

  it("flags redundant and duplicate names", () => {
    expect(by(result, "redundant-role")).toEqual(["submit"]);
    expect(by(result, "duplicate-name")).toEqual(["edit-shipping", "edit-payment"]);
  });

  it("skips disabled, off-screen and system elements", () => {
    const ids = result.findings.map((f) => f.node.testID);
    expect(ids).not.toContain("disabled-tiny");
    expect(ids).not.toContain("below-fold");
    expect(result.findings.some((f) => f.node.className.includes("systemui"))).toBe(false);
  });

  it("sorts by severity, then position", () => {
    const severities = result.findings.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) => ["critical", "serious", "moderate", "minor"].indexOf(a) - ["critical", "serious", "moderate", "minor"].indexOf(b)));
  });

  it("adds the platform minimums only in the platform profile", () => {
    expect(by(result, "platform-target-size")).toEqual([]);
    const platform = audit(androidSnapshot(), { profile: "platform" });
    expect(by(platform, "platform-target-size")).toEqual(["close", "favorite"]);
    expect(platform.rules.map((r) => r.id)).toContain("platform-target-size");
  });

  it("honours ignores by rule, testID and name", () => {
    const filtered = audit(androidSnapshot(), {
      ignore: [{ rule: "duplicate-name" }, { rule: "control-name", testID: "close" }, { rule: "text-contrast", name: "apply coupon" }],
    });
    expect(by(filtered, "duplicate-name")).toEqual([]);
    expect(by(filtered, "control-name")).toEqual([]);
    expect(by(filtered, "text-contrast")).toEqual([]);
    expect(by(filtered, "input-name")).toEqual(["coupon-input"]);
  });

  it("notes when contrast couldn't be checked", () => {
    const noShot = audit(androidSnapshot(false));
    expect(by(noShot, "text-contrast")).toEqual([]);
    expect(noShot.notes).toContain("Contrast wasn't checked: no screenshot.");
  });
});

describe("audit on iOS", () => {
  const result = audit(iosSnapshot());

  it("flags an unlabeled button and a role-less, label-less element VoiceOver stops on", () => {
    expect(by(result, "control-name")).toEqual(["close"]);
    expect(by(result, "empty-stop")).toEqual(["cart"]);
    expect(by(result, "input-name")).toEqual(["coupon-input"]);
    expect(by(result, "image-name")).toEqual(["promo-banner"]);
  });

  it("leaves a role-less element with no name to empty-stop", () => {
    expect(by(result, "missing-role")).toEqual([]);
  });

  it("checks contrast of text and of buttons, whose text iOS folds in", () => {
    const contrast = result.findings.filter((f) => f.rule === "text-contrast");
    expect(contrast.map((f) => [f.node.name, f.severity, f.review ?? false])).toEqual([
      ["Apply coupon", "serious", false],
      ["Play video button", "moderate", true],
    ]);
  });

  it("measures targets in points", () => {
    expect(by(result, "target-size")).toEqual(["favorite"]);
    expect(result.findings.find((f) => f.rule === "target-size")!.message).toContain("20×20pt");
    expect(by(audit(iosSnapshot(), { profile: "platform" }), "platform-target-size")).toEqual(["close", "favorite"]);
  });

  it("flags 'button' in a button's label", () => {
    expect(by(result, "redundant-role")).toEqual(["play"]);
  });
});

describe("spacing exception", () => {
  const node = (id: string, x: number, y: number, size: number): A11yNode => ({
    id,
    kind: "button",
    className: "Button",
    label: id,
    text: "",
    testID: id,
    frame: { x, y, width: size, height: size },
    interactive: true,
    focusable: true,
    enabled: true,
    children: [],
  });
  const snapshot = (children: A11yNode[]): Snapshot => ({
    platform: "ios",
    device: { platform: "ios", id: "x", name: "x" },
    screen: { width: 400, height: 800 },
    scale: 1,
    capturedAt: "",
    root: { ...node("root", 0, 0, 0), id: "root", kind: "container", frame: { x: 0, y: 0, width: 400, height: 800 }, interactive: false, children },
  });

  it("passes a small target with room around it", () => {
    expect(by(audit(snapshot([node("a", 100, 100, 16), node("b", 200, 100, 16)])), "target-size")).toEqual([]);
  });

  it("fails two small targets whose circles overlap", () => {
    expect(by(audit(snapshot([node("a", 100, 100, 16), node("b", 120, 100, 16)])), "target-size")).toEqual(["a", "b"]);
  });

  it("passes when the circles just clear each other", () => {
    expect(by(audit(snapshot([node("a", 100, 100, 16), node("b", 124, 100, 16)])), "target-size")).toEqual([]);
  });

  it("doesn't judge a target cut off by the screen edge", () => {
    expect(by(audit(snapshot([node("a", 390, 100, 16), node("b", 380, 100, 16)])), "target-size")).toEqual([]);
  });
});

/** Captured with AXe 1.8 from a bare React Native 0.83.6 app (New Architecture) on an iOS 27 simulator. */
describe("real capture: React Native 0.83.6 on iOS", () => {
  const root = parseAxTree(extractJson(fixture("ios-rn083-checkout.json")));
  const snapshot: Snapshot = {
    platform: "ios",
    device: { platform: "ios", id: "sim", name: "iPhone 17", detail: "iOS 27.0" },
    app: "A11yTestApp",
    screen: { width: root.frame.width, height: root.frame.height },
    scale: 3,
    capturedAt: "2026-10-29T13:52:00.000Z",
    root,
    screenshot: decodePng(readFileSync(join(import.meta.dirname, "fixtures", "ios-rn083-checkout.png"))),
  };
  const result = audit(snapshot);

  it("finds every planted bug and nothing else", () => {
    expect(result.findings.map((f) => [f.rule, f.node.testID ?? f.node.name])).toEqual([
      ["control-name", "close"],
      ["input-name", "coupon-input"],
      ["empty-stop", "cart"],
      ["text-contrast", "Apply coupon"],
      ["image-name", "promo-banner"],
      ["missing-role", "guest"],
      ["duplicate-name", "edit-shipping"],
      ["duplicate-name", "edit-payment"],
      ["redundant-role", "play"],
    ]);
  });

  it("measures the real anti-aliased text", () => {
    expect(result.findings.find((f) => f.rule === "text-contrast")!.message).toContain("2.54:1 (#9CA3AF on #FFFFFF)");
  });

  it("drops the scroll bars and AXe's repeated elements", () => {
    const labels = [...walk(root)].map(({ node }) => node.label);
    expect(labels.some((l) => /scroll bar/.test(l))).toBe(false);
  });

  it("passes the 20pt favorite under WCAG's spacing exception, but not the platform minimum", () => {
    expect(by(result, "target-size")).toEqual([]);
    expect(by(audit(snapshot, { profile: "platform" }), "platform-target-size")).toEqual(["close", "favorite"]);
  });
});
