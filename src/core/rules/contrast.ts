import { hex, sampleContrast } from "../contrast.js";
import { accessibleName, describe } from "../tree.js";
import type { Finding } from "../types.js";
import type { Rule } from "./types.js";

/**
 * WCAG 2.2 SC 1.4.3: 4.5:1 for text, 3:1 for large text (18pt, or 14pt bold).
 * The screenshot doesn't say how big the font is, so 3:1–4.5:1 is flagged for review.
 */
export const textContrast: Rule = {
  id: "text-contrast",
  title: "Text has enough contrast with its background",
  source: "WCAG 2.2 SC 1.4.3",
  profiles: ["wcag22-aa", "platform"],
  run: (ctx) => {
    const { screenshot, scale, platform } = ctx.snapshot;
    if (!screenshot) {
      ctx.notes.push("Contrast wasn't checked: no screenshot.");
      return [];
    }
    // iOS folds a control's text into the control, so check controls with a name too.
    const texts = ctx.nodes.filter(
      ({ node }) =>
        (node.kind === "text" && accessibleName(node)) || (platform === "ios" && node.interactive && node.kind !== "input" && accessibleName(node)),
    );
    let busy = 0;
    const findings = texts.flatMap(({ node }): Omit<Finding, "rule" | "source">[] => {
      const sample = sampleContrast(screenshot, node.frame, scale);
      if (!sample.ok) {
        if (sample.reason === "busy") busy++;
        return [];
      }
      if (sample.ratio >= 4.5) return [];
      const colors = `${hex(sample.foreground)} on ${hex(sample.background)}`;
      const ratio = `${sample.ratio.toFixed(2)}:1`;
      const isControl = node.kind !== "text";
      if (sample.ratio < 3) {
        return [
          {
            severity: "serious",
            message: `Contrast is ${ratio} (${colors}); text needs 4.5:1, or 3:1 if large.`,
            fix: `Darken the text or lighten the background (or the reverse in dark mode) until it reaches 4.5:1.`,
            node: describe(node),
          },
        ];
      }
      return [
        {
          severity: "moderate",
          review: true,
          message: `Contrast is ${ratio} (${colors}). That passes only for large text (18pt, or 14pt bold)${isControl ? " or an icon" : ""}.`,
          fix: "If the text is smaller than 18pt (14pt bold), raise the contrast to 4.5:1.",
          node: describe(node),
        },
      ];
    });
    if (busy) ctx.notes.push(`${busy} text element${busy === 1 ? " sits" : "s sit"} on an image or gradient; check their contrast by eye.`);
    return findings;
  },
};
