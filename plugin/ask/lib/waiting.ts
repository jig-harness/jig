import { uniqueLogins } from "../../shared/forge-logins.ts";
/**
 * `jig ask --waiting`: every address that waits on a person, with the act
 * each waits for, across the repositories this machine dispatches. It reads
 * the newest tick's line, which the dispatcher keeps for its dashboard
 * (`dispatch/lib/line-store.ts`), so it makes no forge or tracker call and
 * is as fresh as that tick, whose time it prints.
 */
import { formatAddress, type Station } from "../../shared/address.ts";
import type {
  LineNeed,
  NeedCause,
} from "../../dispatch/lib/dashboard-contract.ts";
import { readLine } from "../../dispatch/lib/line-store.ts";
import { ANSWER_VERSION, type PersonAct } from "./answer.ts";
import { actOfLineNeed, type NeedAct } from "../../shared/acts.ts";
import { HOST_NEED_REPO } from "../../dispatch/lib/preflight.ts";

/** The act that settles each cause the tick finds waiting on a person. */
const ACTS: Record<NeedCause, PersonAct> = {
  parked: "answer",
  "needs-person": "re-arm",
  "stopped-unknown": "re-arm",
  "followup-failed": "re-run the follow-up",
  "followup-stale": "re-run the follow-up",
  "double-claim": "choose the session that keeps the item",
  stalled: "look at the stalled pickup",
  "nudge-unanswered": "answer the waiting session",
  "pickup-question":
    "settle the pickup's question, then return the item to the dispatch states",
  "assigner-cannot-write": "assign the item as someone who can write",
  "tracker-unreachable": "authorize the account's tracker credential",
};

export function personAct(cause: NeedCause): PersonAct {
  return ACTS[cause];
}

/** One address that waits on a person. */
export interface WaitingEntry {
  people: string[];
  /** A station address, or a host-wide target that has no station address. */
  address: string | null;
  target: string;
  act: PersonAct;
  /** What the person does about it, as the dashboard's card names it (`shared/acts.ts`). */
  needAct: NeedAct;
  /** When the cause began, as far as the records say. */
  since: string;
  /** The tick's reason, verbatim. */
  reason: string;
  url: string | null;
  title: string | null;
  /** Recorded stage and parked questions, verbatim; older parks use their recorded lines. */
  questions: string[];
}

/** What `--waiting` answers. */
export interface WaitingAnswer {
  v: typeof ANSWER_VERSION;
  /** The tick the line is from; `null` when there is no line to read. */
  tick: { runId: string; finishedAt: string } | null;
  waiting: WaitingEntry[];
  /** Why there is no line, or why it does not read; `null` when it read. */
  unread: string | null;
}

/** The station a need is about. */
function stationOf(need: LineNeed): Station {
  if (need.stage === "followup") return "followup";
  if (need.stage === "pickup") return "pickup";
  if (need.stage === "steer") return need.item === null ? "drive" : "pickup";
  return "drive";
}

/** A need as an address, or the host target for a host-wide need. */
function entryOf(need: LineNeed): WaitingEntry | null {
  if (need.repo === HOST_NEED_REPO) {
    return {
      address: null,
      target: need.target,
      people: uniqueLogins(
        need.decisions.flatMap((d) =>
          d.person === undefined ? [] : [d.person],
        ),
      ),
      act: personAct(need.cause),
      needAct: actOfLineNeed(need),
      since: need.since,
      reason: need.reason,
      url: need.url,
      title: need.title,
      questions: [],
    };
  }
  const station = stationOf(need);
  const key =
    station === "pickup"
      ? need.item
      : need.pr === null
        ? null
        : String(need.pr);
  if (key === null) return null;
  return {
    address: formatAddress({ station, repo: need.repo, key }),
    target: need.target,
    people: uniqueLogins(
      need.decisions.flatMap((d) => (d.person === undefined ? [] : [d.person])),
    ),
    act: personAct(need.cause),
    needAct: actOfLineNeed(need),
    since: need.since,
    reason: need.reason,
    url: need.url,
    title: need.title,
    questions: [
      ...(need.question ? [need.question] : []),
      ...need.decisions.map((d) =>
        d.decision === undefined
          ? (d.question ?? d.lines.join("\n"))
          : d.lines.join("\n"),
      ),
    ].filter((q) => q.length > 0),
  };
}

/** What waits on a person, from the newest tick's line under the dispatcher's state directory `root`. */
export function waitingAnswer(
  root: string | null,
  person?: string,
): WaitingAnswer {
  const none = (unread: string): WaitingAnswer => ({
    v: ANSWER_VERSION,
    tick: null,
    waiting: [],
    unread,
  });
  if (root === null)
    return none("this machine dispatches nothing, so there is no line to read");
  const line = readLine(root);
  if (!line.ok) return none(line.failure.reason);
  if (line.value === null)
    return none(
      "no tick from the dispatch file has written a line yet, so there is no line to read",
    );
  return {
    v: ANSWER_VERSION,
    tick: { runId: line.value.runId, finishedAt: line.value.finishedAt },
    waiting: line.value.needs
      .map(entryOf)
      .filter((e): e is WaitingEntry => e !== null)
      .filter(
        (e) =>
          person === undefined ||
          e.people.some((p) => p.toLowerCase() === person.toLowerCase()),
      ),
    unread: null,
  };
}
