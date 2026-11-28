import { uniqueLogins } from "../../shared/forge-logins.ts";
/**
 * `jig ask --waiting`: every address that waits on a person, with the act
 * each waits for, across the repositories this machine dispatches. It reads
 * the newest tick's line, which the dispatcher keeps for its dashboard
 * (`dispatch/lib/line-store.ts`), so it makes no forge or tracker call and
 * is as fresh as that tick, whose time it prints. Where the newest read of a
 * repository was refused, the line holds what an earlier reading found, or
 * nothing of it, and the answer says so (`incomplete`): an empty list then
 * does not mean nothing waits.
 */
import { formatAddress, type Station } from "../../shared/address.ts";
import type {
  LineNeed,
  LineQueued,
  LineSettled,
  LineSnapshot,
  NeedCause,
} from "../../dispatch/lib/dashboard-contract.ts";
import { readLine } from "../../dispatch/lib/line-store.ts";
import { SETTLED_WINDOW_MS } from "../../dispatch/lib/need-leaves.ts";
import { currentMs, parseMs } from "../../shared/time.ts";
import {
  type RefusedRepo,
  refusedRepos,
} from "../../dispatch/lib/line-unread.ts";
import { ANSWER_VERSION, type PersonAct } from "./answer.ts";
import { actOfLineNeed, type NeedAct } from "../../shared/acts.ts";
import { questionGroupId } from "../../shared/question-group.ts";
import { HOST_NEED_REPO } from "../../dispatch/lib/preflight.ts";

/** The act that settles each cause the tick finds waiting on a person. */
const ACTS: Record<NeedCause, PersonAct> = {
  parked: "answer",
  "busy-holder": "inspect the holding worktree",
  "needs-person": "re-arm",
  "stopped-unknown": "re-arm",
  "followup-failed": "re-run the follow-up",
  "followup-stale": "re-run the follow-up",
  "release-owed": "answer",
  "double-claim": "choose the session that keeps the item",
  stalled: "look at the stalled pickup",
  "nudge-unanswered": "answer the waiting session",
  "pickup-question":
    "settle the pickup's question, then return the item to the dispatch states",
  "pickup-ended": "pick the item up again or leave it",
  "assigner-cannot-write": "assign the item as someone who can write",
  "tracker-unreachable": "authorize the account's tracker credential",
  "account-sign-in": "sign in to the account again",
  "account-startup": "investigate the account's startup failures",
  "low-quota": "inspect the quota spending",
  "calls-failing": "inspect the failing caller",
  "state-storage": "inspect Jig state storage",
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
  /** Why its notice has not reached a person this tick (held for room in the comment, lost, its destination unreachable); `null` otherwise. */
  notice: string | null;
  /** The question group the need is in (`shared/question-group.ts`): entries that share it are one card on the dashboard's Needs you, settled by one answer; `null` for a need that is always a card of its own. */
  questionGroup: string | null;
}

/** What `--waiting` answers. */
export interface WaitingAnswer {
  v: typeof ANSWER_VERSION;
  /** The tick the line is from; `null` when there is no line to read. */
  tick: { runId: string; finishedAt: string } | null;
  waiting: WaitingEntry[];
  /** Why there is no line, or why it does not read; `null` when it read. */
  unread: string | null;
  /** The repositories whose newest read was refused, so what waits on them is as of the reading named or unknown; empty when the line read every one, and when there is no line. */
  incomplete: RefusedRepo[];
}

/** The station a need is about. */
function stationOf(need: LineNeed): Station {
  if (need.cause === "release-owed") return "pickup";
  if (need.stage === "followup") return "followup";
  if (need.stage === "pickup") return "pickup";
  if (need.stage === "steer") return need.item === null ? "drive" : "pickup";
  return "drive";
}

/** What every entry says of its need, beside its address and its questions. */
function shared(need: LineNeed): Omit<WaitingEntry, "address" | "questions"> {
  return {
    target: need.target,
    people: uniqueLogins(
      need.decisions.flatMap((d) => (d.person === undefined ? [] : [d.person])),
    ),
    act:
      need.heldSince == null
        ? personAct(need.cause)
        : "settle the launch that holds the drive",
    needAct: actOfLineNeed(need),
    since: need.since,
    reason: need.reason,
    url: need.url,
    title: need.title,
    notice: need.notified?.detail ?? null,
    questionGroup: questionGroupId(need),
  };
}

/** A need as an address, or the host target for a host-wide need. */
function entryOf(need: LineNeed): WaitingEntry | null {
  if (need.repo === HOST_NEED_REPO)
    return { address: null, ...shared(need), questions: [] };
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
    ...shared(need),
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

function heldPickupEntry(entry: LineQueued): WaitingEntry | null {
  const { pickupHold, item } = entry;
  if (pickupHold === undefined || item === null) return null;
  return {
    address: formatAddress({ station: "pickup", repo: entry.repo, key: item }),
    target: entry.target,
    people: [pickupHold.by],
    act: "release the pickup hold",
    needAct: "Authorize",
    since: pickupHold.at,
    reason: entry.why,
    url: entry.url,
    title: entry.title,
    questions: [],
    notice: null,
    questionGroup: null,
  };
}

/** The newest tick's line under the dispatcher's state directory `root`, or why there is none to read. */
function newestLine(root: string | null): LineSnapshot | string {
  if (root === null)
    return "this machine dispatches nothing, so there is no line to read";
  const line = readLine(root);
  if (!line.ok) return line.failure.reason;
  return (
    line.value ??
    "no tick from the dispatch file has written a line yet, so there is no line to read"
  );
}

/** What waits on a person, from the newest tick's line under the dispatcher's state directory `root`. */
export function waitingAnswer(
  root: string | null,
  person?: string,
): WaitingAnswer {
  const found = newestLine(root);
  if (typeof found === "string")
    return {
      v: ANSWER_VERSION,
      tick: null,
      waiting: [],
      unread: found,
      incomplete: [],
    };
  return {
    v: ANSWER_VERSION,
    tick: { runId: found.runId, finishedAt: found.finishedAt },
    waiting: [...found.needs.map(entryOf), ...found.queue.map(heldPickupEntry)]
      .filter((e): e is WaitingEntry => e !== null)
      .filter(
        (e) =>
          person === undefined ||
          e.people.some((p) => p.toLowerCase() === person.toLowerCase()),
      ),
    unread: null,
    incomplete: refusedRepos(found),
  };
}

/** What `--settled` answers. */
export interface SettledAnswer {
  v: typeof ANSWER_VERSION;
  /** The tick the line is from; `null` when there is no line to read. */
  tick: { runId: string; finishedAt: string } | null;
  /** The needs that left the line in the last day and the answers that did not settle theirs, newest first. */
  settled: LineSettled[];
  /** Why there is no line, or why it does not read; `null` when it read. */
  unread: string | null;
}

/** What left the line recently, from the newest tick's line under the dispatcher's state directory `root`: no forge or tracker call. */
export function settledAnswer(
  root: string | null,
  person?: string,
): SettledAnswer {
  const found = newestLine(root);
  if (typeof found === "string")
    return { v: ANSWER_VERSION, tick: null, settled: [], unread: found };
  // The tick wrote the list windowed to its own clock: window it again to this one.
  const since = currentMs() - SETTLED_WINDOW_MS;
  return {
    v: ANSWER_VERSION,
    tick: { runId: found.runId, finishedAt: found.finishedAt },
    settled: (found.settled ?? []).filter(
      (e) =>
        parseMs(e.at) >= since &&
        (person === undefined ||
          (e.who ?? "")
            .split(", ")
            .some((p) => p.toLowerCase() === person.toLowerCase())),
    ),
    unread: null,
  };
}
