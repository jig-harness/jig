/**
 * The decisions block the audit sheet's copy button writes, built in
 * TypeScript. The sheet's script builds the same text in the browser
 * (`script.ts`); a browser test holds the two equal for the same choices, so
 * this is the reference for what `record.ts apply-feedback` reads.
 *
 *   # Jig audit decisions: example/web at 1a2b3c4 (2026-10-13)
 *   audit_feedback:
 *     v: 1
 *     repository: "example/web"
 *     commit: "<the record's full commit>"
 *     report: "<the fingerprint of the report's recommendations>"
 *     profile: team-standard           # only when the reader chose another profile than the record's
 *     accept: [R1, R3]
 *     refine:
 *       - { id: R2, note: "…" }
 *     decline:
 *       - { id: R4, refs: ["M5/…"], reason: "…", revisit_when: "…" }
 *     wrong:
 *       - { id: R5, refs: ["M2/…"], note: "…" }
 *
 * Taking a recommendation's lighter option is a refine whose note names it:
 * `lighter option: <the lighter text>`, then `; <the reader's note>` when
 * there is one. Every text value is written with JSON's string syntax, which
 * is a subset of YAML's double-quoted scalar, so any note reads back
 * unchanged. A list with no entries is left out. Ids follow the report's
 * order.
 */

/** The choices a card offers, in the order it shows them; `lighter` only on a card that has a lighter option. */
export const CHOICES = [
  "accept",
  "lighter",
  "refine",
  "decline",
  "wrong",
] as const;
export type Choice = (typeof CHOICES)[number];

/** How a taken lighter option's note begins. */
export const LIGHTER_PREFIX = "lighter option: ";

export interface Decision {
  choice: Choice;
  note?: string;
  reason?: string;
  revisit_when?: string;
}

export interface FeedbackInput {
  repository: string;
  /** The record's full commit. */
  commit: string;
  /** The fingerprint of the report's recommendations. */
  report: string;
  /** The record's date. */
  date: string;
  /** The profile the record declares, if any. */
  recordProfile?: string;
  recommendations: readonly {
    id: string;
    refs: readonly string[];
    lighter?: string;
  }[];
}

export interface Picks {
  /** The profile the reader chose, if any. */
  profile?: string;
  decisions: Readonly<Record<string, Decision>>;
}

/** The fields a decision needs before it can be copied. */
export type Needed = "reason" | "revisit_when" | "note";

const filled = (s: string | undefined) => (s ?? "").trim() !== "";

/** What a decision still lacks: a decline its reason and its revisit condition, a refine or a wrong its note. */
function needs(d: Decision): Needed[] {
  if (d.choice === "decline")
    return (["reason", "revisit_when"] as const).filter((k) => !filled(d[k]));
  if (d.choice === "refine" || d.choice === "wrong")
    return filled(d.note) ? [] : ["note"];
  return [];
}

/** Every decision that cannot be copied yet, with what it lacks. */
export function missingFields(
  input: FeedbackInput,
  picks: Picks,
): { id: string; needs: Needed[] }[] {
  return input.recommendations.flatMap((r) => {
    const d = picks.decisions[r.id];
    const lacking = d ? needs(d) : [];
    return lacking.length > 0 ? [{ id: r.id, needs: lacking }] : [];
  });
}

const q = (s: string | undefined) => JSON.stringify((s ?? "").trim());
const refsOf = (refs: readonly string[]) => `[${refs.map(q).join(", ")}]`;

/** The note of a refine entry: the reader's own, or the lighter option it takes. */
function refineNote(lighter: string | undefined, d: Decision): string {
  if (d.choice !== "lighter") return d.note ?? "";
  const own = (d.note ?? "").trim();
  return `${LIGHTER_PREFIX}${(lighter ?? "").trim()}${own ? `; ${own}` : ""}`;
}

/** One entry of a refine, decline or wrong list. */
function entry(
  r: FeedbackInput["recommendations"][number],
  d: Decision,
): string {
  if (d.choice === "decline")
    return `    - { id: ${r.id}, refs: ${refsOf(r.refs)}, reason: ${q(d.reason)}, revisit_when: ${q(d.revisit_when)} }`;
  if (d.choice === "wrong")
    return `    - { id: ${r.id}, refs: ${refsOf(r.refs)}, note: ${q(d.note)} }`;
  return `    - { id: ${r.id}, note: ${q(refineNote(r.lighter, d))} }`;
}

/** The list a choice is copied under: a lighter option is a refine. */
const listOf = (choice: Choice) => (choice === "lighter" ? "refine" : choice);

/** The decisions block for the choices made, exactly as the sheet copies it. */
export function feedbackText(input: FeedbackInput, picks: Picks): string {
  const out = [
    `# Jig audit decisions: ${input.repository} at ${input.commit.slice(0, 7)} (${input.date})`,
    "audit_feedback:",
    "  v: 1",
    `  repository: ${q(input.repository)}`,
    `  commit: ${q(input.commit)}`,
    `  report: ${q(input.report)}`,
  ];
  if (picks.profile && picks.profile !== (input.recordProfile ?? ""))
    out.push(`  profile: ${picks.profile}`);
  const chosen = (list: string) =>
    input.recommendations.filter((r) => {
      const d = picks.decisions[r.id];
      return d !== undefined && listOf(d.choice) === list;
    });
  const accepted = chosen("accept");
  if (accepted.length > 0)
    out.push(`  accept: [${accepted.map((r) => r.id).join(", ")}]`);
  for (const list of ["refine", "decline", "wrong"] as const) {
    const rows = chosen(list);
    if (rows.length === 0) continue;
    out.push(`  ${list}:`);
    for (const r of rows) out.push(entry(r, picks.decisions[r.id] as Decision));
  }
  return out.join("\n");
}
