/** `--explain <path>`: each dimension of one file, with the rule that set it. */
import type { AnalyzedFile } from "./analyze.ts";
import { isUnclassified } from "./model.ts";
import { fmt, fmtBytes, visible } from "./render-terminal.ts";
import type { Unreadable } from "./test-runners/index.ts";

export function explainJson(
  file: AnalyzedFile,
  includeVendored: boolean,
  unreadable: readonly Unreadable[] = [],
) {
  const { stats, classification } = file;
  return {
    path: stats.path,
    area: classification.area,
    kind: classification.kind,
    language: classification.language,
    module: classification.module,
    unclassified: isUnclassified(stats),
    countedInTotals: stats.kind !== "vendored" || includeVendored,
    counts: {
      bytes: stats.bytes,
      rawLines: stats.rawLines,
      codeLines: stats.codeLines,
      commentLines: stats.commentLines,
      blankLines: stats.blankLines,
    },
    testRunnersUnreadable: unreadable,
  };
}

export function explainText(
  file: AnalyzedFile,
  includeVendored: boolean,
  unreadable: readonly Unreadable[] = [],
): string {
  const { stats, classification: c } = file;
  const row = (label: string, value: string, rule: string) =>
    `  ${`${label}:`.padEnd(10)}${visible(value)} — ${visible(rule)}`;
  const lines = [
    visible(stats.path),
    row("area", c.area.value, c.area.rule),
    row("kind", c.kind.value, c.kind.rule),
    row("language", c.language.value, c.language.rule),
    row("module", c.module.value, c.module.rule),
    `  ${"counts:".padEnd(10)}${fmtBytes(stats.bytes)}; ${fmt(stats.rawLines)} lines: ${fmt(stats.codeLines)} code, ${fmt(stats.commentLines)} comment, ${fmt(stats.blankLines)} blank`,
  ];
  if (isUnclassified(stats)) {
    const reasons = [
      ...(stats.kind === "other" ? ["no kind rule matched"] : []),
      ...(stats.areaMatched ? [] : ["no area rule matched"]),
    ];
    lines.push(
      `  Unclassified: ${reasons.join(", and ")}. Set code_stats.areas or code_stats.kinds to classify it.`,
    );
  }
  if (stats.kind === "vendored" && !includeVendored)
    lines.push(
      "  Left out of the totals: vendored (--include-vendored counts it).",
    );
  for (const u of unreadable)
    lines.push(
      `  Test runner ${visible(u.reader)}: unreadable: ${visible(u.path)} (${visible(u.why)}); nothing is claimed from it.`,
    );
  return `${lines.join("\n")}\n`;
}
