import { center, describe, distanceToRect, isClipped } from "../tree.js";
import type { A11yNode } from "../types.js";
import type { Rule, RuleContext } from "./types.js";

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const size = (node: A11yNode, unit: string) => `${fmt(node.frame.width)}×${fmt(node.frame.height)}${unit}`;
const unitOf = (ctx: RuleContext) => (ctx.snapshot.platform === "ios" ? "pt" : "dp");

/** Fully on screen, so its frame is its real size. Inputs are sized by their text and usually far bigger. */
function targets(ctx: RuleContext): A11yNode[] {
  return ctx.nodes.map(({ node }) => node).filter((node) => node.interactive && !isClipped(node.frame, ctx.snapshot.screen));
}

const HIT_SLOP =
  "If the element has hitSlop, the tap area is bigger than what the screen reader reports: check it covers the minimum.";

/**
 * WCAG 2.2 SC 2.5.8 Target Size (Minimum): 24×24, or enough space around it. A smaller
 * target passes when a 24-wide circle centered on it doesn't touch another target or
 * another small target's circle.
 */
export const targetSize: Rule = {
  id: "target-size",
  title: "Touch targets are at least 24×24",
  source: "WCAG 2.2 SC 2.5.8",
  profiles: ["wcag22-aa", "platform"],
  run: (ctx) => {
    const all = targets(ctx);
    const small = all.filter((n) => n.frame.width < 24 || n.frame.height < 24);
    return small
      .filter((node) => {
        const c = center(node.frame);
        return all.some((other) => {
          if (other === node || contains(other, node) || contains(node, other)) return false;
          if (distanceToRect(c.x, c.y, other.frame) < 12) return true;
          if (!small.includes(other)) return false;
          const oc = center(other.frame);
          return Math.hypot(c.x - oc.x, c.y - oc.y) < 24;
        });
      })
      .map((node) => ({
        severity: "serious" as const,
        message: `Touch target is ${size(node, unitOf(ctx))} and too close to another target (minimum 24×24${unitOf(ctx)}).`,
        fix: `Make it at least 24×24 with padding or minWidth/minHeight, or move neighbors at least 24${unitOf(ctx)} away. ${HIT_SLOP}`,
        node: describe(node),
      }));
  },
};

/** Apple HIG: 44×44pt. Material Design: 48×48dp. */
export const platformTargetSize: Rule = {
  id: "platform-target-size",
  title: "Touch targets meet the platform minimum (44pt iOS, 48dp Android)",
  source: "Apple HIG, Material Design",
  profiles: ["platform"],
  run: (ctx) => {
    const min = ctx.snapshot.platform === "ios" ? 44 : 48;
    const unit = unitOf(ctx);
    const guide = ctx.snapshot.platform === "ios" ? "Apple's Human Interface Guidelines" : "Material Design";
    return targets(ctx)
      .filter((n) => n.kind !== "input" && (n.frame.width < min || n.frame.height < min))
      .map((node) => ({
        severity: "moderate" as const,
        message: `Touch target is ${size(node, unit)}; ${guide} ask for at least ${min}×${min}${unit}.`,
        fix: `Give it minWidth/minHeight of ${min}, padding, or hitSlop. ${HIT_SLOP}`,
        node: describe(node),
      }));
  },
};

const contains = (outer: A11yNode, inner: A11yNode) =>
  inner.frame.x >= outer.frame.x &&
  inner.frame.y >= outer.frame.y &&
  inner.frame.x + inner.frame.width <= outer.frame.x + outer.frame.width &&
  inner.frame.y + inner.frame.height <= outer.frame.y + outer.frame.height;
