/**
 * Markdown projections of a decision source.
 *
 * - `renderElaboration` is the full text with the content of the
 *   human-call-elaboration format (`references/human-call-elaboration.md`
 *   § Format): every option with keep, pay, right-when and obligation, plus the
 *   outcome matrix as a table. Its headings are fixed, because it is a
 *   generated reference document; the format's length discipline governs
 *   hand-written text.
 * - `renderComment` is the short tracker comment that goes with an attached
 *   sheet. Measured on five real decisions, the full text runs 2,000 to 4,000
 *   words, too long for a comment. So the comment carries the
 *   overview only, and every option and its costs live in the sheet.
 *
 * Both projections add only the labels in `labels.ts`. Every other word comes
 * from the source.
 */

import { cell, code, href, lit } from "../sheet-kit/markdown.ts";
import { issueFileStem } from "../sheet-kit/source.ts";
import {
  COMMENT,
  LABEL,
  OUTCOME_ICON,
  OUTCOME_WORD,
  SHEET_FILENAME_SUFFIX,
} from "./labels.ts";
import { plainSource } from "./refs.ts";
import {
  type Call,
  type DecisionSource,
  decisionStatus,
  facetLabel,
  headlineOwners,
  optionName,
  sentence,
} from "./source.ts";

const owners = (facets: readonly string[]) => facets.map(facetLabel).join(", ");

function callHeading(call: Call): string {
  return call.title ? `(${call.id}) ${lit(call.title)}` : LABEL.options;
}

function matrixTable(call: Call): string[] {
  const scenarios = call.scenarios ?? [];
  if (scenarios.length === 0) return [];
  const lines = [
    `| ${LABEL.option} | ${scenarios.map((s) => `${cell(s.label)}: ${cell(s.detail)}`).join(" | ")} |`,
    `| --- | ${scenarios.map(() => "---").join(" | ")} |`,
  ];
  for (const o of call.options) {
    const cells = scenarios.map((s) => {
      const outcome = o.outcomes?.[s.id];
      if (!outcome)
        throw new Error(
          `call ${call.id} option ${o.id}: no outcome for scenario ${s.id}`,
        );
      return `${OUTCOME_ICON[outcome.kind]} ${OUTCOME_WORD[outcome.kind]}: ${cell(outcome.text)}`;
    });
    lines.push(`| ${o.id}. ${cell(o.name)} | ${cells.join(" | ")} |`);
  }
  const meanings = Object.entries(call.outcomeMeaning ?? {}).map(
    ([kind, meaning]) =>
      `${OUTCOME_ICON[kind as keyof typeof OUTCOME_ICON]} ${OUTCOME_WORD[kind as keyof typeof OUTCOME_WORD]}: ${lit(meaning)}`,
  );
  return [
    "",
    ...lines,
    "",
    ...(meanings.length ? meanings.map((m) => `- ${m}`).concat("") : []),
  ];
}

function verdictLine(call: Call): string[] {
  if (call.ruling)
    return [
      `**${LABEL.decided} ${call.ruling.option}. ${sentence(lit(optionName(call, call.ruling.option)))}** ${LABEL.ruledOn} ${call.ruling.ruledAt}. [${LABEL.rulingRecord}](${href(call.ruling.recordUrl)})`,
      "",
    ];
  const out: string[] = [];
  if (call.recommended)
    out.push(
      `**${LABEL.recommendation}: ${call.recommended}. ${sentence(lit(optionName(call, call.recommended)))}** ${lit(call.why ?? "")}`,
      "",
    );
  if (call.openInput)
    out.push(`**${LABEL.openInput}** ${lit(call.openInput)}`, "");
  return out;
}

function optionMark(call: Call, id: string): string {
  if (call.ruling) return call.ruling.option === id ? ` (${LABEL.chosen})` : "";
  return call.recommended === id ? ` (${LABEL.recommended})` : "";
}

function callSection(call: Call, level: "##" | "###"): string[] {
  const sub = level === "##" ? "###" : "####";
  const out = [`${level} ${callHeading(call)}`, ""];
  if (call.question) out.push(lit(call.question), "");
  if (call.facts?.length)
    out.push(
      ...call.facts.map(
        (f) => `- ${lit(f.text)} *${LABEL.source}* ${code(f.source)}`,
      ),
      "",
    );
  out.push(...matrixTable(call));
  for (const o of call.options) {
    out.push(
      `${sub} ${o.id}. ${lit(o.name)}${o.tag ? ` (${lit(o.tag)})` : ""}${optionMark(call, o.id)}`,
      "",
      lit(o.summary),
      "",
    );
    out.push(
      `- **${LABEL.keep}:** ${lit(o.keep.join(" "))}`,
      `- **${LABEL.pay}:** ${lit(o.pay.join(" "))}`,
      `- **${LABEL.rightWhen}:** ${lit(o.rightWhen)}`,
    );
    if (o.obligation)
      out.push(`- **${LABEL.obligation}:** ${lit(o.obligation)}`);
    out.push("");
  }
  for (const s of call.subQuestions ?? []) {
    out.push(
      `**${sentence(s.title ? lit(s.title) : LABEL.followOn)}** ${lit(s.question)}`,
      "",
    );
    for (const o of call.options)
      out.push(
        `- ${LABEL.ifYouChoose} ${o.id}: ${lit(s.byOption[o.id] ?? "")}`,
      );
    out.push("");
  }
  for (const note of call.notes ?? [])
    out.push(`**${LABEL.notes}.** ${lit(note)}`, "");
  out.push(...verdictLine(call));
  return out;
}

function header(source: DecisionSource): string[] {
  return [
    `**${LABEL.owners}:** ${owners(headlineOwners(source))}. **${LABEL.status}:** ${decisionStatus(source)}. **${LABEL.priority}:** ${sentence(lit(source.priority))}`,
    "",
    `**${LABEL.reversibility}:** ${lit(source.reversibility)}`,
    "",
  ];
}

function hiddenBranches(source: DecisionSource, withText: boolean): string[] {
  if (!source.hiddenBranches?.length) return [];
  return [
    `## ${LABEL.hiddenBranches}`,
    "",
    ...source.hiddenBranches.map(
      (h, i) =>
        `${i + 1}. **${sentence(lit(h.title))}** ${withText ? `${lit(h.text)} ` : ""}*${LABEL.nextStep}* ${lit(h.action)}`,
    ),
    "",
  ];
}

function callTable(source: DecisionSource): string[] {
  const rows = source.calls.map((c) => {
    const status = c.ruling
      ? `${LABEL.decided} ${c.ruling.option}. ${sentence(cell(optionName(c, c.ruling.option)))} [${LABEL.rulingRecord}](${href(c.ruling.recordUrl)})`
      : c.recommended
        ? `**${c.recommended}. ${sentence(cell(optionName(c, c.recommended)))}** ${cell(c.why ?? "")}`
        : LABEL.open;
    return `| (${c.id}) ${cell(c.title ?? "")} | ${owners(c.owners ?? source.owners)} | ${status} |`;
  });
  return [
    `## ${LABEL.calls}`,
    "",
    `| ${LABEL.call} | ${LABEL.owners} | ${LABEL.status} |`,
    "| --- | --- | --- |",
    ...rows,
    "",
  ];
}

function interplay(source: DecisionSource): string[] {
  if (!source.interplay?.length) return [];
  return [
    `## ${LABEL.interplay}`,
    "",
    ...source.interplay.map(
      (x) => `- **${lit(x.from)} → ${lit(x.to)}:** ${lit(x.text)}`,
    ),
    "",
  ];
}

function myRead(source: DecisionSource): string[] {
  return source.calls.some((c) => !c.ruling)
    ? [`**${LABEL.myRead}.** ${lit(source.myRead)}`, ""]
    : [];
}

/** A reference token (`{opt:3}`) reads as plain words here: `option 3`. */
export function renderElaboration(source: DecisionSource): string {
  return elaboration(plainSource(source));
}

function elaboration(source: DecisionSource): string {
  const multi = source.calls.length > 1;
  const md = [
    `# ${source.id}: ${lit(source.title)}`,
    "",
    ...header(source),
    lit(source.question),
    "",
  ];
  md.push(
    `## ${LABEL.currentBehaviour}`,
    "",
    ...source.currentBehaviour.map(
      (f) => `- ${lit(f.text)} *${LABEL.source}* ${code(f.source)}`,
    ),
    "",
  );
  if (source.settled?.length)
    md.push(
      `## ${LABEL.settled}`,
      "",
      ...source.settled.map(
        (f) => `- ${lit(f.text)} *${LABEL.source}* ${code(f.source)}`,
      ),
      "",
    );
  md.push(...hiddenBranches(source, true));
  if (multi) md.push(...callTable(source));
  for (const call of source.calls) md.push(...callSection(call, "##"));
  md.push(...interplay(source), ...myRead(source));
  if (source.glossary?.length)
    md.push(
      `## ${LABEL.terms}`,
      "",
      ...source.glossary.map((g) => `- **${lit(g.term)}:** ${lit(g.meaning)}`),
      "",
    );
  md.push(
    `*${LABEL.factsVerified} ${source.verifiedAt.date} @ ${source.verifiedAt.commit}.*`,
    "",
  );
  return md.join("\n");
}

export function sheetFilename(source: DecisionSource): string {
  return `${issueFileStem(source.id)}${SHEET_FILENAME_SUFFIX}`;
}

/**
 * The short comment posted with the attached sheet. Its first paragraph is a
 * fixed text that points at the attachment, because a tracker such as Linear
 * serves an attachment as a download and a reader must know to open it in a browser.
 */
export function renderComment(source: DecisionSource): string {
  return comment(plainSource(source));
}

function comment(source: DecisionSource): string {
  const sheets =
    source.calls.length === 1 ? COMMENT.oneSheet : COMMENT.allCalls;
  const md = [
    `**${COMMENT.attached} ${code(sheetFilename(source))}.** ${sheets} ${COMMENT.open} ${COMMENT.overview} ${LABEL.factsVerified} ${source.verifiedAt.date} @ ${source.verifiedAt.commit}.`,
    "",
    ...header(source),
    lit(source.question),
    "",
    ...hiddenBranches(source, false),
  ];
  if (source.calls.length > 1) {
    md.push(...callTable(source));
  } else {
    const call = source.calls[0] as Call;
    md.push(
      `## ${LABEL.options}`,
      "",
      ...call.options.map(
        (o) =>
          `- **${o.id}. ${lit(o.name)}**${optionMark(call, o.id)}: ${lit(o.summary)}`,
      ),
      "",
    );
    md.push(...verdictLine(call));
  }
  const open = source.calls.filter((c) => c.openInput && !c.ruling);
  if (source.calls.length > 1 && open.length)
    md.push(
      `## ${LABEL.openInput.replace(/:$/, "")}`,
      "",
      ...open.map((c) => `- (${c.id}) ${lit(c.openInput ?? "")}`),
      "",
    );
  md.push(...interplay(source), ...myRead(source));
  return `${md.join("\n").trimEnd()}\n`;
}
