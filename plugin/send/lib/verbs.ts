/**
 * Parsing a request to `jig send`: the verb and its arguments, checked
 * against the verb table (`verb-values.ts`), which says which stations take
 * each verb, whether it is a person's command and what arguments it takes.
 * The Jig Protocol's Addresses chapter lists the verbs
 * (`plugin/protocol/addresses.md`).
 *
 * An unknown verb, a verb the station does not take, or arguments the verb
 * does not take are usage errors that list the verbs the station takes.
 */
import type { Station } from "../../shared/address.ts";
import {
  type AnswerFlags,
  answerFlagsSet,
  type AnswerRequest,
  answerRequest,
} from "./answer-request.ts";
import {
  GATE_NAMES,
  type GateName,
} from "../../skills/drive-pr/scripts/lib/state/mailbox-values.ts";
import { SEND_VERBS } from "./verb-values.ts";

export type Verb = keyof typeof SEND_VERBS;
const VERBS = Object.keys(SEND_VERBS) as Verb[];

/** The verbs that write a mailbox directive. */
export type MailboxVerb = "pause" | "resume" | "stop" | "hold-push";
/** The verbs that write a dispatch label. */
export type LabelVerb = "drive" | "rearm" | "hold" | "release";

/** One request, its arguments parsed. */
export type Request =
  | { verb: "assign" }
  | { verb: LabelVerb }
  | AnswerRequest
  | { verb: Exclude<MailboxVerb, "resume"> }
  | { verb: "resume"; target: GateName };

export function isVerb(word: string | undefined): word is Verb {
  return Object.hasOwn(SEND_VERBS, word ?? "");
}

/** Whether `verb` is a person's command, refused in a session the line started. */
export function isPersonVerb(verb: Verb): boolean {
  return SEND_VERBS[verb].person;
}

/** The verbs a station takes, with their arguments, for a usage error. */
function verbsOf(station: Station): string {
  return VERBS.filter((v) =>
    (SEND_VERBS[v].stations as readonly Station[]).includes(station),
  )
    .map((v) => (SEND_VERBS[v].args === "" ? v : `${v} ${SEND_VERBS[v].args}`))
    .join(", ");
}

/** No answer flag set: what a verb other than `answer` is given. */
const NO_ANSWER_FLAGS: AnswerFlags = { approve: false, all: false };

/**
 * The request `words` (the verb and its arguments) and the answer `flags`
 * make of `station`; every refusal goes to `usage`. An answer's text may be
 * one argument or several, joined with a space.
 */
export function parseRequest(
  station: Station,
  words: readonly string[],
  usage: (reason: string) => never,
  flags: AnswerFlags = NO_ANSWER_FLAGS,
): Request {
  const [verb, ...args] = words;
  const takes = `${station} takes ${verbsOf(station)}`;
  if (verb === undefined) usage(`name a verb: ${takes}`);
  if (!isVerb(verb))
    usage(`${JSON.stringify(verb)} is not a verb of jig send; ${takes}`);
  if (!(SEND_VERBS[verb].stations as readonly Station[]).includes(station))
    usage(`a ${station} address does not take ${verb}; ${takes}`);
  if (verb === "answer") return answerRequest(args, flags, usage);
  const answerOnly = answerFlagsSet(flags);
  if (answerOnly.length > 0)
    usage(`only answer takes ${answerOnly.join(", ")}`);
  if (verb === "resume") {
    const target = args[0];
    if (
      args.length !== 1 ||
      !(GATE_NAMES as readonly string[]).includes(target ?? "")
    )
      usage(
        `resume names the directive it withdraws: resume ${SEND_VERBS.resume.args}`,
      );
    return { verb, target: target as GateName };
  }
  if (args.length > 0)
    usage(`${verb} takes no arguments (got ${args.join(" ")})`);
  return { verb } as Request;
}
