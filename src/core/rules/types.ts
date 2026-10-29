import type { A11yNode, Finding, Platform, ProfileName, Snapshot } from "../types.js";

export interface RuleContext {
  snapshot: Snapshot;
  profile: ProfileName;
  /** Visible, enabled nodes (and nodes under no disabled ancestor), in reading order. */
  nodes: { node: A11yNode; ancestors: A11yNode[] }[];
  notes: string[];
}

export interface Rule {
  id: string;
  title: string;
  source: string;
  /** Profiles the rule runs in. */
  profiles: ProfileName[];
  /** Platforms the rule can check; others skip it. */
  platforms?: Platform[];
  run(ctx: RuleContext): Omit<Finding, "rule" | "source">[];
}

export const BOTH: ProfileName[] = ["wcag22-aa", "platform"];
