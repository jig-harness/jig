/**
 * Pending launch records that no tick will launch again. A pending record
 * (no wrapper claimed it, no exit) holds its stage and its account's slot,
 * and its launch is replayed under its own record and key while that can
 * still settle it (`replayable` in `actions/launch.ts`, `retryMarked` in
 * `actions/followup.ts`). A pending record is **stuck** once nothing will:
 *
 * | Record | Why it is stuck |
 * | --- | --- |
 * | both of its launches answered as not started or not answered at all, one at least unanswered | an unanswered launch may have started a session, so a third is never called |
 * | a follow-up whose replay the fresh read could not prove safe (`noReplay`) | its marker is gone, no longer the earliest or answered, or a session is joined to its pull request |
 * | no workspace | there is nowhere to launch it |
 *
 * A stuck record is notified to a person (cause `needs-person`, once, then
 * on `dispatch.renotify_after`, through the notifications' suppression
 * records), and the dashboard shows it as needing a person. It holds its
 * stage and slot until a person clears it (`jig dispatch clear`). A record
 * whose last launch the runtime answered as started is never stuck: its
 * wrapper may still claim it.
 */
import type { LaunchRecord, ReadRecord } from "./launches.ts";
import { pullUrl } from "./forge.ts";
import { targetOf } from "./launches.ts";
import { stuckNotice } from "./notices.ts";
import type { Action } from "./types.ts";

/** A pending record's launch is retried once, under its own key. */
const MAX_ATTEMPTS = 2;

/** Whether a pending record's launch can still be replayed: it has a workspace, its last attempt got no answer, an attempt remains, and no replay was found unsafe. */
export function retryable(record: LaunchRecord): boolean {
  return (
    record.noReplay == null &&
    record.workspace !== null &&
    record.attempts.at(-1)?.outcome !== "sent" &&
    record.attempts.length < MAX_ATTEMPTS
  );
}

/** Why a record is stuck pending, in a clause; `null` when it is not. */
export function stuckWhy(
  read: Pick<ReadRecord, "record" | "state">,
): string | null {
  const { record, state } = read;
  if (state.kind !== "pending" || retryable(record)) return null;
  if (record.noReplay != null) return record.noReplay;
  if (record.attempts.at(-1)?.outcome === "sent") return null;
  if (record.workspace === null) return "it names no workspace to launch into";
  const outcomes = record.attempts.map((a) => a.outcome).join(", ");
  return `none of its ${record.attempts.length} launches was answered as started (${outcomes}) and no wrapper claimed it, so whether a session started cannot be told`;
}

/** The notification of one stuck record, with `why` it is stuck. */
export function stuckAction(
  slug: string,
  read: ReadRecord,
  why: string,
): Action {
  const { record } = read;
  const target = targetOf(record);
  const workspace = record.workspace?.path ?? null;
  return {
    stage: "notify",
    target,
    record: "runtime",
    reason: `launch record ${record.id} is pending and no tick launches it again: ${why}; it holds its stage and a slot of ${record.account} until a person clears it (jig dispatch clear ${record.id})`,
    evidence: {
      record: record.id,
      stage: record.action,
      account: record.account,
      stuck: why,
      ...(record.marker === null ? {} : { marker: record.marker }),
    },
    cause: "needs-person",
    notice: stuckNotice(slug, {
      target,
      action: record.action,
      record: record.id,
      account: record.account,
      workspace,
      marker: record.marker,
      url: record.pr === null ? null : pullUrl(slug, record.pr),
      why,
    }),
    ...(workspace === null ? {} : { workspace }),
  };
}

/** The notifications of `slug`'s stuck records. */
export function planStuck(slug: string, launches: ReadRecord[]): Action[] {
  const actions: Action[] = [];
  for (const read of launches) {
    if (read.record.repo !== slug) continue;
    const why = stuckWhy(read);
    if (why !== null) actions.push(stuckAction(slug, read, why));
  }
  return actions;
}
