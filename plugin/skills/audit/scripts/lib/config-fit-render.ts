import { lit } from "../../../decide/scripts/sheet-kit/markdown.ts";
import {
  escapeDisplayChar,
  isInvisibleDisplayChar,
} from "../../../../shared/config-layers.ts";
import type { FitReport } from "../config-fit.ts";

const SECTIONS: [FitReport["findings"][number]["severity"], string][] = [
  ["error", "Errors"],
  ["warning", "Warnings"],
  ["suggestion", "Suggestions"],
  ["info", "Information"],
];

const NAMED_ESCAPES: Record<string, string> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

function factText(value: string): string {
  const chars = [...value];
  let start = 0;
  let end = chars.length;
  while (start < end && factCharEdge(chars[start] ?? "")) start++;
  while (end > start && factCharEdge(chars[end - 1] ?? "")) end--;
  let out = "";
  let escaped = value.startsWith('"');
  chars.forEach((char, index) => {
    const hidden =
      index < start || index >= end || isInvisibleDisplayChar(char);
    escaped ||= hidden;
    out += escapeFactChar(char, hidden);
  });
  return escaped ? `"${out}"` : value;
}

function factCharEdge(char: string): boolean {
  return /\s/u.test(char) || isInvisibleDisplayChar(char);
}

function escapeFactChar(char: string, hidden: boolean): string {
  if (!hidden) return char === "\\" || char === '"' ? `\\${char}` : char;
  return NAMED_ESCAPES[char] ?? escapeDisplayChar(char);
}

export function render(report: FitReport): string {
  const lines = [`# Configuration fit: ${report.file}`, ""];
  if (!report.configured)
    lines.push("The repository has no configuration file.", "");
  lines.push(`Forge: ${report.forge}.`, "");
  const facts = Object.entries(report.facts);
  if (facts.length > 0) {
    lines.push(
      "## Facts",
      "",
      ...facts.map(([k, v]) => `- ${k}: ${lit(factText(String(v)))}`),
      "",
    );
  }
  for (const [severity, title] of SECTIONS) {
    const rows = report.findings.filter((f) => f.severity === severity);
    if (rows.length === 0) continue;
    lines.push(`## ${title} (${rows.length})`, "");
    for (const f of rows) lines.push(`- \`config/${f.id}\`: ${lit(f.message)}`);
    lines.push("");
  }
  lines.push(...closingSections(report));
  if (report.findings.every((f) => f.severity === "info"))
    lines.push("Nothing to fix.", "");
  return lines.join("\n");
}

function closingSections(report: FitReport): string[] {
  const lines: string[] = [];
  if (report.declined.length > 0)
    lines.push(
      `## Declined (${report.declined.length})`,
      "",
      ...report.declined.map(
        (d) =>
          `- \`config/${d.finding.id}\`: ${d.reason} Revisit when: ${d.revisit_when}`,
      ),
      "",
    );
  if (report.draft !== undefined)
    lines.push(
      "## Starter configuration",
      "",
      "```yaml",
      report.draft.trimEnd(),
      "```",
      "",
    );
  return lines;
}
