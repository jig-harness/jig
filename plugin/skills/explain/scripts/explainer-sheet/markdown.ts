/**
 * The markdown projection of an explainer source: the same
 * content as the sheet, in the same order, as text for a tracker comment, a
 * chat or a document. It adds only the labels in `labels.ts`; every other
 * word comes from the source. A `{step:N}` token is written as "step N".
 * Figures are named with their caption and diagram source; the drawing
 * itself is in the sheet only.
 */
import { code, href, lit } from "../../../decide/scripts/sheet-kit/markdown.ts";
import { LABEL, SHEET_FILENAME_SUFFIX } from "./labels.ts";
import { type ExplainerSource, plainText } from "./source.ts";

const text = (value: string) => lit(plainText(value));
const cited = (value: string, source: string) =>
  `${text(value)} *${LABEL.source}* ${code(source)}`;

export function renderMarkdown(source: ExplainerSource): string {
  const md: string[] = [`# ${lit(source.title)}`, ""];
  let head = `**${LABEL.factsVerified}:** ${source.verifiedAt.date} @ ${source.verifiedAt.commit}.`;
  if (source.related?.length)
    head += ` **${LABEL.related}:** ${source.related
      .map((r) => `[${lit(r.text)}](${href(r.url)})`)
      .join(", ")}`;
  md.push(head, "");

  md.push(`## ${LABEL.inShort}`, "", text(source.summary), "");
  md.push(
    `**${LABEL.covers}:**`,
    "",
    ...source.scope.covers.map((x) => `- ${text(x)}`),
    "",
  );
  if (source.scope.excludes?.length)
    md.push(
      `**${LABEL.excludes}:**`,
      "",
      ...source.scope.excludes.map((x) => `- ${text(x)}`),
      "",
    );

  for (const f of source.figures ?? [])
    md.push(
      `## ${LABEL.figure}`,
      "",
      `**${lit(f.title)}.** ${text(f.caption)} *${LABEL.diagramSource}* ${code(f.diagram)}`,
      "",
    );

  if (source.flow?.length)
    md.push(
      `## ${LABEL.flow}`,
      "",
      ...source.flow.map(
        (s) =>
          `- **${lit(s.id)}. ${lit(s.title)}.** ${cited(s.text, s.source)}`,
      ),
      "",
    );

  for (const s of source.sections) {
    md.push(`## ${lit(s.title)}`, "");
    if (s.intro) md.push(text(s.intro), "");
    md.push(...s.claims.map((c) => `- ${cited(c.text, c.source)}`), "");
  }

  if (source.openQuestions?.length)
    md.push(
      `## ${LABEL.openQuestions}`,
      "",
      ...source.openQuestions.map((q) => `- ${text(q)}`),
      "",
    );
  if (source.terms?.length)
    md.push(
      `## ${LABEL.terms}`,
      "",
      ...source.terms.map((t) => `- **${lit(t.term)}:** ${lit(t.meaning)}`),
      "",
    );
  return `${md.join("\n").trimEnd()}\n`;
}

export const sheetFilename = (source: ExplainerSource) =>
  `${source.id}${SHEET_FILENAME_SUFFIX}`;
