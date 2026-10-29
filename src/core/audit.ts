import { RULES } from "./rules/index.js";
import type { RuleContext } from "./rules/types.js";
import { isVisible, walk } from "./tree.js";
import { SEVERITIES, type AuditResult, type Finding, type ProfileName, type Severity, type Snapshot } from "./types.js";

/** Skip a finding by rule, optionally only for one testID or accessible name. */
export interface Ignore {
  rule: string;
  testID?: string;
  name?: string;
}

export interface AuditOptions {
  profile?: ProfileName;
  ignore?: Ignore[];
}

const matches = (ignore: Ignore, finding: Finding) =>
  (ignore.rule === "*" || ignore.rule === finding.rule) &&
  (ignore.testID === undefined || ignore.testID === finding.node.testID) &&
  (ignore.name === undefined || ignore.name.toLowerCase() === finding.node.name.toLowerCase());

export function audit(snapshot: Snapshot, options: AuditOptions = {}): AuditResult {
  const profile = options.profile ?? "wcag22-aa";
  const nodes = [...walk(snapshot.root)].filter(
    ({ node, ancestors }) => node !== snapshot.root && node.enabled && ancestors.every((a) => a.enabled) && isVisible(node.frame, snapshot.screen),
  );
  const ctx: RuleContext = { snapshot, profile, nodes, notes: [] };
  const rules = RULES.filter((r) => r.profiles.includes(profile) && (!r.platforms || r.platforms.includes(snapshot.platform)));

  const findings = rules
    .flatMap((rule) => rule.run(ctx).map((f): Finding => ({ rule: rule.id, source: rule.source, ...f })))
    .filter((f) => !options.ignore?.some((ignore) => matches(ignore, f)))
    .sort((a, b) => rank(a.severity) - rank(b.severity) || a.node.frame.y - b.node.frame.y || a.node.frame.x - b.node.frame.x);

  return {
    platform: snapshot.platform,
    ...(snapshot.name ? { name: snapshot.name } : {}),
    ...(snapshot.url ? { url: snapshot.url } : {}),
    device: snapshot.device,
    ...(snapshot.app ? { app: snapshot.app } : {}),
    profile,
    capturedAt: snapshot.capturedAt,
    findings,
    rules: rules.map(({ id, title, source }) => ({ id, title, source })),
    notes: ctx.notes,
    stats: {
      elements: nodes.length,
      targets: nodes.filter(({ node }) => node.interactive).length,
      texts: nodes.filter(({ node }) => node.kind === "text").length,
    },
  };
}

export const rank = (s: Severity) => SEVERITIES.indexOf(s);

/** At least as severe as the threshold. */
export const atLeast = (s: Severity, threshold: Severity) => rank(s) <= rank(threshold);
