import { describe, expect, it } from "vitest";
import { parseBounds, parseDensity, parseUiAutomator } from "../src/core/readers/android.js";
import { extractJson, parseAxFrame, parseAxTree } from "../src/core/readers/ios.js";
import { accessibleName, walk } from "../src/core/tree.js";
import { fixture } from "./helpers.js";

const find = (root: ReturnType<typeof parseUiAutomator>, testID: string) => [...walk(root)].find(({ node }) => node.testID === testID)?.node;

describe("Android uiautomator reader", () => {
  const root = parseUiAutomator(fixture("android-checkout.xml"), { dpScale: 420 / 160 });

  it("converts pixels to dp", () => {
    expect(find(root, "close")!.frame).toEqual({ x: 16, y: 150 / 2.625, width: 74 / 2.625, height: 74 / 2.625 });
  });

  it("leaves out the system UI", () => {
    expect([...walk(root)].some(({ node }) => node.package === "com.android.systemui")).toBe(false);
  });

  it("maps classes to kinds and React Native's testID from resource-id", () => {
    expect(find(root, "favorite")).toMatchObject({ kind: "button", interactive: true, label: "Favorite" });
    expect(find(root, "promo-banner")).toMatchObject({ kind: "image", interactive: false });
    expect(find(root, "coupon-input")).toMatchObject({ kind: "input", interactive: true });
    expect(find(root, "place-order")).toMatchObject({ kind: "container", className: "android.view.ViewGroup", interactive: true });
  });

  it("doesn't treat an empty field's hint as its text", () => {
    expect(find(root, "email")).toMatchObject({ text: "", hint: "Email" });
  });

  it("names a control from its children's text, like TalkBack", () => {
    expect(accessibleName(find(root, "place-order")!)).toBe("Place order");
    expect(accessibleName(find(root, "close")!)).toBe("");
  });

  it("strips the package from native resource ids", () => {
    const xml = `<hierarchy><node class="android.widget.Button" package="a.b" resource-id="a.b:id/save" bounds="[0,0][10,10]" /></hierarchy>`;
    expect(parseUiAutomator(xml, { dpScale: 1 }).children[0]!.testID).toBe("save");
  });

  it("rejects something that isn't a dump", () => {
    expect(() => parseUiAutomator("<html/>", { dpScale: 1 })).toThrow(/uiautomator/);
  });

  it("parses bounds and density", () => {
    expect(parseBounds("[0,63][1080,210]")).toEqual({ x: 0, y: 63, width: 1080, height: 147 });
    expect(parseDensity("Physical density: 420\n")).toBe(420);
    expect(parseDensity("Physical density: 420\nOverride density: 560\n")).toBe(560);
    expect(parseDensity("error")).toBeUndefined();
  });
});

describe("iOS accessibility tree reader", () => {
  const root = parseAxTree(extractJson(fixture("ios-checkout.json")));
  const byId = (id: string) => [...walk(root)].find(({ node }) => node.testID === id)?.node;

  it("keeps the app as the root", () => {
    expect(root).toMatchObject({ id: "root", className: "Application", label: "Shop", frame: { width: 402, height: 874 } });
  });

  it("maps types to kinds; a Pressable without a role is just Other", () => {
    expect(byId("close")).toMatchObject({ kind: "button", interactive: true, focusable: true, label: "" });
    expect(byId("cart")).toMatchObject({ kind: "other", interactive: false, focusable: true });
    expect(byId("coupon-input")).toMatchObject({ kind: "input", interactive: true });
  });

  it("reads frames from the AXFrame string when there is no frame object", () => {
    expect(parseAxFrame("{{16.5, 62}, {30, 30.25}}")).toEqual({ x: 16.5, y: 62, width: 30, height: 30.25 });
    const tree = parseAxTree([{ type: "Application", AXFrame: "{{0, 0}, {390, 844}}", children: [] }]);
    expect(tree.frame.width).toBe(390);
  });

  it("finds the JSON among log lines", () => {
    expect(extractJson('2026-10-29 info: connecting\n[{"type":"Application"}]')).toEqual([{ type: "Application" }]);
    expect(() => extractJson("")).toThrow(/empty/);
  });
});
