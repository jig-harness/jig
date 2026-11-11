/**
 * A structured answer checked against its park before it is written: the
 * option `--approve` or `--choose` names, found by the same normalizing the
 * readers use (`shared/decisions/answer-normalize.ts`), its line as the park
 * spells the option and with the framing's digest, and proof that the
 * readers' one parser (`answer-forms.ts`) reads the comment back as that
 * choice. A choice the readers would read as anything else is refused, so
 * what a send writes is what every reader counts. A park that offers no
 * option is refused with why (`decisionReading`): it was parked before
 * framing, its decision record does not read, or the record names no
 * single recommendation, where the readers read every answer as free.
 * The same read-back refuses a person's own words that the readers would
 * count as a choice (`freeChoiceFault`).
 */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { normalizeAnswerText } from "../../shared/decisions/answer-normalize.ts";
import { answerTextFault } from "../../shared/decisions/answer-text.ts";
import { optionDetails } from "../../shared/decisions/model.ts";
import type { ParkedOption } from "../../shared/decisions/park.ts";
import { localWriter } from "../../shared/records/writer.ts";
import {
  answerComment,
  type StructuredParts,
  structuredAnswerText,
} from "../../skills/drive-pr/scripts/lib/answer-comment.ts";
import {
  decisionReading,
  parseAnswerComment,
} from "../../skills/drive-pr/scripts/lib/answer-forms.ts";
import type { AnswerChoice } from "../../skills/drive-pr/scripts/lib/state/pass-handoff.ts";
import type { ParkedItem } from "../../skills/drive-pr/scripts/lib/state/park-frame.ts";

/** A structured form, as the person named it. */
export type StructuredForm =
  | { kind: "approve" }
  | { kind: "choose"; option: string };

export interface Resolved {
  option: ParkedOption;
  recommended: boolean;
  /** The answer line's text: the form, and the digest when the park has one. */
  text: string;
  parts: StructuredParts;
}

const refusedHere = (reason: string) => failed("refused", reason);

/** Why `item` offers no option a structured answer can name. */
function noDecision(
  item: ParkedItem,
  reading: Exclude<ReturnType<typeof decisionReading>, { decision: unknown }>,
): string {
  const instead = `answer it in your own words: answer ${item.key} '<your answer>'`;
  if ("problems" in reading)
    return `${item.key}'s decision record does not read (${reading.problems.join("; ")}), so the drive's readers read every answer to it as free; ${instead}`;
  return reading.none === "unframed"
    ? `${item.key} was parked with no framed decision, so it offers no option to approve or choose; ${instead}`
    : `${item.key}'s decision record names no single recommended option, so the drive's readers read every answer to it, a choice included, as free; ${instead}`;
}

/** A comment `login` writes answering `item` with `text`, read back as the readers will: by a trusted author after the park. */
function readBack(
  item: ParkedItem,
  text: string,
  login: string,
  parts?: StructuredParts,
): AnswerChoice | undefined {
  const at = new Date(
    Math.max(Date.now(), Date.parse(item.at ?? "") + 1000 || 0),
  ).toISOString();
  const body = answerComment(
    item.key,
    text,
    0,
    localWriter("forge", login),
    at,
    parts,
  );
  return parseAnswerComment(
    item,
    { author: login, association: "OWNER", at, url: "", body },
    "conversation",
  )?.choice;
}

/**
 * Why the person's own words to `item` are not sent as a free answer: the
 * readers would count them as a choice (`approve`, `choose <option>`, in any
 * spelling the normalizer folds), which the send writes only through
 * `--approve` or `--choose`, bound to the framing the person read; `null`
 * when they read as free.
 */
export function freeChoiceFault(
  item: ParkedItem,
  text: string,
  login: string,
): string | null {
  const read = readBack(item, text, login);
  return read === undefined
    ? null
    : `the drive's readers would count "${text}" as choosing ${read.option}, which jig send writes only bound to the framing you read: send it as --approve or --choose with --decision, after a --dry-run shows the option and its digest`;
}

/** The option `form` names among `item`'s, or why it names none. */
function optionOf(
  item: ParkedItem,
  form: StructuredForm,
): Outcome<{ option: ParkedOption; recommended: boolean }, "refused"> {
  const reading = decisionReading(item);
  if (!("decision" in reading)) return refusedHere(noDecision(item, reading));
  const { options, recommended } = reading.decision.call;
  const names = options.map((o) => o.name).join(", ");
  const matches =
    form.kind === "approve"
      ? options.filter((o) => o.id === recommended)
      : options.filter(
          (o) =>
            normalizeAnswerText(o.name) === normalizeAnswerText(form.option),
        );
  const option = matches.length === 1 ? matches[0] : undefined;
  if (option === undefined)
    return refusedHere(
      form.kind === "approve"
        ? `${item.key}'s decision names no recommendation to approve; choose one of its options: ${names}`
        : `--choose ${form.option} names no option of ${item.key}; its options are ${names}`,
    );
  return ok({ option, recommended: option.id === recommended });
}

/**
 * The structured answer `form` (with `note`) makes to `item`, written as
 * `login`, or why it is not sent. The digest written is the park's own;
 * whether the person read it is the caller's check.
 */
export function resolveChoice(
  item: ParkedItem,
  form: StructuredForm,
  note: string | undefined,
  login: string,
): Outcome<Resolved, "refused"> {
  const found = optionOf(item, form);
  if (!found.ok) return found;
  const { option, recommended } = found.value;
  const choice = {
    option: option.name,
    form: form.kind === "approve" ? ("approve" as const) : ("choose" as const),
  };
  const text = structuredAnswerText(choice, item.digest);
  const fault = answerTextFault(text);
  if (fault !== null)
    return refusedHere(`the answer line cannot be written: ${fault}`);
  const parts: StructuredParts = {
    choice,
    ...(item.digest === undefined ? {} : { decision: item.digest }),
    ...(note === undefined ? {} : { note }),
  };
  const read = readBack(item, text, login, parts);
  if (
    read === undefined ||
    read.option !== option.name ||
    read.form !== choice.form ||
    read.note !== note
  )
    return refusedHere(
      `the drive's readers would not read this answer as choosing ${option.name}, so it is not sent; answer ${item.key} in your own words instead`,
    );
  return ok({ option, recommended, text, parts });
}

/** An option in full, as a person reads it before choosing: its name, what it changes and what it costs. */
export function optionInFull(
  option: ParkedOption,
  recommended: boolean,
): string {
  return [
    `${option.name}${recommended ? " (the recommended option)" : ""}`,
    `Changes: ${option.summary}`,
    `Costs: ${option.pay.join(" ")}`,
    ...optionDetails(option).map((d) => `${d.label}: ${d.text}`),
  ].join("\n");
}

/** `word` as one shell argument. */
export function shellWord(word: string): string {
  return /^[\w@#%+=:,./-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", `'\\''`)}'`;
}
