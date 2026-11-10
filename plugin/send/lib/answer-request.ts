/**
 * The arguments of `answer`, parsed: one parked key and the person's words
 * (`answer <key> <text>`), one key and a structured form
 * (`answer <key> --approve` or `--choose '<option>'`, with `--note '<text>'`
 * and the digest the person read, `--decision <digest>`), or every eligible
 * item at once (`answer --all --approve`, with the dry run's set token,
 * `--decision-set <token>`). Exactly one form names the answer; a send that
 * names none, or two, is a usage error, as are the flags of one form beside
 * another's. What the park offers is checked when it is read (`answer.ts`,
 * `answer-all.ts`), never here.
 */
import { isDecisionDigest } from "../../shared/decisions/digest.ts";
import {
  answerKeyFault,
  answerTextFault,
} from "../../skills/drive-pr/scripts/lib/answer-comment.ts";

/** The answer flags `jig send` takes, as its command line parsed them. */
export interface AnswerFlags {
  approve: boolean;
  choose?: string | undefined;
  note?: string | undefined;
  all: boolean;
  decision?: string | undefined;
  decisionSet?: string | undefined;
}

/** How one answer names what it chooses. */
export type AnswerForm =
  | { kind: "free"; text: string }
  | { kind: "approve" }
  | { kind: "choose"; option: string };

export type AnswerRequest =
  | {
      verb: "answer";
      all: false;
      key: string;
      form: AnswerForm;
      note?: string;
      decision?: string;
    }
  | { verb: "answer"; all: true; decisionSet?: string };

/** The arguments `answer` takes, as a usage error names them. */
export const ANSWER_ARGS =
  "<key> <text> | <key> --approve|--choose <option> [--note <text>] [--decision <digest>] | --all --approve [--decision-set <token>]";

/** The flags set, by name, for a usage error that refuses them. */
export function answerFlagsSet(flags: AnswerFlags): string[] {
  return [
    flags.approve ? "--approve" : null,
    flags.choose === undefined ? null : "--choose",
    flags.note === undefined ? null : "--note",
    flags.all ? "--all" : null,
    flags.decision === undefined ? null : "--decision",
    flags.decisionSet === undefined ? null : "--decision-set",
  ].filter((f): f is string => f !== null);
}

function digestFlag(
  name: string,
  value: string | undefined,
  usage: (reason: string) => never,
): string | undefined {
  if (value === undefined) return undefined;
  const digest = value.trim().toLowerCase();
  if (!isDecisionDigest(digest))
    usage(
      `${name} takes the 12 hexadecimal characters the dry run printed (got ${JSON.stringify(value)})`,
    );
  return digest;
}

function allRequest(
  args: readonly string[],
  flags: AnswerFlags,
  usage: (reason: string) => never,
): AnswerRequest {
  if (!flags.approve || flags.choose !== undefined)
    usage(
      "--all takes --approve alone: answer --all --approve approves the recommendation of every eligible item",
    );
  if (args.length > 0)
    usage(
      `answer --all --approve names no key (got ${args.join(" ")}); answer one item by its key instead`,
    );
  if (flags.note !== undefined)
    usage(
      "--note belongs to one item's answer; answer that item by its key with --note",
    );
  if (flags.decision !== undefined)
    usage(
      "--all takes the dry run's set token as --decision-set, not --decision",
    );
  const decisionSet = digestFlag("--decision-set", flags.decisionSet, usage);
  return {
    verb: "answer",
    all: true,
    ...(decisionSet === undefined ? {} : { decisionSet }),
  };
}

function formOf(
  words: readonly string[],
  flags: AnswerFlags,
  usage: (reason: string) => never,
): AnswerForm {
  const named = [
    words.length > 0,
    flags.approve,
    flags.choose !== undefined,
  ].filter(Boolean).length;
  if (named > 1)
    usage(
      "an answer takes one of: your words, --approve, or --choose <option>",
    );
  if (flags.approve) return { kind: "approve" };
  if (flags.choose !== undefined) {
    const option = flags.choose.trim();
    if (option === "")
      usage(
        "--choose names no option: give the option's name as the park spells it",
      );
    const fault = answerTextFault(option);
    if (fault !== null) usage(`--choose: ${fault}`);
    return { kind: "choose", option };
  }
  if (words.length === 0)
    usage(`the answer names no option and has no words: answer ${ANSWER_ARGS}`);
  const text = words.join(" ");
  const fault = answerTextFault(text);
  if (fault !== null) usage(fault);
  return { kind: "free", text: text.trim() };
}

/** The answer `args` and `flags` make; every refusal goes to `usage`. */
export function answerRequest(
  args: readonly string[],
  flags: AnswerFlags,
  usage: (reason: string) => never,
): AnswerRequest {
  if (flags.all) return allRequest(args, flags, usage);
  if (flags.decisionSet !== undefined)
    usage("--decision-set is taken only with --all --approve");
  const [key, ...words] = args;
  if (key === undefined)
    usage(`answer names the parked key and your answer: answer ${ANSWER_ARGS}`);
  const keyFault = answerKeyFault(key);
  if (keyFault !== null) usage(keyFault);
  const form = formOf(words, flags, usage);
  if (form.kind === "free" && flags.note !== undefined)
    usage(
      "--note goes beside --approve or --choose; a free answer holds your words already",
    );
  if (form.kind === "free" && flags.decision !== undefined)
    usage(
      "--decision binds --approve or --choose to the framing you read; a free answer takes none",
    );
  const noteFault =
    flags.note === undefined ? null : answerTextFault(flags.note);
  if (noteFault !== null) usage(`--note: ${noteFault}`);
  const decision = digestFlag("--decision", flags.decision, usage);
  return {
    verb: "answer",
    all: false,
    key,
    form,
    ...(flags.note === undefined ? {} : { note: flags.note.trim() }),
    ...(decision === undefined ? {} : { decision }),
  };
}
