import { counts } from "./terminal.js";
import type { AuditResult, Finding } from "../core/types.js";

export interface ReportSection {
  result: AuditResult;
  screen: { width: number; height: number };
  /** PNG bytes of the screenshot, embedded so the report is one file. */
  screenshot?: Buffer;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** WCAG 2.2 AA criteria for mobile that need a person, because no tree or screenshot shows them. */
const MANUAL = [
  ["1.3.2 Meaningful Sequence", "Swipe through the screen with VoiceOver or TalkBack: the reading order follows the visual order."],
  ["1.3.4 Orientation", "The screen works in portrait and landscape, unless one orientation is essential."],
  ["1.4.4 Resize Text", "At the largest system text size (Dynamic Type, font scale), nothing is cut off or overlaps."],
  ["1.4.11 Non-text Contrast", "Icons, input borders and focus indicators reach 3:1 against what's next to them."],
  ["2.4.3 Focus Order", "After opening or closing a modal or sheet, focus moves to it and returns sensibly."],
  ["2.4.11 Focus Not Obscured", "A focused element is never hidden behind a sticky header, bottom sheet or the keyboard."],
  ["2.5.1 Pointer Gestures", "Pinch, multi-finger and path-based gestures have a single-tap alternative."],
  ["2.5.4 Motion Actuation", "Anything triggered by shaking or tilting also has a button, and the motion can be turned off."],
  ["2.5.7 Dragging Movements", "Sliders, reordering and swipe-to-delete can also be done with taps."],
  ["3.3.7 Redundant Entry", "Users aren't asked to re-type information they already entered in the same flow."],
  ["3.3.8 Accessible Authentication", "Sign-in works with paste and password managers, with no puzzle or code to transcribe."],
  ["4.1.3 Status Messages", "Toasts, errors and loading states are announced (accessibilityLiveRegion, AccessibilityInfo.announceForAccessibility)."],
] as const;

const pct = (n: number, of: number) => `${((n / of) * 100).toFixed(3)}%`;

/** One box per element; an element with several issues gets one badge listing them all. */
function boxes(findings: Finding[], screen: ReportSection["screen"], key: (i: number) => string) {
  const groups = new Map<string, number[]>();
  findings.forEach((f, i) => groups.set(f.node.id, [...(groups.get(f.node.id) ?? []), i]));
  return [...groups.values()]
    .map((indexes) => {
      const f = findings[indexes[0]!]!;
      const { x, y, width, height } = f.node.frame;
      const style = `left:${pct(x, screen.width)};top:${pct(y, screen.height)};width:${pct(width, screen.width)};height:${pct(height, screen.height)}`;
      const nums = indexes.map((i) => i + 1);
      const severities = [...new Set(indexes.map((i) => findings[i]!.severity))].join(" ");
      const label = `Issue${nums.length > 1 ? "s" : ""} ${nums.join(", ")}: ${indexes.map((i) => findings[i]!.message).join(" ")}`;
      return `<button class="box sev-${f.severity}" style="${style}" data-keys="${indexes.map(key).join(" ")}" data-severities="${severities}" aria-label="${esc(label)}"><span>${nums.join(",")}</span></button>`;
    })
    .join("");
}

function item(f: Finding, n: number, key: string, unit: string) {
  const { x, y, width, height } = f.node.frame;
  const element = [
    f.node.testID ? `testID <code>${esc(f.node.testID)}</code>` : "",
    f.node.name ? `name <q>${esc(f.node.name.slice(0, 80))}</q>` : "",
    `<code>${esc(f.node.className.replace(/^.*\./, ""))}</code>`,
    `${Math.round(width)}×${Math.round(height)}${unit} at ${Math.round(x)}, ${Math.round(y)}`,
  ].filter(Boolean);
  return `<li class="finding sev-${f.severity}" data-key="${key}" data-severity="${f.severity}" tabindex="0">
  <div class="num">${n}</div>
  <div class="body">
    <div class="meta"><span class="pill sev-${f.severity}">${f.severity}</span>${f.review ? '<span class="pill review">check by hand</span>' : ""}<span class="rule">${esc(f.rule)} · ${esc(f.source)}</span></div>
    <p class="msg">${esc(f.message)}</p>
    <p class="fix"><strong>Fix:</strong> ${esc(f.fix)}</p>
    <p class="el">${element.join(" · ")}</p>
  </div>
</li>`;
}

function section(s: ReportSection, index: number) {
  const r = s.result;
  const unit = r.platform === "ios" ? "pt" : "dp";
  const platform = r.platform === "ios" ? "iOS" : "Android";
  const key = (i: number) => `${index}-${i}`;
  const summary = r.findings.length
    ? counts(r.findings).map(([sev, n]) => `<span class="pill sev-${sev}">${n} ${sev}</span>`).join(" ")
    : '<span class="pill ok">No issues</span>';
  const shot = s.screenshot
    ? `<div class="shot" style="aspect-ratio:${s.screen.width}/${s.screen.height}">
        <img src="data:image/png;base64,${s.screenshot.toString("base64")}" alt="Screenshot of the audited ${platform} screen">
        ${boxes(r.findings, s.screen, key)}
      </div>`
    : '<p class="noshot">No screenshot was captured.</p>';
  return `<section class="platform">
  <header class="phead">
    <h2>${platform} <span class="sub">${esc(r.app ?? "")}</span></h2>
    <p class="device">${esc(r.device.name)}${r.device.detail ? ` · ${esc(r.device.detail)}` : ""} · ${r.stats.elements} elements, ${r.stats.targets} touch targets, ${r.stats.texts} text</p>
    <p class="summary">${summary}</p>
  </header>
  <div class="cols">
    <div class="left">${shot}</div>
    <div class="right">
      ${r.findings.length ? `<ol class="findings">${r.findings.map((f, i) => item(f, i + 1, key(i), unit)).join("\n")}</ol>` : `<p class="clean">All ${r.rules.length} automated checks passed. Work through the manual checklist below too.</p>`}
      ${r.notes.length ? `<ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      <details class="checked"><summary>What was checked (${r.rules.length} rules, profile ${esc(r.profile)})</summary>
        <ul>${r.rules.map((rule) => `<li><strong>${esc(rule.title)}</strong> <span class="rule">${esc(rule.id)} · ${esc(rule.source)}</span></li>`).join("")}</ul>
      </details>
    </div>
  </div>
</section>`;
}

export function renderHtml(sections: ReportSection[], options: { title?: string; version: string }): string {
  const title = options.title ? `${options.title} · Accessibility audit` : "Accessibility audit";
  const when = sections[0]?.result.capturedAt ? new Date(sections[0].result.capturedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "";
  const profile = sections[0]?.result.profile ?? "wcag22-aa";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root {
  --bg: #f7f7f5; --panel: #ffffff; --text: #1c1c1a; --muted: #62625d; --line: #e3e2dd; --code: #f0efea;
  --critical: #b3261e; --serious: #d1450f; --moderate: #a86b00; --minor: #6b6b66; --ok: #1f7a3a; --focus: #2457d6;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161615; --panel: #1f1f1d; --text: #ecebe6; --muted: #a3a29b; --line: #34332f; --code: #2a2a27;
    --critical: #ff6b5e; --serious: #ff8a4c; --moderate: #f0b43c; --minor: #a3a29b; --ok: #5fcf83; --focus: #7aa2ff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
.lede { color: var(--muted); margin: 0 0 28px; }
.platform { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 20px; margin-bottom: 28px; }
.phead h2 { margin: 0; font-size: 20px; }
.sub { color: var(--muted); font-weight: 500; }
.device { color: var(--muted); margin: 2px 0 10px; font-size: 14px; }
.summary { margin: 0 0 18px; display: flex; flex-wrap: wrap; gap: 6px; }
.cols { display: grid; grid-template-columns: minmax(220px, 340px) 1fr; gap: 24px; align-items: start; }
.left { position: sticky; top: 16px; }
.shot { position: relative; width: 100%; border-radius: 18px; overflow: hidden; border: 1px solid var(--line); background: var(--code); }
.shot img { display: block; width: 100%; height: 100%; }
.box { position: absolute; padding: 0; margin: 0; background: transparent; border: 2px solid currentColor; border-radius: 3px; cursor: pointer; min-width: 4px; min-height: 4px; }
.box span { position: absolute; top: -9px; left: -9px; white-space: nowrap; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 9px; background: currentColor; font: 600 11px/18px system-ui, sans-serif; text-align: center; }
/* The badge's background is the severity color (currentColor), so its digits are painted white with text-fill. */
.box span, .num { -webkit-text-fill-color: #fff; }
.box.active { outline: 3px solid var(--focus); outline-offset: 2px; background: color-mix(in srgb, currentColor 18%, transparent); z-index: 2; }
.sev-critical { color: var(--critical); } .sev-serious { color: var(--serious); } .sev-moderate { color: var(--moderate); } .sev-minor { color: var(--minor); }
.findings { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.finding { display: grid; grid-template-columns: 28px 1fr; gap: 10px; padding: 12px; border: 1px solid var(--line); border-left: 4px solid currentColor; border-radius: 10px; cursor: pointer; }
.finding .body { color: var(--text); min-width: 0; }
.finding.active { outline: 2px solid var(--focus); outline-offset: 1px; }
.finding:focus-visible { outline: 2px solid var(--focus); }
.num { width: 24px; height: 24px; border-radius: 12px; background: currentColor; font: 600 12px/24px system-ui, sans-serif; text-align: center; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid currentColor; font-size: 12px; font-weight: 600; text-transform: capitalize; }
.pill.review { color: var(--muted); font-weight: 500; text-transform: none; }
.pill.ok { color: var(--ok); }
.rule { color: var(--muted); font-size: 12px; }
.msg { margin: 6px 0 4px; font-weight: 600; }
.fix { margin: 0 0 4px; }
.el { margin: 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
code { background: var(--code); padding: 0 4px; border-radius: 4px; font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
.notes { color: var(--muted); font-size: 14px; padding-left: 18px; }
.clean { color: var(--ok); font-weight: 600; }
details { margin-top: 16px; border-top: 1px solid var(--line); padding-top: 12px; }
summary { cursor: pointer; font-weight: 600; }
details ul { padding-left: 18px; margin: 8px 0 0; } details li { margin: 4px 0; }
.manual { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 20px; }
.manual h2 { margin: 0 0 4px; font-size: 18px; }
.manual p { color: var(--muted); margin: 0 0 12px; }
.manual li { margin: 6px 0; }
.filters { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 20px; font-size: 14px; }
.filters label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
footer { color: var(--muted); font-size: 13px; margin-top: 24px; }
@media (max-width: 760px) { .cols { grid-template-columns: 1fr; } .left { position: static; max-width: 340px; margin: 0 auto; } }
</style>
</head>
<body>
<main>
  <h1>${esc(title)}</h1>
  <p class="lede">${esc(when)} · profile <code>${esc(profile)}</code> · automated checks find roughly a third of WCAG issues, so finish with the manual checklist.</p>
  <div class="filters" role="group" aria-label="Show severities">
    ${["critical", "serious", "moderate", "minor"].map((s) => `<label class="sev-${s}"><input type="checkbox" checked value="${s}"> <span style="color:var(--text)">${s}</span></label>`).join("")}
  </div>
  ${sections.map(section).join("\n")}
  <section class="manual">
    <h2>Check by hand</h2>
    <p>WCAG 2.2 AA criteria for mobile apps that no screenshot or accessibility tree can show.</p>
    <ul>${MANUAL.map(([sc, what]) => `<li><strong>${sc}</strong>: ${what}</li>`).join("")}</ul>
  </section>
  <footer>Generated by rn-a11y ${esc(options.version)}.</footer>
</main>
<script>
const all = (sel) => [...document.querySelectorAll(sel)];
function activate(keys, scroll) {
  all(".active").forEach((el) => el.classList.remove("active"));
  all(".box").filter((b) => keys.some((k) => b.dataset.keys.split(" ").includes(k))).forEach((b) => b.classList.add("active"));
  const items = all(".finding").filter((f) => keys.includes(f.dataset.key));
  items.forEach((f) => f.classList.add("active"));
  if (scroll) items[0]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
all(".box").forEach((b) => b.addEventListener("click", () => activate(b.dataset.keys.split(" "), true)));
all(".finding").forEach((f) => {
  f.addEventListener("mouseenter", () => activate([f.dataset.key], false));
  f.addEventListener("click", () => activate([f.dataset.key], false));
  f.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate([f.dataset.key], false); } });
});
all(".filters input").forEach((input) => input.addEventListener("change", () => {
  const shown = new Set(all(".filters input").filter((i) => i.checked).map((i) => i.value));
  all(".finding").forEach((f) => { f.hidden = !shown.has(f.dataset.severity); });
  all(".box").forEach((b) => { b.hidden = !b.dataset.severities.split(" ").some((s) => shown.has(s)); });
}));
</script>
</body>
</html>
`;
}
