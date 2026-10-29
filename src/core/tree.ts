import type { A11yNode, Rect } from "./types.js";

/** Every node with its ancestors, depth-first in reading order. */
export function* walk(root: A11yNode, ancestors: A11yNode[] = []): Generator<{ node: A11yNode; ancestors: A11yNode[] }> {
  yield { node: root, ancestors };
  for (const child of root.children) yield* walk(child, [...ancestors, root]);
}

export const area = (r: Rect) => Math.max(0, r.width) * Math.max(0, r.height);

export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** On screen with a size, so a person can see and tap it. */
export const isVisible = (r: Rect, screen: { width: number; height: number }) =>
  area(intersect(r, { x: 0, y: 0, width: screen.width, height: screen.height })) > 0;

/** Partly off screen, so its size on screen isn't its real size. */
export const isClipped = (r: Rect, screen: { width: number; height: number }) =>
  r.x < -0.5 || r.y < -0.5 || r.x + r.width > screen.width + 0.5 || r.y + r.height > screen.height + 0.5;

/** Distance from a point to the nearest point of a rectangle (0 when inside). */
export function distanceToRect(px: number, py: number, r: Rect): number {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.width));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.height));
  return Math.hypot(dx, dy);
}

export const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * What the screen reader says for the element. Android's TalkBack reads a focusable
 * element's own label, else its text, else the text of children that aren't separate
 * stops. On iOS, React Native already folds child text into AXLabel.
 */
export function accessibleName(node: A11yNode): string {
  const own = clean(node.label) || clean(node.text);
  if (own) return own;
  const parts: string[] = [];
  const collect = (n: A11yNode) => {
    for (const child of n.children) {
      if (child.focusable || child.interactive) continue;
      const name = clean(child.label) || clean(child.text);
      if (name) parts.push(name);
      else collect(child);
    }
  };
  collect(node);
  return parts.join(" ");
}

export const describe = (node: A11yNode) => ({
  id: node.id,
  className: node.className,
  frame: node.frame,
  name: accessibleName(node),
  ...(node.testID ? { testID: node.testID } : {}),
});
