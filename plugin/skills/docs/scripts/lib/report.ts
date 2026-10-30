/**
 * The one pass's report: each check's status, the findings grouped by file,
 * and the documents the project still lacks; as text or as JSON.
 */
import type { CheckResult, Finding } from "./gates.ts";
import type { Detected, Expected } from "./plan.ts";

export interface Report {
  root: string | null;
  schema: string | null;
  base: string | null;
  staleAfterDays: number;
  project: Detected;
  checks: CheckResult[];
  expected: Expected[];
}

/**
 * 2 when a check could not check, else 1 when one found an error, else 0. An
 * unchecked gate wins: findings from the rest do not make the pass complete.
 */
export function exitCode(report: Report): number {
  if (report.checks.some((c) => c.status === "failed")) return 2;
  const findings = report.checks.flatMap((c) => c.findings);
  return findings.some((f) => f.severity === "error") ? 1 : 0;
}

/** The findings of every check, by file in byte order, then line. */
export function byFile(checks: CheckResult[]): Map<string, Finding[]> {
  const files = new Map<string, Finding[]>();
  const all = checks
    .flatMap((c) => c.findings)
    .sort((a, b) =>
      a.file === b.file
        ? (a.line ?? 0) - (b.line ?? 0)
        : a.file < b.file
          ? -1
          : 1,
    );
  for (const f of all) files.set(f.file, [...(files.get(f.file) ?? []), f]);
  return files;
}

export function renderJson(report: Report): string {
  const missing = report.expected.filter((e) => e.found === null);
  return `${JSON.stringify(
    {
      schema: "docs-report/v1",
      root: report.root,
      frontmatterSchema: report.schema,
      base: report.base,
      staleAfterDays: report.staleAfterDays,
      project: report.project,
      checks: report.checks.map(({ name, status, detail, findings }) => ({
        name,
        status,
        detail,
        findings: findings.length,
      })),
      findings: report.checks.flatMap((c) => c.findings),
      expected: report.expected,
      missing: missing.map((e) => e.id),
    },
    null,
    2,
  )}\n`;
}

const pad = (text: string, width: number) => text.padEnd(width);

export function renderText(report: Report): string {
  const lines: string[] = [];
  lines.push(
    `docs tree: ${report.root ?? "none"}; schema: ${report.schema ?? "none"}; base: ${report.base ?? "none"}`,
    "",
    "Checks",
  );
  for (const check of report.checks)
    lines.push(
      `  ${pad(check.name, 14)}${pad(check.status, 10)}${check.detail}`,
    );
  const files = byFile(report.checks);
  lines.push("", files.size ? "Findings by file" : "Findings by file: none");
  for (const [file, findings] of files) {
    lines.push(`  ${file}`);
    for (const f of findings)
      lines.push(
        `    ${pad(f.severity, 9)}${pad(f.check, 14)}${f.line === undefined ? "" : `line ${f.line}: `}${f.message}`,
      );
  }
  const missing = report.expected.filter((e) => e.found === null);
  lines.push(
    "",
    `Missing documentation (project type ${report.project.type}, from ${report.project.evidence})${missing.length ? "" : ": none"}`,
  );
  for (const e of missing) lines.push(`  ${e.suggested}: ${e.what}`);
  return `${lines.join("\n")}\n`;
}
