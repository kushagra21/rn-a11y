import { XMLParser } from "fast-xml-parser";
import type { A11yNode, Kind } from "../types.js";

/**
 * Class names as AccessibilityNodeInfo reports them. React Native sets the class from
 * accessibilityRole (ReactAccessibilityDelegate), so a Pressable with role="button"
 * shows up as android.widget.Button, and one with no role as android.view.ViewGroup.
 */
const KINDS: [RegExp, Kind][] = [
  [/\.(ImageButton)$/, "button"],
  [/\.(Button|ToggleButton)$/, "button"],
  [/\.(EditText|AutoCompleteTextView)$/, "input"],
  [/\.(Switch|SwitchCompat)$/, "switch"],
  [/\.CheckBox$/, "checkbox"],
  [/\.RadioButton$/, "radio"],
  [/\.SeekBar$/, "slider"],
  [/\.ImageView$/, "image"],
  [/\.(TextView|CheckedTextView)$/, "text"],
  [/\.(ScrollView|HorizontalScrollView|AbsListView|RecyclerView|ListView|GridView)$/, "scroll"],
  [/^android\.widget\.TabWidget$/, "tab"],
];

/** The class React Native reports for a Pressable with no accessibilityRole. Native list rows (LinearLayout) read fine without one. */
export const ROLELESS_CLASSES = new Set(["android.view.ViewGroup"]);

export function kindOf(className: string, text: string): Kind {
  for (const [pattern, kind] of KINDS) if (pattern.test(className)) return kind;
  if (text.trim()) return "text";
  return /ViewGroup|Layout$/.test(className) ? "container" : "other";
}

interface RawNode {
  "@_text"?: string;
  "@_resource-id"?: string;
  "@_class"?: string;
  "@_package"?: string;
  "@_content-desc"?: string;
  "@_hint"?: string;
  "@_checkable"?: string;
  "@_clickable"?: string;
  "@_long-clickable"?: string;
  "@_focusable"?: string;
  "@_enabled"?: string;
  "@_bounds"?: string;
  node?: RawNode | RawNode[];
}

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** "[0,63][1080,210]" → rect in pixels */
export function parseBounds(bounds: string | undefined) {
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(bounds ?? "");
  if (!m) return { x: 0, y: 0, width: 0, height: 0 };
  const [x1, y1, x2, y2] = m.slice(1).map(Number) as [number, number, number, number];
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** React Native reports testID as the resource-id: bare, or "<package>:id/<testID>" for native views. */
const testIDOf = (resourceId: string | undefined) => {
  if (!resourceId) return undefined;
  const m = /^[\w.]+:id\/(.+)$/.exec(resourceId);
  return m ? m[1] : resourceId;
};

export interface AndroidParseOptions {
  /** Pixels per dp: the screen density divided by 160. */
  dpScale: number;
  /** Keep only this package's nodes, plus their containers. */
  package?: string;
}

/**
 * Parses `uiautomator dump` XML into a tree in dp. System UI (the status and
 * navigation bars) is left out, as it isn't part of the app.
 */
export function parseUiAutomator(xml: string, options: AndroidParseOptions): A11yNode {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", isArray: (name) => name === "node" });
  const doc = parser.parse(xml) as { hierarchy?: { node?: RawNode[] } };
  if (!doc.hierarchy) throw new Error("Not a uiautomator dump: no <hierarchy> element.");
  const s = options.dpScale;

  const convert = (raw: RawNode, id: string): A11yNode | undefined => {
    const pkg = raw["@_package"];
    if (pkg === "com.android.systemui" || (options.package && pkg && pkg !== options.package)) return undefined;
    const className = raw["@_class"] ?? "";
    const text = raw["@_text"] ?? "";
    const px = parseBounds(raw["@_bounds"]);
    const kind = kindOf(className, text);
    const clickable = raw["@_clickable"] === "true" || raw["@_long-clickable"] === "true" || raw["@_checkable"] === "true";
    const children = asArray(raw.node)
      .map((child, i) => convert(child, `${id}.${i}`))
      .filter((n): n is A11yNode => !!n);
    const testID = testIDOf(raw["@_resource-id"]);
    return {
      id,
      kind,
      className,
      label: raw["@_content-desc"] ?? "",
      // An empty EditText reports its hint as its text; keep the two apart.
      text: kind === "input" && text === raw["@_hint"] ? "" : text,
      ...(raw["@_hint"] ? { hint: raw["@_hint"] } : {}),
      ...(testID ? { testID } : {}),
      frame: { x: px.x / s, y: px.y / s, width: px.width / s, height: px.height / s },
      interactive: clickable || kind === "input",
      focusable: raw["@_focusable"] === "true" || clickable,
      enabled: raw["@_enabled"] !== "false",
      ...(pkg ? { package: pkg } : {}),
      children,
    };
  };

  const children = asArray(doc.hierarchy.node)
    .map((n, i) => convert(n, String(i)))
    .filter((n): n is A11yNode => !!n);
  const frame = children.reduce(
    (acc, c) => ({ x: 0, y: 0, width: Math.max(acc.width, c.frame.x + c.frame.width), height: Math.max(acc.height, c.frame.y + c.frame.height) }),
    { x: 0, y: 0, width: 0, height: 0 },
  );
  return { id: "root", kind: "container", className: "hierarchy", label: "", text: "", frame, interactive: false, focusable: false, enabled: true, children };
}

/** `adb shell wm density` → dpi, preferring an override set with `wm density <dpi>`. */
export function parseDensity(output: string): number | undefined {
  const override = /Override density:\s*(\d+)/.exec(output)?.[1];
  const physical = /Physical density:\s*(\d+)/.exec(output)?.[1];
  const dpi = Number(override ?? physical);
  return dpi > 0 ? dpi : undefined;
}
