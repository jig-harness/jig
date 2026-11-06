/**
 * The verbs of `jig send`, a closed list in code: for each, the stations
 * that take it, whether it is a person's command, and the arguments it
 * takes. A verb names one record the line already reads; which record, and
 * whose writer writes it, is the planner's (`assign.ts`, `labels.ts`,
 * `answer.ts`, `mailbox.ts`).
 *
 * | Verb | To | The record |
 * | --- | --- | --- |
 * | `assign` | `pickup` | the item assigned to the factory identity, in a dispatch state |
 * | `drive` | `drive` | the `drive` command label |
 * | `hold`, `release` | `drive`, `followup` | the `hold` command label, added or removed |
 * | `answer <key> <text>` | `drive` | a comment `answer <key>: <text>` |
 * | `pause`, `resume <directive>`, `stop`, `hold-push` | `drive` | a mailbox directive |
 *
 * A person's command (every verb but the mailbox's) is refused in a session
 * the line started (`shared/launched-session.ts`). An unknown verb, a verb
 * the station does not take, or arguments the verb does not take are usage
 * errors that list the verbs the station takes.
 */
import type { Station } from "../../shared/address.ts";
import {
  answerKeyFault,
  answerTextFault,
} from "../../skills/drive-pr/scripts/lib/answer-comment.ts";
import {
  GATE_NAMES,
  type GateName,
} from "../../skills/drive-pr/scripts/lib/state/mailbox.ts";

const VERBS = [
  "assign",
  "drive",
  "hold",
  "release",
  "answer",
  "pause",
  "resume",
  "stop",
  "hold-push",
] as const;
export type Verb = (typeof VERBS)[number];

/** The verbs that write a mailbox directive. */
export type MailboxVerb = "pause" | "resume" | "stop" | "hold-push";
/** The verbs that write a dispatch label. */
export type LabelVerb = "drive" | "hold" | "release";

interface VerbSpec {
  stations: readonly Station[];
  /** A person's command: refused in a session the line started. */
  person: boolean;
  /** Its arguments, as the usage names them. */
  args: string;
}

const SPECS: Record<Verb, VerbSpec> = {
  assign: { stations: ["pickup"], person: true, args: "" },
  drive: { stations: ["drive"], person: true, args: "" },
  hold: { stations: ["drive", "followup"], person: true, args: "" },
  release: { stations: ["drive", "followup"], person: true, args: "" },
  answer: { stations: ["drive"], person: true, args: "<key> <text>" },
  pause: { stations: ["drive"], person: false, args: "" },
  resume: {
    stations: ["drive"],
    person: false,
    args: `<${GATE_NAMES.join("|")}>`,
  },
  stop: { stations: ["drive"], person: false, args: "" },
  "hold-push": { stations: ["drive"], person: false, args: "" },
};

/** One request, its arguments parsed. */
export type Request =
  | { verb: "assign" }
  | { verb: LabelVerb }
  | { verb: "answer"; key: string; text: string }
  | { verb: Exclude<MailboxVerb, "resume"> }
  | { verb: "resume"; target: GateName };

export function isVerb(word: string | undefined): word is Verb {
  return (VERBS as readonly string[]).includes(word ?? "");
}

/** Whether `verb` is a person's command, refused in a session the line started. */
export function isPersonVerb(verb: Verb): boolean {
  return SPECS[verb].person;
}

/** The verbs a station takes, with their arguments, for a usage error. */
function verbsOf(station: Station): string {
  return VERBS.filter((v) => SPECS[v].stations.includes(station))
    .map((v) => (SPECS[v].args === "" ? v : `${v} ${SPECS[v].args}`))
    .join(", ");
}

/**
 * The request `words` (the verb and its arguments) make of `station`; every
 * refusal goes to `usage`. An answer's text may be one argument or several,
 * joined with a space.
 */
export function parseRequest(
  station: Station,
  words: readonly string[],
  usage: (reason: string) => never,
): Request {
  const [verb, ...args] = words;
  const takes = `${station} takes ${verbsOf(station)}`;
  if (verb === undefined) usage(`name a verb: ${takes}`);
  if (!isVerb(verb))
    usage(`${JSON.stringify(verb)} is not a verb of jig send; ${takes}`);
  if (!SPECS[verb].stations.includes(station))
    usage(`a ${station} address does not take ${verb}; ${takes}`);
  if (verb === "answer") return answerRequest(args, usage);
  if (verb === "resume") {
    const target = args[0];
    if (
      args.length !== 1 ||
      !(GATE_NAMES as readonly string[]).includes(target ?? "")
    )
      usage(
        `resume names the directive it withdraws: resume ${SPECS.resume.args}`,
      );
    return { verb, target: target as GateName };
  }
  if (args.length > 0)
    usage(`${verb} takes no arguments (got ${args.join(" ")})`);
  return { verb } as Request;
}

function answerRequest(
  args: readonly string[],
  usage: (reason: string) => never,
): Request {
  const [key, ...words] = args;
  if (key === undefined || words.length === 0)
    usage(
      `answer names the parked key and your answer: answer ${SPECS.answer.args}`,
    );
  const keyFault = answerKeyFault(key);
  if (keyFault !== null) usage(keyFault);
  const text = words.join(" ");
  const fault = answerTextFault(text);
  if (fault !== null) usage(fault);
  return { verb: "answer", key, text: text.trim() };
}
