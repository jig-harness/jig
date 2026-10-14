/**
 * The principles: the index's one-liners (principles/README.md) and
 * each principle's statement, why and consequences.
 */
import { tableRows } from "../source.ts";

export interface Principle {
  /** `3` */
  n: string;
  title: string;
  oneLiner: string;
  /** The opening statement, Markdown. */
  statement: string;
  why: string;
  /** The consequences section's own label ("Consequences", or a longer one). */
  consequencesLabel: string;
  consequences: string;
}

/** The index's one-liner per principle number. */
export function parsePrincipleIndex(readme: string): Map<string, string> {
  return new Map(
    tableRows(readme).map(([n = "", , oneLiner = ""]) => [n, oneLiner]),
  );
}

export function parsePrinciple(markdown: string, oneLiner = ""): Principle {
  const head = /^# (\d+) — (.+)$/m.exec(markdown);
  const body = head ? markdown.slice((head.index ?? 0) + head[0].length) : "";
  const whyAt = body.indexOf("**Why.**");
  const consAt = body.search(/\*\*Consequences/);
  const cut = [whyAt, consAt].filter((x) => x >= 0).sort((a, b) => a - b);
  const until = (from: number) => cut.find((c) => c > from) ?? body.length;
  const consLabel =
    consAt >= 0
      ? (/^\*\*(Consequences[^*]*?):?\*\*/.exec(body.slice(consAt))?.[1] ??
        "Consequences")
      : "";
  return {
    n: head?.[1] ?? "",
    title: head?.[2]?.trim() ?? "",
    oneLiner,
    statement: body.slice(0, cut[0] ?? body.length).trim(),
    why:
      whyAt >= 0
        ? body.slice(whyAt, until(whyAt)).replace("**Why.**", "").trim()
        : "",
    consequencesLabel: consLabel.replace(/:$/, ""),
    consequences:
      consAt >= 0
        ? body
            .slice(consAt, until(consAt))
            .replace(/^\*\*Consequences[^*]*\*\*/, "")
            .trim()
        : "",
  };
}
