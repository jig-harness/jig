/**
 * The `blocked` state: the projection's tracker output beside its state
 * label (`projection.ts`). A repository that names `issue_tracker.states.blocked`
 * sees the items behind a pull request whose drive stopped with only parked
 * work left (the `parked` state label) in that state, and sees them return
 * to the state they left once the park is answered and the drive re-arms.
 *
 * - **Which items.** The ones the pull request's description links with
 *   `Closes <KEY>` or `Refs <KEY>` (`pull_requests.issue_link`), each moved
 *   on its own; a pull request that links none moves nothing.
 * - **Blocking.** An open item not in `blocked` is moved there with a
 *   comment naming each park's class (the ADR-0010 registry's,
 *   `autonomy.park_classes`) and its reason, or the stop's own class and
 *   reason where no park framed it. The comment carries a marker recording
 *   the pull request, the stop and the state the item left. One stop blocks
 *   an item once: an item a person moved out of `blocked` while that stop
 *   stands is left where they put it.
 * - **Returning.** An item in `blocked` whose newest marker names this pull
 *   request is moved back to the state that marker recorded once the
 *   ledger reads `driving`, `converged` or `stale`. An item in `blocked` with
 *   no marker of this pull request was put there by a person and is left.
 *
 * This module is pure: what to do with one item, the comment, the marker.
 * The writers read and write the tracker (`do-item/scripts/lib/blocked-move.ts`).
 */
import type { Projected } from "./projection.ts";

/** The hidden marker a blocking comment carries. */
export const BLOCKED_MARKER = "jig:blocked";

/** What the marker records: the pull request, the stop it was for, and the state the item left. */
export interface BlockedMarker {
  pr: number;
  /** The stop: the run's lock acquisition time, else its round (`stopKey`). */
  stop: string;
  /** The canonical state the item left. */
  from: string;
}

/** The states an item may be blocked from and returned to: open, never closed and never `blocked`. */
export const RETURNABLE = [
  "triage",
  "backlog",
  "todo",
  "in_progress",
  "pr_open",
  "in_review",
  "ops_pending",
] as const;

const MARKER_LINE = /<!--\s*jig:blocked\s+(\{[^\n]*?\})\s*-->/g;

/** The marker's line. */
export function blockedMarkerLine(marker: BlockedMarker): string {
  return `<!-- ${BLOCKED_MARKER} ${JSON.stringify(marker)} -->`;
}

/** Each well-formed marker in one comment's body; a malformed one is skipped. */
export function blockedMarkersIn(body: string): BlockedMarker[] {
  const out: BlockedMarker[] = [];
  for (const m of body.matchAll(MARKER_LINE)) {
    let value: unknown;
    try {
      value = JSON.parse(m[1] as string);
    } catch {
      continue;
    }
    const v = value as Partial<BlockedMarker> | null;
    if (
      v !== null &&
      typeof v === "object" &&
      typeof v.pr === "number" &&
      Number.isSafeInteger(v.pr) &&
      typeof v.stop === "string" &&
      typeof v.from === "string" &&
      (RETURNABLE as readonly string[]).includes(v.from)
    )
      out.push({ pr: v.pr, stop: v.stop, from: v.from });
  }
  return out;
}

/** The newest marker in `comments` (oldest first): which pull request and stop blocked the item last. */
export function newestMarker(
  comments: ReadonlyArray<{ body: string }>,
): BlockedMarker | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const found = blockedMarkersIn((comments[i] as { body: string }).body);
    if (found.length > 0) return found.at(-1) as BlockedMarker;
  }
  return null;
}

/** Which stop a ledger's park is: its run's lock acquisition time, else its round. */
export function stopKey(
  started: string | null | undefined,
  round: number,
): string {
  return started !== undefined && started !== null && started !== ""
    ? started
    : `round ${round}`;
}

/** One park, or the stop's own cause where no park framed it: its class and its reason. */
export interface ParkCause {
  class: string;
  reason: string;
}

/** What the projection wants of the items: `blocked`, back out of it, or nothing (a state it cannot tell, or no ledger). */
export type Want = "blocked" | "unblocked" | "none";

/** What a projected state label asks of the items behind the pull request. */
export function wantOf(projected: Projected): Want {
  if (projected === "unknown" || projected.state === null) return "none";
  if (projected.state === "parked") return "blocked";
  return projected.state === "driving" ||
    projected.state === "converged" ||
    projected.state === "stale"
    ? "unblocked"
    : "none";
}

/** One item as the decision reads it. */
export interface ItemReading {
  key: string;
  /** Its canonical state, `null` where no configured name matches its state. */
  canonical: string | null;
  /** The tracker's name for its state. */
  stateName: string;
  closed: boolean;
}

export type ItemDecision =
  | { move: "none"; why: string }
  | { move: "block"; marker: BlockedMarker }
  | { move: "return"; to: string };

/** What to do with one item. */
export function decideItem(input: {
  want: Want;
  pr: number;
  stop: string;
  item: ItemReading;
  /** The newest marker on the item, from a trusted comment. */
  marker: BlockedMarker | null;
}): ItemDecision {
  const { want, pr, stop, item, marker } = input;
  if (want === "none")
    return { move: "none", why: "the ledger gives no state to project" };
  if (item.closed)
    return { move: "none", why: `${item.key} is closed (${item.stateName})` };
  const isBlocked = item.canonical === "blocked";
  if (want === "blocked") {
    if (isBlocked)
      return { move: "none", why: `${item.key} is already blocked` };
    if (marker !== null && marker.pr === pr && marker.stop === stop)
      return {
        move: "none",
        why: `${item.key} left blocked while this stop stands: a person moved it, so it stays in ${item.stateName}`,
      };
    if (
      item.canonical === null ||
      !(RETURNABLE as readonly string[]).includes(item.canonical)
    )
      return {
        move: "none",
        why: `${item.key} is in ${item.stateName}, which no open canonical state names, so it could not be returned there`,
      };
    return { move: "block", marker: { pr, stop, from: item.canonical } };
  }
  if (!isBlocked) return { move: "none", why: `${item.key} is not blocked` };
  if (marker === null || marker.pr !== pr)
    return {
      move: "none",
      why: `${item.key} was not blocked by this pull request's drive, so a person moves it out`,
    };
  return { move: "return", to: marker.from };
}

/** The blocking comment: each cause, where the item returns, and the marker. */
export function blockingComment(input: {
  pr: number;
  prUrl: string | null;
  causes: readonly ParkCause[];
  fromName: string;
  marker: BlockedMarker;
}): string {
  const pr = input.prUrl ? `[#${input.pr}](${input.prUrl})` : `#${input.pr}`;
  const causes =
    input.causes.length === 0
      ? [
          "- `parked`: the drive stopped, and only a person settles what is left",
        ]
      : input.causes.map((c) => `- \`${c.class}\`: ${oneLine(c.reason)}`);
  return [
    `Blocked: the drive on pull request ${pr} stopped, and only parked work is left.`,
    "",
    ...causes,
    "",
    `It returns to ${input.fromName} when the park is answered and the drive re-arms.`,
    "",
    blockedMarkerLine(input.marker),
  ].join("\n");
}

/** The returning comment. */
export function returningComment(pr: number, toName: string): string {
  return `Unblocked: the drive on pull request #${pr} runs again, so this item returns to ${toName}.`;
}

/** One line, for a field and a list entry. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The reason a blocked field carries: each cause's class and reason, on one line. */
export function blockedReason(causes: readonly ParkCause[]): string {
  return causes.length === 0
    ? "parked: the drive stopped, and only a person settles what is left"
    : causes.map((c) => `${c.class}: ${oneLine(c.reason)}`).join("; ");
}

/**
 * The keys a pull request's description links with `Closes <KEY>` or
 * `Refs <KEY>`, in order, each once. `keySource` is the tracker's pattern
 * for one key in running text (`IssueKeys.source`).
 */
export function linkedKeys(body: string, keySource: string): string[] {
  const re = new RegExp(`\\b(?:closes|refs)\\s+(${keySource})`, "gi");
  const out: string[] = [];
  for (const m of body.matchAll(re)) {
    const key = m[1] as string;
    if (!out.some((k) => k.toLowerCase() === key.toLowerCase())) out.push(key);
  }
  return out;
}

/** A park as the ledger keeps it, as far as its cause goes. */
export interface ParkLike {
  class?: string;
  reason?: string;
  decision?: { class?: string; call?: { question?: string } };
}

/**
 * Each park's class and reason: its decision record's where it has one, else
 * the class and reason it was parked with. `fallback` is the stop's own
 * cause, for a stop no park framed (a person's stop, a circuit breaker).
 */
export function parkCauses(
  parks: readonly ParkLike[],
  fallback: ParkCause,
): ParkCause[] {
  if (parks.length === 0) return [fallback];
  return parks.map((p) => ({
    class: p.decision?.class ?? p.class ?? fallback.class,
    reason: p.decision?.call?.question ?? p.reason ?? fallback.reason,
  }));
}
