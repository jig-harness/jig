/**
 * A structured answer checked against its park before it is written: the
 * option `--approve` or `--choose` names, found by the same normalizing the
 * readers use (`shared/decisions/answer-normalize.ts`), its line as the park
 * spells the option and with the framing's digest, and proof that the
 * readers' one parser (`answer-forms.ts`) reads the comment back as that
 * choice. A choice the readers would read as anything else is refused, so
 * what a send writes is what every reader counts.
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
  answerDecision,
  parseAnswerComment,
} from "../../skills/drive-pr/scripts/lib/answer-forms.ts";
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

/** The option `form` names among `item`'s, or why it names none. */
function optionOf(
  item: ParkedItem,
  form: StructuredForm,
): Outcome<{ option: ParkedOption; recommended: boolean }, "refused"> {
  const decision = answerDecision(item);
  if (decision === undefined)
    return refusedHere(
      `${item.key} was parked with no framed decision, so it offers no option to approve or choose; answer it in your own words: answer ${item.key} '<your answer>'`,
    );
  const { options, recommended } = decision.call;
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
  // Read the comment back as the readers will, by a trusted author after the park.
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
  const read = parseAnswerComment(
    item,
    { author: login, association: "OWNER", at, url: "", body },
    "conversation",
  )?.choice;
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
