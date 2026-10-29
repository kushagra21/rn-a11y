import { ROLELESS_CLASSES } from "../readers/android.js";
import { accessibleName, describe } from "../tree.js";
import { BOTH, type Rule } from "./types.js";

const KIND_NAMES: Partial<Record<string, string>> = { button: "Button", link: "Link", switch: "Switch", checkbox: "Checkbox", radio: "Radio button", slider: "Slider", tab: "Tab" };
const reader = (platform: string) => (platform === "ios" ? "VoiceOver" : "TalkBack");

const label = (name: string) => `"${name.length > 40 ? `${name.slice(0, 39)}…` : name}"`;

export const controlName: Rule = {
  id: "control-name",
  title: "Controls have an accessible name",
  source: "WCAG 2.2 SC 4.1.2",
  profiles: BOTH,
  run: ({ nodes, snapshot }) =>
    nodes
      .filter(({ node }) => node.interactive && node.kind !== "input" && !accessibleName(node))
      .map(({ node }) => ({
        severity: "critical",
        message: `${KIND_NAMES[node.kind] ?? "Tappable element"} has no accessible name, so ${reader(snapshot.platform)} can't say what it does.`,
        fix: 'Add accessibilityLabel describing what it does, e.g. accessibilityLabel="Close". Icon-only buttons need this most.',
        node: describe(node),
      })),
};

export const inputName: Rule = {
  id: "input-name",
  title: "Text fields have a label",
  source: "WCAG 2.2 SC 4.1.2, 3.3.2",
  profiles: BOTH,
  run: ({ nodes }) =>
    nodes
      .filter(({ node }) => node.kind === "input" && !node.label.trim() && !node.hint?.trim())
      .map(({ node }) => ({
        severity: "critical",
        message: "Text field has no label, so a screen reader user can't tell what to type.",
        fix: 'Add accessibilityLabel (e.g. accessibilityLabel="Email"). A placeholder alone disappears once the user types.',
        node: describe(node),
      })),
};

export const imageName: Rule = {
  id: "image-name",
  title: "Images have a text alternative",
  source: "WCAG 2.2 SC 1.1.1",
  profiles: BOTH,
  run: ({ nodes, snapshot }) =>
    nodes
      // An image inside a control is named by the control; control-name covers it.
      .filter(({ node, ancestors }) => node.kind === "image" && !node.interactive && !accessibleName(node) && !ancestors.some((a) => a.interactive))
      // A tiny image is almost always an icon next to a text label.
      .filter(({ node }) => node.frame.width >= 16 && node.frame.height >= 16)
      .map(({ node }) => ({
        severity: "moderate",
        review: true,
        message: "Image has no description.",
        fix:
          snapshot.platform === "android"
            ? 'If it carries meaning, add accessibilityLabel. If it is decorative, add importantForAccessibility="no" so TalkBack skips it.'
            : "If it carries meaning, add accessibilityLabel. If it is decorative, remove accessible={true} so VoiceOver skips it.",
        node: describe(node),
      })),
};

export const emptyStop: Rule = {
  id: "empty-stop",
  title: "Screen reader stops have something to read",
  source: "WCAG 2.2 SC 4.1.2",
  profiles: BOTH,
  platforms: ["ios"],
  run: ({ nodes }) =>
    nodes
      .filter(({ node }) => node.focusable && !node.interactive && node.kind !== "image" && node.kind !== "input" && !accessibleName(node))
      .filter(({ node }) => node.frame.width > 1 && node.frame.height > 1)
      .map(({ node }) => ({
        severity: "serious",
        message: "VoiceOver stops on this element but has nothing to read.",
        fix: "If it is tappable, add accessibilityRole and accessibilityLabel. If not, remove accessible={true} so VoiceOver skips it.",
        node: describe(node),
      })),
};

export const missingRole: Rule = {
  id: "missing-role",
  title: "Controls say what they are",
  source: "WCAG 2.2 SC 4.1.2",
  profiles: BOTH,
  platforms: ["android"],
  run: ({ nodes }) =>
    nodes
      .filter(({ node }) => node.interactive && ROLELESS_CLASSES.has(node.className) && accessibleName(node))
      .map(({ node }) => ({
        severity: "serious",
        message: `${label(accessibleName(node))} is tappable but has no role, so TalkBack doesn't say it's a button.`,
        fix: 'Add accessibilityRole="button" (or "link", "tab", "checkbox", …). On iOS the same Pressable has no button trait either.',
        node: describe(node),
      })),
};

const ROLE_WORDS: Partial<Record<string, RegExp>> = {
  button: /\b(button|btn)\b/i,
  link: /\blink\b/i,
  image: /\b(image|picture|photo|icon)\b/i,
  tab: /\btab\b/i,
};

export const redundantRole: Rule = {
  id: "redundant-role",
  title: "Labels don't repeat the role",
  source: "Apple HIG, Android accessibility guidelines",
  profiles: BOTH,
  run: ({ nodes }) =>
    nodes
      .filter(({ node }) => {
        const words = ROLE_WORDS[node.kind];
        return !!words && words.test(node.label);
      })
      .map(({ node }) => ({
        severity: "minor",
        message: `Label ${label(node.label)} repeats the role, so it is read as "${node.label}, ${node.kind}".`,
        fix: `Drop the word from accessibilityLabel; the screen reader already says "${node.kind}".`,
        node: describe(node),
      })),
};

export const duplicateName: Rule = {
  id: "duplicate-name",
  title: "Controls on one screen have distinct names",
  source: "WCAG 2.2 SC 2.4.6 (advisory)",
  profiles: BOTH,
  run: ({ nodes }) => {
    const byName = new Map<string, typeof nodes>();
    for (const entry of nodes) {
      if (!entry.node.interactive) continue;
      const name = accessibleName(entry.node).toLowerCase();
      if (name) byName.set(name, [...(byName.get(name) ?? []), entry]);
    }
    return [...byName.values()]
      .filter((group) => group.length > 1)
      .flatMap((group) =>
        group.map(({ node }) => ({
          severity: "minor" as const,
          review: true,
          message: `${group.length} controls are all named ${label(accessibleName(node))}, so they sound the same out of context.`,
          fix: 'Make each name say what it acts on, e.g. accessibilityLabel="Edit shipping address".',
          node: describe(node),
        })),
      );
  },
};
