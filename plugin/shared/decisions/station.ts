/**
 * The framed decisions of the line's needs other than a drive's park, and
 * the one answer form every station reads.
 *
 * Every need the dispatcher shows a person carries a framed decision: the
 * one its session recorded when it stopped (a session-framed decision), or
 * one the tick frames here from the facts it read (a dispatcher-framed
 * decision). A dispatcher-framed decision has a fixed set of options for its
 * cause, each a step the tick can carry out, and is built only from the
 * facts that identify the cause's occurrence (a launch record, a marker, an
 * item, a branch and a path, an exit), never from a clock or a count: its
 * digest stays the same while those facts do, and an answer to earlier facts
 * is stale.
 *
 * A person answers a station's decision as a park is answered: a comment on
 * the need's pull request or item whose line is `answer <key>: approve
 * [<digest>]` or `answer <key>: choose <option> [<digest>]`
 * (`decision-card.ts`), written by hand, copied from the dashboard, or sent
 * with `jig send <station>@<repo>#<key> answer <key> …`
 * (`stationSendCommand`).
 *
 * Pure data and functions with no `node:` import: the dashboard's page
 * bundles it. The digest is computed where the decision is stored or framed
 * (`digest.ts`), never here.
 */
import type { ParkedDecision, ParkedOption } from "./park.ts";

/** The key a station's decision is answered by, one per kind of need: `answer <key>: …`. */
export const STATION_KEYS = [
  "followup",
  "pickup",
  "checkout",
  "drive",
  "launch",
] as const;
export type StationKey = (typeof STATION_KEYS)[number];

/** The decision class of each dispatcher-framed decision; the acts table lists each as Decide. */
export const STATION_CLASSES: Readonly<Record<StationKey, string>> = {
  followup: "followup-recovery",
  pickup: "pickup-recovery",
  checkout: "checkout-recovery",
  drive: "drive-recovery",
  launch: "launch-recovery",
};

/** The option ids the tick carries out. `hold` is in every set. */
export type StationOptionId =
  | "rerun"
  | "done"
  | "release"
  | "detach"
  | "rearm"
  | "clear"
  | "hold";

/** Each option the tick can carry out, as every dispatcher-framed decision names it. */
const OPTIONS: Readonly<Record<StationOptionId, Omit<ParkedOption, "id">>> = {
  rerun: {
    name: "Run it again",
    summary:
      "The dispatcher releases the follow-up's claim (its marker comment), and a later tick starts the follow-up again once, with your note, when you add one, as a person's answer in its prompt.",
    pay: ["One more follow-up pass on an admitted account."],
  },
  done: {
    name: "Record it done",
    summary:
      "The dispatcher marks the follow-up's marker done and sets the pull request's followed-up label; nothing runs again.",
    pay: ["What the pass left undone stays undone unless you do it."],
  },
  release: {
    name: "Release the claim",
    summary:
      "The dispatcher moves the item back to the state a pickup starts from, so a later tick picks it up afresh in a new session.",
    pay: [
      "Work the earlier session left only in its workspace is not carried over.",
      "One more pickup pass.",
    ],
  },
  detach: {
    name: "Detach the checkout",
    summary:
      "The dispatcher detaches the checkout from its branch (its files and commits stay where they are), so the launch can take the branch.",
    pay: [
      "Whoever uses that checkout finds it detached and re-attaches it by hand.",
    ],
    reversible: true,
  },
  rearm: {
    name: "Re-arm the drive",
    summary:
      "The dispatcher re-arms the drive once on the pull request's current head, as the rearm label does.",
    pay: [
      "One more drive; a cause the drive could not settle may stop it again.",
    ],
  },
  clear: {
    name: "Clear the record",
    summary:
      "The dispatcher clears the stuck launch record, as jig dispatch clear does, which frees its slot; a later tick may start its stage again.",
    pay: ["A session the record still describes is no longer tracked."],
  },
  hold: {
    name: "Leave it to me",
    summary:
      "The dispatcher takes no step on it for these facts and stops listing it under Needs you; it lists it again when they change.",
    pay: ["You settle it by hand."],
  },
};

/** The option the tick carries out for `id`, as a decision states it. */
export function stationOption(id: StationOptionId): ParkedOption {
  return { id, ...OPTIONS[id] };
}

/** The id of a dispatcher option named `name`; `undefined` for a name no dispatcher option has. */
export function stationOptionId(name: string): StationOptionId | undefined {
  return (Object.keys(OPTIONS) as StationOptionId[]).find(
    (id) => OPTIONS[id].name === name,
  );
}

/**
 * The facts a dispatcher-framed decision is built from, one shape per kind
 * of need. Each holds only what identifies the occurrence.
 */
export type StationFacts =
  | {
      kind: "followup-failed";
      pr: number;
      /** The launch record of the pass that failed; `null` when no record names it. */
      record: string | null;
      /** The marker comment that claims the follow-up; `null` when none is known. */
      marker: number | null;
      /** The question the pass stopped on; `null` when it stated none. */
      question: string | null;
    }
  | {
      kind: "followup-stale";
      pr: number;
      marker: number;
      /** The marker the tick released once already. */
      released: number | null;
    }
  | {
      kind: "stalled";
      item: string;
      state: string;
      /** The open pull requests that carry the item; `null` when the tick could not tell. */
      carriedBy: readonly number[] | null;
    }
  | {
      kind: "pickup-question";
      item: string;
      record: string;
      question: string;
    }
  | { kind: "checkout"; target: string; branch: string; path: string }
  | {
      kind: "drive";
      pr: number;
      /** The drive's exit; `null` for a stop with none. */
      exit: string | null;
      /** When the stopped driver started; `null` when the ledger says not. */
      started: string | null;
      /** The re-arm whose launch ended without moving the ledger; `null` for none. */
      failedRearm: string | null;
    }
  | { kind: "launch"; target: string; record: string };

/** A framed decision and the key that answers it. */
export interface StationDecision {
  key: StationKey;
  decision: ParkedDecision;
}

function decision(
  key: StationKey,
  question: string,
  ids: readonly StationOptionId[],
  recommended: StationOptionId,
  why: string,
  alreadyDone: string,
): StationDecision {
  return {
    key,
    decision: {
      schema: "parked-decision/v1",
      class: STATION_CLASSES[key],
      call: {
        id: "a",
        question,
        options: ids.map(stationOption),
        recommended,
        why,
      },
      steps: [],
      alreadyDone,
    },
  };
}

/** A pass's question as a decision quotes it: one line. */
function quoted(question: string): string {
  return JSON.stringify(question.replace(/\s+/g, " ").trim());
}

function followupFailed(
  f: Extract<StationFacts, { kind: "followup-failed" }>,
): StationDecision {
  const pass =
    f.record === null
      ? "Its pass ended without recording done"
      : `Its pass under launch record ${f.record} ended without recording done`;
  const asked =
    f.question === null ? "" : `, on the question ${quoted(f.question)}`;
  const claim =
    f.marker === null
      ? ""
      : ` Marker comment ${f.marker} claims the follow-up.`;
  return f.question === null
    ? decision(
        "followup",
        `How should the follow-up of PR #${f.pr} go on?`,
        ["rerun", "done", "hold"],
        "rerun",
        "The pass stopped without asking a person anything, so running it once more is the likeliest way to finish it.",
        `${pass}${asked}.${claim}`,
      )
    : decision(
        "followup",
        `How should the follow-up of PR #${f.pr} go on?`,
        ["rerun", "done", "hold"],
        "hold",
        "The pass stopped on a question only a person can answer: settle it by hand, or run it again with your answer as a note.",
        `${pass}${asked}.${claim}`,
      );
}

function followupStale(
  f: Extract<StationFacts, { kind: "followup-stale" }>,
): StationDecision {
  const earlier =
    f.released === null
      ? ""
      : ` The tick released one stale claim on it already (marker comment ${f.released}).`;
  return decision(
    "followup",
    `How should the stale follow-up claim on PR #${f.pr} be settled?`,
    ["rerun", "done", "hold"],
    "rerun",
    "No session is joined to the claim, so releasing it and running the follow-up once more finishes it unless something else holds it.",
    `Marker comment ${f.marker} claims the follow-up, is not marked done, and no session is joined to it.${earlier}`,
  );
}

function stalled(
  f: Extract<StationFacts, { kind: "stalled" }>,
): StationDecision {
  const carried =
    f.carriedBy === null
      ? "The tick could not tell whether an open pull request carries it."
      : f.carriedBy.length === 0
        ? "No open pull request carries it."
        : `Open pull request ${f.carriedBy.map((n) => `#${n}`).join(", ")} carries it.`;
  const free = f.carriedBy !== null && f.carriedBy.length === 0;
  return decision(
    "pickup",
    `How should the stalled pickup of ${f.item} go on?`,
    ["release", "hold"],
    free ? "release" : "hold",
    free
      ? "No session holds the item and no pull request carries its work, so starting it afresh is the way it moves again."
      : "A pull request may already carry the item's work, so a person checks it before the item starts again.",
    `The item is in ${f.state} with no running session. ${carried}`,
  );
}

function pickupQuestion(
  f: Extract<StationFacts, { kind: "pickup-question" }>,
): StationDecision {
  return decision(
    "pickup",
    `How should the pickup of ${f.item} go on after it stopped on a question?`,
    ["release", "hold"],
    "hold",
    "The pass stopped on a question only a person can answer, so a person settles it before the item starts again.",
    `Its pass under launch record ${f.record} stopped on the question ${quoted(f.question)} without framing it.`,
  );
}

function checkout(
  f: Extract<StationFacts, { kind: "checkout" }>,
): StationDecision {
  return decision(
    "checkout",
    `How should the checkout that holds ${f.branch} be freed for ${f.target}?`,
    ["detach", "hold"],
    "hold",
    "The checkout was in use when the launch met it, and only a person knows whether its work is finished.",
    `A launch of ${f.target} waits: the checkout at ${f.path}, which the workspace runtime does not list, holds ${f.branch} and was in use.`,
  );
}

function drive(f: Extract<StationFacts, { kind: "drive" }>): StationDecision {
  const exit = f.exit === null ? "with no exit" : `with exit ${f.exit}`;
  const started = f.started === null ? "" : ` (a driver started ${f.started})`;
  const rearm =
    f.failedRearm === null
      ? ""
      : ` Its re-arm under launch record ${f.failedRearm} ended without moving its ledger.`;
  return decision(
    "drive",
    `How should the stopped drive of PR #${f.pr} go on?`,
    ["rearm", "hold"],
    "hold",
    "The drive handed it to a person, so re-arming it unchanged may stop it the same way.",
    `The drive stopped ${exit}${started} and handed it to a person.${rearm}`,
  );
}

function launch(f: Extract<StationFacts, { kind: "launch" }>): StationDecision {
  return decision(
    "launch",
    `How should the stuck launch record ${f.record} of ${f.target} be settled?`,
    ["clear", "hold"],
    "clear",
    "No tick launches the record again, so clearing it frees its slot and its stage.",
    `Launch record ${f.record} is pending and no tick launches it again.`,
  );
}

/** The decision the tick frames for a need from `facts`. */
export function frameStationDecision(facts: StationFacts): StationDecision {
  switch (facts.kind) {
    case "followup-failed":
      return followupFailed(facts);
    case "followup-stale":
      return followupStale(facts);
    case "stalled":
      return stalled(facts);
    case "pickup-question":
      return pickupQuestion(facts);
    case "checkout":
      return checkout(facts);
    case "drive":
      return drive(facts);
    case "launch":
      return launch(facts);
  }
}

/** The stations `jig send` answers a need's decision through. */
export type AnswerStation = "drive" | "followup" | "pickup";

/**
 * Where a need's decision is answered: the station `jig send` addresses,
 * its address, where the comment goes, and who framed the decision.
 */
export interface StationAnswer {
  station: AnswerStation;
  /** The address `jig send` takes: `followup@owner/name#456`, `pickup@owner/name#ENG-4`. */
  address: string;
  /** Where the answer comment goes: the pull request, an issue on the forge, or an item on another tracker. */
  on: "pull-request" | "issue" | "tracker";
  /** `session`: the stage's own pass framed it; `dispatcher`: the tick did, and carries out the option chosen. */
  framedBy: "session" | "dispatcher";
}

/** A word for a shell: as it is when it needs no quoting, else in single quotes. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9._@#/:=+-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `jig send` command that answers `key` with `choice`, bound to the
 * framing `digest` when there is one: the command a surface that runs
 * commands offers beside the comment it copies.
 */
export function stationSendCommand(
  answer: Pick<StationAnswer, "address">,
  key: string,
  choice: { form: "approve" } | { form: "choose"; option: string },
  digest?: string,
  note?: string,
): string {
  const form =
    choice.form === "approve"
      ? "--approve"
      : `--choose ${shellWord(choice.option)}`;
  const noted =
    note === undefined || note.trim() === ""
      ? ""
      : ` --note ${shellWord(note.trim())}`;
  const bound = digest === undefined ? "" : ` --decision ${digest}`;
  return `jig send ${answer.address} answer ${shellWord(key)} ${form}${noted}${bound}`;
}
