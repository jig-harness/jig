/** The review's one report: verdicts, findings and the review-record line. */
import {
  type Context,
  type Findings,
  SEVERITIES,
  type Severity,
} from "./findings.ts";
import type { Plan } from "./plan.ts";

const SEVERITY_NAME: Record<Severity, string> = {
  blocking: "Blocking",
  major: "Major",
  minor: "Minor",
};

const CONTEXT_NAME: Record<Context, string> = {
  subagent: "subagent",
  "fresh-run": "fresh run",
  "same-session": "this session",
};

/** A value safe inside one Markdown table cell. */
export function cell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ");
}

function quote(passage: string): string {
  return passage
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

function count(results: Findings[], severity: Severity): number {
  return results.reduce(
    (sum, r) => sum + r.findings.filter((f) => f.severity === severity).length,
    0,
  );
}

function header(plan: Plan, results: Findings[]): string[] {
  const verdicts = ["rethink", "revise", "ready"]
    .map((v) => [v, results.filter((r) => r.verdict === v).length] as const)
    .filter(([, n]) => n > 0)
    .map(([v, n]) => `${n} ${v}`)
    .join(", ");
  const lines = [
    `# Red-team review: ${plan.title}`,
    "",
    `- Document: \`${plan.display}\`, read as a ${plan.kind} document (${plan.kindFrom}).`,
  ];
  if (plan.companion)
    lines.push(`- Companion read for context: \`${plan.companion}\`.`);
  lines.push(
    `- Reviewed ${plan.date}, document SHA-256 \`${plan.sha256.slice(0, 12)}\`, by ${results.length} personas.`,
    `- Findings: ${SEVERITIES.map((s) => `${count(results, s)} ${s}`).join(", ")}. Verdicts: ${verdicts}.`,
  );
  const same = results.filter((r) => r.context === "same-session");
  if (same.length > 0)
    lines.push(
      "",
      `**Not in fresh context:** ${same.length} of ${results.length} personas ran in the session that ran the review, because no subagent or agent command was available. They may share what that session already believed about the document; weigh their silence accordingly.`,
    );
  return lines;
}

function verdictTable(plan: Plan, results: Findings[]): string[] {
  const rows = results.map((r) => {
    const name =
      plan.personas.find((p) => p.id === r.persona)?.name ?? r.persona;
    const n = (s: Severity) =>
      r.findings.filter((f) => f.severity === s).length;
    return `| ${cell(name)} | ${r.verdict} | ${n("blocking")} | ${n("major")} | ${n("minor")} | ${CONTEXT_NAME[r.context]} |`;
  });
  return [
    "## Verdicts",
    "",
    "| Persona | Verdict | Blocking | Major | Minor | Ran as |",
    "|---------|---------|----------|-------|-------|--------|",
    ...rows,
  ];
}

function findingSections(plan: Plan, results: Findings[]): string[] {
  const lines = ["## Findings", ""];
  let n = 0;
  for (const severity of SEVERITIES)
    for (const result of results) {
      const name =
        plan.personas.find((p) => p.id === result.persona)?.name ??
        result.persona;
      for (const finding of result.findings.filter(
        (f) => f.severity === severity,
      )) {
        n += 1;
        lines.push(
          `### F${n}. ${SEVERITY_NAME[severity]}, from the ${name.toLowerCase()}`,
          "",
          quote(finding.passage),
          "",
          `- **Risk:** ${finding.risk}`,
          `- **Question:** ${finding.question}`,
          "",
        );
      }
    }
  if (n === 0) lines.push("No persona found anything to report.", "");
  return lines;
}

function summaries(plan: Plan, results: Findings[]): string[] {
  const lines = ["## What each persona said", ""];
  for (const result of results) {
    const name =
      plan.personas.find((p) => p.id === result.persona)?.name ??
      result.persona;
    lines.push(`### ${name}: ${result.verdict}`, "", result.summary, "");
  }
  return lines;
}

function next(plan: Plan, results: Findings[]): string[] {
  const ids = results.map((r) => r.persona).join(", ");
  return [
    "## Next",
    "",
    "This review did not change the document. Its author answers each question in the next revision, then the document is de-scarred: it carries the answers, not this report.",
    "",
    "Where the repository keeps a stage-review record, the accepted document's record can cite this review, with a link to wherever this report is kept (the pull request or issue that carries the document):",
    "",
    `\`reviewed: "red-team by persona (${ids}), ${plan.date}, <link>"\``,
    "",
  ];
}

/** The report, in Markdown. `results` follow the plan's persona order. */
export function renderReport(plan: Plan, results: Findings[]): string {
  return [
    ...header(plan, results),
    "",
    ...verdictTable(plan, results),
    "",
    ...findingSections(plan, results),
    ...summaries(plan, results),
    ...next(plan, results),
  ].join("\n");
}
