/**
 * How every reader of a parked decision shows its options and the answers
 * it has: `jig ask --thread`, the tick's line and the dashboard read through
 * these, so for one park they show the same numbers and the same choice
 * (design/structured-answers.md § Showing what was decided). Pure, with no
 * `node:` import, so the dashboard's page bundles it.
 */

/** An option's place on a card: the recommended option is 1, the others follow in the decision's order. */
export function optionNumbers<T extends { recommended: boolean }>(
  options: readonly T[],
): Array<T & { number: number }> {
  const order = [
    ...options.filter((o) => o.recommended),
    ...options.filter((o) => !o.recommended),
  ];
  return options.map((o) => ({ ...o, number: order.indexOf(o) + 1 }));
}

/** An answer as the drive's reader classified it (`PendingAnswer`, less what a view does not show). */
export interface ReadAnswer {
  author: string;
  at: string;
  url: string;
  /** The framing digest the answer named. */
  digest?: string;
  stale?: true;
  choice?: {
    option: string;
    recommended: boolean;
    form: "approve" | "choose";
    note?: string;
  };
}

/** What one answer chose: an option with its note, a free answer, or a stale one with the digest it named. */
export interface ShownAnswer {
  author: string;
  at: string;
  url: string;
  choice?: {
    option: string;
    recommended: boolean;
    form: "approve" | "choose";
  };
  note?: string;
  free?: true;
  stale?: { digest: string };
}

/** Why a waiting decision's answers do not settle it. */
export type AnswerState = "stale" | "disputed";

export function answerView(a: ReadAnswer): ShownAnswer {
  const head = { author: a.author, at: a.at, url: a.url };
  if (a.stale === true) return { ...head, stale: { digest: a.digest ?? "" } };
  if (a.choice === undefined) return { ...head, free: true };
  const { option, recommended, form, note } = a.choice;
  return {
    ...head,
    choice: { option, recommended, form },
    ...(note === undefined ? {} : { note }),
  };
}

/** One answer in words, the same on every surface. */
export function answerWords(v: ShownAnswer): string {
  if (v.stale !== undefined)
    return `@${v.author} answered an earlier framing (${v.stale.digest === "" ? "no digest" : v.stale.digest}), a stale answer`;
  if (v.choice === undefined) return `@${v.author} wrote a free answer`;
  const which = v.choice.recommended ? " (the recommended option)" : "";
  const note = v.note === undefined ? "" : `, with the note: ${v.note}`;
  return `@${v.author} chose ${v.choice.option}${which}${note}`;
}

/** What a waiting decision's answers say, in one line; `null` when it has none. */
export function answerStateWords(
  state: AnswerState | undefined,
  answers: readonly ShownAnswer[],
): string | null {
  if (answers.length === 0) return null;
  const said = answers.map(answerWords).join("; ");
  if (state === "disputed")
    return `Disputed, so it waits until the people answering agree: ${said}.`;
  if (state === "stale")
    return `Stale, so it waits for an answer to the current framing: ${said}.`;
  return `${said}.`;
}
