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
import { PARKED_DECISION_SCHEMA } from "./decision-values.ts";
import type { ParkedDecision, ParkedOption } from "./park.ts";

/** The option ids the tick carries out. `hold` is in every set. */
export type StationOptionId =
  | "rerun"
  | "done"
  | "release"
  | "detach"
  | "rearm"
  | "clear"
  | "hold"
  | "gates"
  | "inspect"
  | "tag";

/** A kind of need the dispatcher frames: its decision's class and the options it offers. */
export interface StationKeyValue {
  readonly class: string;
  readonly options: readonly StationOptionId[];
  readonly meaning: string;
}

/**
 * The key a station's decision is answered by, one per kind of need
 * (`answer <key>: …`), with the decision class of each dispatcher-framed
 * decision, which the acts table lists as Decide, and the options, in the
 * order the decision offers them.
 */
export const STATION_KEYS = {
  followup: {
    class: "followup-recovery",
    options: ["rerun", "done", "hold"],
    meaning:
      "A merged pull request's follow-up whose pass ended without recording done, or whose claim no session is joined to.",
  },
  release: {
    class: "release",
    options: ["gates", "inspect", "tag"],
    meaning:
      "An untagged release, or the untagged releases of a repository that share a remedy, answered on one tracker item. It recommends re-running the failed gates only while the releasing commit has a failed required check and a re-run is left; otherwise it offers only the other two, recommending a person's tag where no failed gate is left to re-run.",
  },
  pickup: {
    class: "pickup-recovery",
    options: ["release", "hold"],
    meaning:
      "A pickup that stalled, stopped on a question it did not frame, or ended without moving its item on.",
  },
  checkout: {
    class: "checkout-recovery",
    options: ["detach", "hold"],
    meaning:
      "A launch that waits because a checkout the workspace runtime does not list holds its branch and is in use.",
  },
  drive: {
    class: "drive-recovery",
    options: ["rearm", "hold"],
    meaning: "A drive that stopped and handed its pull request to a person.",
  },
  launch: {
    class: "launch-recovery",
    options: ["clear", "hold"],
    meaning:
      "A pending launch record that no tick launches again, or one of unknown process that holds a drive.",
  },
} as const satisfies Readonly<Record<string, StationKeyValue>>;
export type StationKey = keyof typeof STATION_KEYS;

/** The decision class of each dispatcher-framed decision; the acts table lists each as Decide. */
export const STATION_CLASSES: Readonly<Record<StationKey, string>> =
  Object.fromEntries(
    Object.entries(STATION_KEYS).map(([key, v]) => [key, v.class]),
  ) as Record<StationKey, string>;

/** Each option the tick can carry out, as every dispatcher-framed decision names it. */
export const STATION_OPTIONS: Readonly<
  Record<StationOptionId, Omit<ParkedOption, "id">>
> = {
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
  gates: {
    name: "Re-run the failed gates",
    summary:
      "The dispatcher requests another run of the failed jobs on the releasing commit once.",
    pay: ["Uses CI capacity and still depends on the release checks passing."],
  },
  inspect: {
    name: "Investigate",
    summary:
      "Take the tracker item and determine what is holding back the tag.",
    pay: ["A person investigates the checks and the release state."],
  },
  tag: {
    name: "Tag it by hand",
    summary:
      "Take the tracker item and create the tag by hand after checking it is safe to release.",
    pay: ["A person verifies the release and creates the tag."],
  },
  hold: {
    name: "I'll handle it — hide this card",
    summary:
      "Nothing is done; the work stays where it is. The dispatcher hides this card for these facts and lists it again when they change.",
    pay: ["You settle it by hand."],
  },
};

/** The option the tick carries out for `id`, as a decision states it. */
function stationOption(id: StationOptionId): ParkedOption {
  return { id, ...STATION_OPTIONS[id] };
}

/** The id of a dispatcher option named `name`; `undefined` for a name no dispatcher option has. */
export function stationOptionId(name: string): StationOptionId | undefined {
  if (name === "Leave it to me") return "hold";
  return (Object.keys(STATION_OPTIONS) as StationOptionId[]).find(
    (id) => STATION_OPTIONS[id].name === name,
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
      /** When the item last moved, which tells this stall from a later one in the same state; `null` when the need names none. */
      idleSince?: string | null;
      /** The open pull requests that carry the item; `null` when the tick could not tell. */
      carriedBy: readonly number[] | null;
    }
  | {
      kind: "pickup-question";
      item: string;
      record: string;
      question: string;
    }
  | {
      kind: "pickup-ended";
      item: string;
      record: string;
      /** How its pass ended, as the record says; `null` when the need names none. */
      ended: string | null;
      carriedBy: readonly number[] | null;
    }
  | {
      kind: "release-owed";
      repo: string;
      tag: string;
      /** Its one re-run of the failed gates was requested; absent while it can be. */
      rerunSpent?: boolean;
      /** Why it has no failed gate to re-run, as the repository's procedure says; absent while it has one. */
      noRerun?: string;
    }
  | {
      kind: "release-group";
      repo: string;
      /** Every version the decision settles, oldest first. */
      tags: readonly string[];
      /** Whether the one re-run of each one's failed gates was requested. */
      rerunSpent: boolean;
      /** Why none of them has a failed gate to re-run, as the repository's procedure says; absent while they have one. */
      noRerun?: string;
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
  | {
      kind: "launch";
      target: string;
      record: string;
      /** Why the process of a record holding a drive is unknown; absent for a pending record. */
      held?: string;
    };

/** A framed decision and the key that answers it. */
export interface StationDecision {
  key: StationKey;
  decision: ParkedDecision;
}

function decision(
  key: StationKey,
  question: string,
  recommended: StationOptionId,
  why: string,
  alreadyDone: string,
  options: readonly StationOptionId[] = STATION_KEYS[key].options,
): StationDecision {
  return {
    key,
    decision: {
      schema: PARKED_DECISION_SCHEMA,
      class: STATION_KEYS[key].class,
      call: {
        id: "a",
        question,
        options: options.map(stationOption),
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
        "rerun",
        "The pass stopped without asking a person anything, so running it once more is the likeliest way to finish it.",
        `${pass}${asked}.${claim}`,
      )
    : decision(
        "followup",
        `How should the follow-up of PR #${f.pr} go on?`,
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
    "rerun",
    "No session is joined to the claim, so releasing it and running the follow-up once more finishes it unless something else holds it.",
    `Marker comment ${f.marker} claims the follow-up, is not marked done, and no session is joined to it.${earlier}`,
  );
}

/** Whether an open pull request carries an item, in words, and whether none does. */
function carriage(carriedBy: readonly number[] | null): {
  carried: string;
  free: boolean;
} {
  return {
    carried:
      carriedBy === null
        ? "The tick could not tell whether an open pull request carries it."
        : carriedBy.length === 0
          ? "No open pull request carries it."
          : `Open pull request ${carriedBy.map((n) => `#${n}`).join(", ")} carries it.`,
    free: carriedBy !== null && carriedBy.length === 0,
  };
}

function stalled(
  f: Extract<StationFacts, { kind: "stalled" }>,
): StationDecision {
  const { carried, free } = carriage(f.carriedBy);
  return decision(
    "pickup",
    `How should the stalled pickup of ${f.item} go on?`,
    free ? "release" : "hold",
    free
      ? "No session holds the item and no pull request carries its work, so starting it afresh is the way it moves again."
      : "A pull request may already carry the item's work, so a person checks it before the item starts again.",
    `The item is in ${f.state}${f.idleSince == null ? "" : ` since ${f.idleSince}`} with no running session. ${carried}`,
  );
}

function pickupQuestion(
  f: Extract<StationFacts, { kind: "pickup-question" }>,
): StationDecision {
  return decision(
    "pickup",
    `How should the pickup of ${f.item} go on after it stopped on a question?`,
    "hold",
    "The pass stopped on a question only a person can answer, so a person settles it before the item starts again.",
    `Its pass under launch record ${f.record} stopped on the question ${quoted(f.question)} without framing it.`,
  );
}

function pickupEnded(
  f: Extract<StationFacts, { kind: "pickup-ended" }>,
): StationDecision {
  const { carried, free } = carriage(f.carriedBy);
  return decision(
    "pickup",
    `Should ${f.item} be picked up again after its pickup ended without moving it on?`,
    free ? "release" : "hold",
    free
      ? "Its pass asked nothing and no pull request carries its work, so a new pickup is the way it moves again."
      : "A pull request may already carry the item's work, so a person checks it before the item starts again.",
    `Its pass under launch record ${f.record} ended${f.ended === null ? "" : ` (${f.ended})`} and left it waiting in a dispatch state, where no rule starts it again. ${carried}`,
  );
}

function checkout(
  f: Extract<StationFacts, { kind: "checkout" }>,
): StationDecision {
  return decision(
    "checkout",
    `How should the checkout that holds ${f.branch} be freed for ${f.target}?`,
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
    "hold",
    "The drive handed it to a person, so re-arming it unchanged may stop it the same way.",
    `The drive stopped ${exit}${started} and handed it to a person.${rearm}`,
  );
}

function launch(f: Extract<StationFacts, { kind: "launch" }>): StationDecision {
  return decision(
    "launch",
    `How should the stuck launch record ${f.record} of ${f.target} be settled?`,
    "clear",
    f.held === undefined
      ? "No tick launches the record again, so clearing it frees its slot and its stage."
      : "No tick acts on the drive while the record holds it, so clearing it lets the next tick do so.",
    f.held === undefined
      ? `Launch record ${f.record} is pending and no tick launches it again.`
      : `Launch record ${f.record} holds the drive of ${f.target}, and whether its process runs is unknown: ${f.held}.`,
  );
}

/** A release's decision once its one re-run was requested: the dispatcher will not request another. */
function rerunSpent(question: string, covers: string): StationDecision {
  return decision(
    "release",
    question,
    "inspect",
    "The dispatcher requests a re-run of the failed gates only once, so if the tag does not follow, someone has to find what holds it back.",
    `The one re-run was already requested; it may still be running, or the request may have been refused. A release whose gates pass gets its tag and leaves the line. ${covers}`,
    ["inspect", "tag"],
  );
}

/** A release's decision when it has no failed gate to re-run: a person tags it, for the reason its procedure gives. */
function noRerun(
  question: string,
  why: string,
  covers: string,
): StationDecision {
  return decision(
    "release",
    question,
    "tag",
    `${why} A re-run of the gates has nothing to change, so a person tags the release.`,
    `The dispatcher offers no re-run of the gates here. ${covers}`,
    ["inspect", "tag"],
  );
}

function releaseGroup(
  f: Extract<StationFacts, { kind: "release-group" }>,
): StationDecision {
  const question = `How should the ${f.tags.length} untagged releases of ${f.repo} get their tags: ${f.tags.join(", ")}?`;
  const covers = "Your answer covers every release listed.";
  if (f.noRerun !== undefined) return noRerun(question, f.noRerun, covers);
  return f.rerunSpent
    ? rerunSpent(question, covers)
    : decision(
        "release",
        question,
        "gates",
        "Another run can clear a transient gate failure while keeping the release checks in force.",
        `The merged pull requests' follow-ups leave each release tracked in its own item. ${covers}`,
      );
}

/** The decision the tick frames for a need from `facts`. */
export function frameStationDecision(facts: StationFacts): StationDecision {
  switch (facts.kind) {
    case "release-owed":
      if (facts.noRerun !== undefined)
        return noRerun(
          `How should release ${facts.tag} of ${facts.repo} get its tag?`,
          facts.noRerun,
          "The merged pull requests' follow-ups leave the release tracked in one item.",
        );
      if (facts.rerunSpent === true)
        return rerunSpent(
          `How should release ${facts.tag} of ${facts.repo} get its tag?`,
          "The merged pull requests' follow-ups leave the release tracked in one item.",
        );
      return decision(
        "release",
        `How should release ${facts.tag} of ${facts.repo} get its tag?`,
        "gates",
        "Another run can clear a transient gate failure while keeping the release checks in force.",
        "The merged pull requests' follow-ups leave the release tracked in one item.",
      );
    case "release-group":
      return releaseGroup(facts);
    case "followup-failed":
      return followupFailed(facts);
    case "followup-stale":
      return followupStale(facts);
    case "stalled":
      return stalled(facts);
    case "pickup-question":
      return pickupQuestion(facts);
    case "pickup-ended":
      return pickupEnded(facts);
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
  /** The configured GitHub issue repository, when it differs from the code repository. */
  repository?: string;
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
