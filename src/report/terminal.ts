import pc from "picocolors";
import { SEVERITIES, type AuditResult, type Finding, type Severity } from "../core/types.js";

const COLORS: Record<Severity, (s: string) => string> = {
  critical: (s) => pc.bold(pc.red(s)),
  serious: pc.red,
  moderate: pc.yellow,
  minor: pc.dim,
};

const ICONS: Record<Severity, string> = { critical: "✖", serious: "✖", moderate: "⚠", minor: "•" };

const where = (f: Finding) => {
  const { x, y, width, height } = f.node.frame;
  const at = `${Math.round(x)},${Math.round(y)} ${Math.round(width)}×${Math.round(height)}`;
  const id = f.node.testID ? `testID="${f.node.testID}"` : f.node.name ? `"${f.node.name.slice(0, 40)}"` : f.node.className.replace(/^.*\./, "");
  return `${id} at ${at}`;
};

export function counts(findings: Finding[]) {
  return SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);
}

export function formatResult(result: AuditResult): string {
  const lines: string[] = [];
  const platform = result.platform === "ios" ? "iOS" : "Android";
  const device = `${result.device.name}${result.device.detail ? `, ${result.device.detail}` : ""}`;
  const summary = counts(result.findings).map(([s, n]) => COLORS[s](`${n} ${s}`)).join(", ");
  lines.push(pc.bold(`${result.name ? `${result.name} · ` : ""}${platform} · ${result.app ?? "app"} · ${device}`));
  if (result.url) lines.push(pc.dim(result.url));
  lines.push(
    result.findings.length
      ? `${result.findings.length} issue${result.findings.length === 1 ? "" : "s"}: ${summary}`
      : pc.green(`No issues found in ${result.stats.elements} elements.`),
  );
  lines.push("");
  result.findings.forEach((f, i) => {
    const tag = COLORS[f.severity](`${ICONS[f.severity]} ${f.severity.toUpperCase().padEnd(8)}`);
    lines.push(`${pc.dim(String(i + 1).padStart(2))} ${tag} ${f.message}${f.review ? pc.dim(" (check by hand)") : ""}`);
    lines.push(`             ${pc.dim(`${where(f)} · ${f.rule} · ${f.source}`)}`);
    lines.push(`             ${pc.cyan("→")} ${f.fix}`);
  });
  for (const note of result.notes) lines.push(pc.dim(`  note: ${note}`));
  return lines.join("\n");
}
