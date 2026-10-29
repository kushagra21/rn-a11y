import { accessibleName, isVisible, walk } from "./tree.js";
import type { A11yNode } from "./types.js";

type Screen = { width: number; height: number };

const CONTENT = new Set(["button", "link", "image", "text", "input", "switch", "checkbox", "radio", "slider", "tab", "header"]);

/** Numbers change while a screen stays the same (prices, counters, clocks), so they don't count. */
const normalize = (s: string) => s.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 60);

const visibleContent = (root: A11yNode, screen: Screen) =>
  [...walk(root)].map(({ node }) => node).filter((n) => (CONTENT.has(n.kind) || n.interactive) && isVisible(n.frame, screen));

/** What's on screen, ignoring layout: used to tell whether two trees are the same screen. */
export function signature(root: A11yNode, screen: Screen): Set<string> {
  return new Set(visibleContent(root, screen).map((n) => `${n.kind}|${n.testID ?? ""}|${normalize(accessibleName(n))}`));
}

/** Content plus positions: equal on two reads in a row means the screen has stopped moving. */
export function layoutKey(root: A11yNode, screen: Screen): string {
  return visibleContent(root, screen)
    .map((n) => `${n.kind}|${n.testID ?? ""}|${accessibleName(n)}|${Math.round(n.frame.x)},${Math.round(n.frame.y)},${Math.round(n.frame.width)},${Math.round(n.frame.height)}`)
    .join("\n");
}

/** Jaccard similarity of two signatures, from 0 to 1. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Screens sharing at least this much content count as the same screen. */
export const SAME_SCREEN = 0.6;

/** A name for the screen: its first heading, else its biggest text near the top. */
export function screenName(root: A11yNode, screen: Screen): string | undefined {
  const nodes = visibleContent(root, screen);
  const heading = nodes.find((n) => n.kind === "header" && accessibleName(n));
  if (heading) return accessibleName(heading).slice(0, 50);
  const texts = nodes
    .filter((n) => n.kind === "text" && n.frame.y < screen.height * 0.4 && accessibleName(n).length <= 40)
    .sort((a, b) => b.frame.height - a.frame.height || a.frame.y - b.frame.y);
  return texts[0] ? accessibleName(texts[0]) : undefined;
}

export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "screen";
