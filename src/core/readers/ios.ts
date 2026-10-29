import type { A11yNode, Kind, Rect } from "../types.js";

/**
 * One element as `axe describe-ui` and `idb ui describe-all --nested` print it.
 * Both come from the simulator's accessibility service, so they describe exactly
 * what VoiceOver sees.
 */
export interface RawAxElement {
  AXLabel?: string | null;
  AXValue?: string | null;
  AXUniqueId?: string | null;
  AXFrame?: string | null;
  frame?: { x: number; y: number; width: number; height: number } | null;
  title?: string | null;
  type?: string | null;
  role?: string | null;
  role_description?: string | null;
  enabled?: boolean | null;
  children?: RawAxElement[] | null;
}

const KINDS: Record<string, Kind> = {
  Button: "button",
  Link: "link",
  Image: "image",
  StaticText: "text",
  TextField: "input",
  SecureTextField: "input",
  SearchField: "input",
  TextView: "input",
  Switch: "switch",
  Toggle: "switch",
  CheckBox: "checkbox",
  RadioButton: "radio",
  Slider: "slider",
  Stepper: "slider",
  Adjustable: "slider",
  Tab: "tab",
  TabBar: "container",
  Heading: "header",
  Header: "header",
  ScrollView: "scroll",
  ScrollArea: "scroll",
  Table: "scroll",
  CollectionView: "scroll",
  Application: "container",
  Group: "container",
  Window: "container",
};

/**
 * Types that take taps. A Pressable with no accessibilityRole has no traits, so it
 * reads as "GenericElement" (or "Other") and can't be told apart from a grouped View.
 */
/** Element types iOS gives an accessible element with no traits. */
export const TRAITLESS_TYPES = new Set(["GenericElement", "Other"]);

const INTERACTIVE = new Set<Kind>(["button", "link", "input", "switch", "checkbox", "radio", "slider", "tab"]);

/** "{{0, 0}, {402, 874}}" → rect */
export function parseAxFrame(frame: string | null | undefined): Rect | undefined {
  const m = /\{\{(-?[\d.]+),\s*(-?[\d.]+)\},\s*\{([\d.]+),\s*([\d.]+)\}\}/.exec(frame ?? "");
  if (!m) return undefined;
  const [x, y, width, height] = m.slice(1).map(Number) as [number, number, number, number];
  return { x, y, width, height };
}

const typeOf = (raw: RawAxElement) => raw.type ?? raw.role?.replace(/^AX/, "") ?? "Other";

/** Pulls the JSON array out of the tool's output, which may have log lines around it. */
export function extractJson(output: string): RawAxElement[] {
  const start = output.search(/[[{]/);
  if (start < 0) throw new Error("The accessibility tree came back empty. Is an app open on the simulator?");
  const parsed = JSON.parse(output.slice(start)) as RawAxElement | RawAxElement[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** The scroll indicators UIScrollView adds; they aren't part of the app's UI. */
const SCROLL_BAR = /^(Vertical|Horizontal) scroll bar\b/;

/**
 * Drops scroll bars, and elements AXe lists twice under the same parent. Only an exact
 * copy, children included, is a repeat: empty wrappers often share a type and frame.
 */
const keep = (children: RawAxElement[]) => {
  const seen = new Set<string>();
  return children.filter((c) => {
    if (SCROLL_BAR.test(c.AXLabel ?? "")) return false;
    const key = JSON.stringify(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export function parseAxTree(elements: RawAxElement[]): A11yNode {
  const convert = (raw: RawAxElement, id: string): A11yNode => {
    const type = typeOf(raw);
    const kind = KINDS[type] ?? "other";
    const children = keep(raw.children ?? []).map((c, i) => convert(c, `${id}.${i}`));
    const frame = raw.frame ?? parseAxFrame(raw.AXFrame) ?? { x: 0, y: 0, width: 0, height: 0 };
    return {
      id,
      kind,
      className: type,
      label: raw.AXLabel ?? raw.title ?? "",
      text: raw.AXValue ?? "",
      ...(raw.AXUniqueId ? { testID: raw.AXUniqueId } : {}),
      frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
      interactive: INTERACTIVE.has(kind),
      // A control is one VoiceOver stop even when AXe lists its text and icon inside it.
      focusable: kind !== "container" && kind !== "scroll" && (children.length === 0 || INTERACTIVE.has(kind)),
      enabled: raw.enabled !== false,
      children,
    };
  };

  const roots = elements.map((e, i) => convert(e, String(i)));
  if (roots.length === 1 && roots[0]!.className === "Application") return { ...roots[0]!, id: "root" };
  const frame = roots[0]?.frame ?? { x: 0, y: 0, width: 0, height: 0 };
  return { id: "root", kind: "container", className: "Application", label: "", text: "", frame, interactive: false, focusable: false, enabled: true, children: roots };
}
