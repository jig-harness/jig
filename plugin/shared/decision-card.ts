/**
 * A parked decision as a person picks an answer to it: the number each option
 * carries on a card, whether picking an option needs a second step before it
 * is committed, the answer lines a pick or a person's own words become, and
 * the choice a reader finds in an answer's words. `jig ask` numbers options
 * with the same function once it shows them.
 *
 * A number is the option's place on the card: the recommended option is
 * always 1 and the others follow in the decision's order, so `1` means "the
 * recommendation" on every card. A number never reaches a comment: a pick is
 * written as `approve` or `choose <option>`, with the framing's digest,
 * because a number means nothing outside the order it was shown in.
 *
 * Pure functions with no `node:` import: the dashboard's page bundles it.
 */
import { listedActOfClass } from "./acts.ts";
import { splitAnswerDigest } from "./decisions/answer-digest.ts";
import { normalizeAnswerText } from "./decisions/answer-normalize.ts";

/** An option the card numbers: only whether it is the recommended one matters here. */
export interface NumberableOption {
  recommended: boolean;
}

/** An option with its number on the card, from 1. */
export interface NumberedOption<O> {
  number: number;
  option: O;
}

/**
 * The options in the order a card shows them, each with its number: the
 * recommended option first as 1, then the others in the decision's order.
 * A decision that recommends no single option keeps its own order, so no
 * option is shown as 1 for a recommendation the decision did not make.
 */
export function numberOptions<O extends NumberableOption>(
  options: readonly O[],
): NumberedOption<O>[] {
  const recommended = options.filter((o) => o.recommended);
  const ordered =
    recommended.length === 1
      ? [...recommended, ...options.filter((o) => o !== recommended[0])]
      : [...options];
  return ordered.map((option, i) => ({ number: i + 1, option }));
}

/**
 * Whether committing a pick of `option` under `decisionClass` takes two
 * steps: the class is not one the acts table lists as Decide by name (an
 * Authorize class, or a repository's own class, which reads Decide only as
 * a fallback), or the option is marked as one that cannot be undone.
 */
export function isGuardedPick(
  decisionClass: string | null | undefined,
  option: { reversible?: boolean },
): boolean {
  return (
    listedActOfClass(decisionClass) !== "Decide" || option.reversible === false
  );
}

/** The option a structured answer chooses, and the form that chose it. */
export interface WrittenChoice {
  option: string;
  form: "approve" | "choose";
}

/** A structured answer's text: its form, and the framing's digest when there is one. */
export function structuredAnswerText(
  choice: WrittenChoice,
  digest: string | undefined,
): string {
  const form =
    choice.form === "approve" ? "approve" : `choose ${choice.option}`;
  return digest === undefined ? form : `${form} [${digest}]`;
}

/** The line the re-arm reads. */
export function answerLine(key: string, text: string): string {
  return `answer ${key}: ${text.trim()}`;
}

/** The line that narrows a structured answer with the person's own words. */
export function noteLine(key: string, note: string): string {
  return `note ${key}: ${note.trim()}`;
}

/** What a person's answer to one decision is, as the card commits it. */
export type CardAnswer =
  | {
      kind: "pick";
      option: string;
      /** Whether the option is the one the decision recommends, written as `approve`. */
      recommended: boolean;
      note?: string;
    }
  | { kind: "free"; text: string };

/** The text of an answer line for `answer`: a pick's form, or the person's words, each with the digest when there is one. */
export function cardAnswerText(
  answer: CardAnswer,
  digest: string | undefined,
): string {
  if (answer.kind === "pick")
    return structuredAnswerText(
      {
        option: answer.option,
        form: answer.recommended ? "approve" : "choose",
      },
      digest,
    );
  const text = answer.text.trim();
  return digest === undefined ? text : `${text} [${digest}]`;
}

/**
 * The lines that answer one decision: its answer line, and a pick's note
 * line beside it when the note holds words.
 */
export function cardAnswerLines(
  key: string,
  answer: CardAnswer,
  digest: string | undefined,
): string[] {
  const lines = [answerLine(key, cardAnswerText(answer, digest))];
  if (answer.kind === "pick" && (answer.note ?? "").trim() !== "")
    lines.push(noteLine(key, answer.note ?? ""));
  return lines;
}

/**
 * One comment that answers several decisions of one pull request: each
 * decision's lines, a blank line between decisions. The readers drop blank
 * lines, so the comment stays one answer per decision.
 */
export function cardComment(
  answers: ReadonlyArray<{
    key: string;
    digest?: string;
    answer: CardAnswer;
  }>,
): string {
  return answers
    .map((a) => cardAnswerLines(a.key, a.answer, a.digest).join("\n"))
    .join("\n\n");
}

/**
 * The option an answer's text names as a structured form, after its digest
 * is taken off and it is normalized: `approve` names the recommended option
 * and `choose <option>` the option of that name. `null` when the text is not
 * exactly one form, or names no single option, so it reads as free. The
 * drive's readers and the dashboard read an answer through this one function.
 */
export function choiceInText<O extends { name: string }>(
  text: string,
  options: readonly O[],
  isRecommended: (option: O) => boolean,
): { option: O; form: WrittenChoice["form"] } | null {
  const normalized = normalizeAnswerText(text);
  const form =
    normalized === "approve"
      ? "approve"
      : normalized.startsWith("choose ")
        ? "choose"
        : null;
  if (form === null) return null;
  const matches =
    form === "approve"
      ? options.filter(isRecommended)
      : options.filter(
          (o) => normalizeAnswerText(o.name) === normalized.slice(7),
        );
  const [option] = matches;
  return matches.length === 1 && option !== undefined ? { option, form } : null;
}

/** The option an answer line's whole text names, its trailing digest taken off first, as a reader reads it. */
export function choiceInLine<O extends { name: string }>(
  text: string,
  options: readonly O[],
  isRecommended: (option: O) => boolean,
): { option: O; form: WrittenChoice["form"] } | null {
  return choiceInText(splitAnswerDigest(text).text, options, isRecommended);
}
