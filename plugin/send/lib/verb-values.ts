/**
 * The verbs of `jig send`, a closed list in code: for each, the stations
 * that take it, whether it is a person's command, the arguments it takes and
 * what it asks for. `verbs.ts` parses a request from this table, and the Jig
 * Protocol's Addresses chapter is generated from it
 * (`plugin/protocol/addresses.md`). Which record a verb writes, and whose
 * writer writes it, is the planner's (`assign.ts`, `labels.ts`, `answer.ts`,
 * `mailbox.ts`).
 *
 * A person's command (every verb but the mailbox's) is refused in a session
 * the line started (`shared/launched-session.ts`).
 */
import type { Station } from "../../shared/address.ts";
import { GATE_NAMES } from "../../skills/drive-pr/scripts/lib/state/mailbox-values.ts";

/** What `answer` takes after the address, as its usage names it. */
export const ANSWER_ARGS =
  "<key> <text> | <key> --approve|--choose <option> [--note <text>] [--decision <digest>] | --all --approve [--decision-set <token>]";

/** One verb: the stations that take it, whether it is a person's command, its arguments and its meaning. */
export interface VerbSpec {
  readonly stations: readonly Station[];
  /** A person's command: refused in a session the line started. */
  readonly person: boolean;
  /** Its arguments, as the usage names them; empty for none. */
  readonly args: string;
  readonly meaning: string;
}

/** The verbs of `jig send`, in the order a usage error lists them. */
export const SEND_VERBS = {
  assign: {
    stations: ["pickup"],
    person: true,
    args: "",
    meaning:
      "Hand the item to the line: assign it to the factory identity and move it into the first dispatch state, for the dispatcher's next tick to pick up",
  },
  drive: {
    stations: ["drive"],
    person: true,
    args: "",
    meaning:
      "Ask for a drive on a pull request that has none: the drive command label, which the dispatcher's next tick arms a drive for",
  },
  rearm: {
    stations: ["drive"],
    person: true,
    args: "",
    meaning:
      "Ask for a stopped drive to be re-armed in its existing working tree: the rearm command label, which the dispatcher's next tick reads",
  },
  hold: {
    stations: ["drive", "followup"],
    person: true,
    args: "",
    meaning:
      "Keep the line off a pull request: add the hold command label, which every stage of the dispatcher respects",
  },
  release: {
    stations: ["drive", "followup"],
    person: true,
    args: "",
    meaning:
      "Withdraw a hold: remove the hold command label, so the dispatcher's next tick takes the pull request up again",
  },
  answer: {
    stations: ["drive", "followup", "pickup"],
    person: true,
    args: ANSWER_ARGS,
    meaning:
      "Answer a parked question or a need's decision, in the person's own words or by approving or choosing one of its options: one answer comment per item, which the re-arm or the dispatcher's next tick reads",
  },
  pause: {
    stations: ["drive"],
    person: false,
    args: "",
    meaning:
      "Pause a running drive at its next round boundary: a directive in the mailbox of the working tree that holds the drive on this machine",
  },
  resume: {
    stations: ["drive"],
    person: false,
    args: `<${GATE_NAMES.join("|")}>`,
    meaning:
      "Withdraw the mailbox directive it names, so the drive goes on past it",
  },
  stop: {
    stations: ["drive"],
    person: false,
    args: "",
    meaning:
      "Stop a running drive at its next round boundary: a mailbox directive",
  },
  "hold-push": {
    stations: ["drive"],
    person: false,
    args: "",
    meaning:
      "Hold a running drive's pushes: a mailbox directive the driver checks before each push",
  },
} as const satisfies Record<string, VerbSpec>;
