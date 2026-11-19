/**
 * A pickup stopped by a fault of its host rather than of its work: the
 * root filesystem out of space or inodes, a state directory it cannot
 * write, a result the host could not record. The tick tells one from its
 * own records alone, by the first of:
 *
 * - its result or exit could not be written on this host
 *   (`unwritten-result.ts`);
 * - its closing report names the host's environment as the cause
 *   (`cause: environment`);
 * - the question it stopped on is about the host's own fault: it names
 *   exhausted space or inodes, or a file system or state directory that
 *   cannot be written (`HOST_FAULT_QUESTION`).
 *
 * Such a stop asks nothing of a person. While the host's health check fails
 * the item is held with the fault named; once it passes, a claimed item is
 * relaunched once in its own tree to resume the pickup, and an item the
 * pass never claimed is picked up again (`plan-pickups.ts`,
 * `pickup-relaunch.ts`). A restart that stops on a host fault again is not
 * restarted a second time: it is one need, which a diagnosing session (the
 * steward) or a person takes.
 */
import type { ReadRecord } from "./launches.ts";
import { unwrittenResult } from "./session-startup.ts";
import { questionOf } from "./session.ts";

/** A question about the host's own fault rather than the work's. */
export const HOST_FAULT_QUESTION =
  /\b(?:inodes?|no space left|ENOSPC|EDQUOT|disk (?:is )?full|out of (?:disk )?space|read-only file ?system|EROFS|(?:state|dispatch) (?:directory|database) (?:is )?(?:not writable|unwritable|read-only))\b/i;

/** How the tick told a host fault. */
export type HostFaultKind = "unwritten" | "environment" | "question";

/** A pickup's stop on a fault of its host, and how it was told. */
export interface HostFault {
  kind: HostFaultKind;
  why: string;
}

/**
 * The question an ended pickup left for a person, or `null`: none after
 * `done` or a rate-limit wait, else the pass's trailing question, else the
 * question its closing report asks, or for a parked pass the question of its
 * framed decision. Question planning and
 * the release of unclaimed members read this one policy.
 */
export function endedQuestion(r: ReadRecord): string | null {
  if (r.result === "done" || r.result === "waits") return null;
  return (
    questionOf(r.state) ??
    r.report?.report.question ??
    (r.result === "parked" ? (r.framed?.decision.call.question ?? null) : null)
  );
}

/** The host fault an ended pickup stopped on, or `null` when it ended on its work, handed its item on or is still running. */
export function hostFault(r: ReadRecord): HostFault | null {
  if (r.record.action !== "pickup") return null;
  if (r.state.kind !== "ended" && r.state.kind !== "died") return null;
  if (unwrittenResult(r))
    return {
      kind: "unwritten",
      why: `its result or exit could not be written on this host (since ${r.unwritten})`,
    };
  if (r.result === "done" || r.result === "waits") return null;
  if (r.report?.report.cause === "environment")
    return {
      kind: "environment",
      why: "its closing report names the host's environment as the cause",
    };
  const asked = endedQuestion(r);
  if (asked !== null && HOST_FAULT_QUESTION.test(asked))
    return {
      kind: "question",
      why: `the question it stopped on is about the host's own fault: ${asked.replace(/\s+/g, " ").trim().slice(0, 300)}`,
    };
  return null;
}

/**
 * Whether `latest` restarted a pickup that stopped on a host fault and
 * stopped on one again: a relaunch whose source did, or a fresh pickup
 * after one of this item that did. Its pickup is not restarted again.
 */
export function faultedAgain(
  latest: ReadRecord,
  launches: readonly ReadRecord[],
  item: string,
): ReadRecord | null {
  if (hostFault(latest) === null) return null;
  const source =
    latest.record.relaunchOf === undefined
      ? previousPickup(latest, launches, item)
      : launches.find((r) => r.record.id === latest.record.relaunchOf);
  return source !== undefined && hostFault(source) !== null ? source : null;
}

/** The item's pickup made just before `latest`, if any. */
function previousPickup(
  latest: ReadRecord,
  launches: readonly ReadRecord[],
  item: string,
): ReadRecord | undefined {
  return launches
    .filter(
      (r) =>
        r.record.action === "pickup" &&
        r.record.id !== latest.record.id &&
        r.record.createdAt < latest.record.createdAt &&
        (r.record.item === item ||
          r.record.batchItems?.some((i) => i.key === item) === true),
    )
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt))
    .at(-1);
}
