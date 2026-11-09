import { derivedNext } from "../../dispatch/lib/next-owner.ts";
/**
 * The `followup` station of a merged pull request: who holds its follow-up,
 * whether it is claimed, done or failed, and how its last pass ended, from
 * the follow-up marker on the pull request (the claim of the forge-claims
 * module: the earliest trusted marker wins) and, on the machine that
 * dispatched it, its launch record and its row in the outcome log.
 */
import { sharedClaimsFrom } from "../../shared/records/shared-forge.ts";
import {
  open,
  type ReadClaim,
  type SharedClaim,
  unreadable,
  winners,
} from "../../shared/records/shared.ts";
import { lastEnded, type LogRow } from "../../dispatch/lib/log.ts";
import { statePath } from "../../dispatch/lib/state.ts";
import { type Holder, type Last, personWait, type WaitsOn } from "./answer.ts";
import { readComments } from "./forge.ts";
import {
  type AskContext,
  dispatcherReads,
  holdingRecord,
  labelThread,
  lastOfRow,
  pullFor,
  recordHolder,
  type StationAnswer,
} from "./station.ts";
import {
  claimEntries,
  localLaunchEntries,
  logEntries,
  loggedRecords,
} from "./thread.ts";

/** The marker that holds the follow-up: the earliest trusted one that reads. */
function markerOf(winning: readonly ReadClaim[]): ReadClaim | null {
  return winning[0] ?? null;
}

function stateOf(
  merged: boolean,
  marker: ReadClaim | null,
  damaged: boolean,
): { state: string; detail: string } {
  if (!merged)
    return {
      state: "not merged",
      detail: "a follow-up starts once the pull request merges",
    };
  if (marker === null)
    return damaged
      ? {
          state: "unknown",
          detail:
            "a trusted follow-up marker does not read; it holds the follow-up until a person settles it",
        }
      : {
          state: "not claimed",
          detail: "no follow-up marker on the pull request",
        };
  const end = marker.says.value.end;
  const by = `marker ${marker.id} (${marker.says.value.run === "tick" ? "a dispatcher's" : `${marker.login}'s run`})`;
  if (end === null)
    return { state: "claimed", detail: `${by} has no answer yet` };
  if (end.state === "died")
    return { state: "failed", detail: `${by}: its pass died: ${end.reason}` };
  return end.outcome !== "done"
    ? {
        state: "failed",
        detail: `${by}: its pass ended without recording done${end.outcome === null ? " (no result recorded)" : ""}`,
      }
    : {
        state: "done",
        detail: `${by}: done${end.at === "" ? "" : ` ${end.at}`}`,
      };
}

function waitsOnOf(state: string, detail: string, ctx: AskContext): WaitsOn {
  if (state === "failed") return personWait("re-run the follow-up", detail);
  if (state === "not claimed" && ctx.dispatches)
    return {
      waiting: "the dispatcher's next tick, which starts the follow-up",
    };
  return "none";
}

function holderOf(marker: ReadClaim | null, ctx: AskContext): Holder | "none" {
  if (marker === null || !open(marker)) return "none";
  const says = marker.says.value;
  if (says.run === "manual")
    return {
      stage: "followup",
      host: "unknown",
      generation: null,
      process: "unknown",
      why: `a run ${marker.login} started (marker ${marker.id})`,
    };
  return {
    stage: "followup",
    host:
      says.host !== null && says.host === ctx.host
        ? "this machine"
        : (says.host ?? "unknown"),
    generation: null,
    process: "unknown",
    why: `marker ${marker.id} has no answer; whether its pass runs is its host's to know`,
  };
}

function lastOf(
  marker: ReadClaim | null,
  rows: readonly LogRow[],
): Last | null {
  const row = lastEnded(rows, ["followup"]);
  const fromRow = row === null ? null : lastOfRow(row);
  const claimed = marker === null ? null : lastOfMarker(marker);
  // The newer of the two ends: another host may have ended a pass after this machine's last row.
  if (fromRow === null || claimed === null) return fromRow ?? claimed;
  return (Date.parse(claimed.at) || 0) > (Date.parse(fromRow.at) || 0)
    ? claimed
    : fromRow;
}

/** A marker's end as the last pass. */
function lastOfMarker(marker: ReadClaim): Last | null {
  const end = marker.says.value.end;
  if (end === null) return null;
  // A person's run marked done carries no time of its own: the marker's.
  const at = end.at === "" ? marker.createdAt : end.at;
  if (end.state === "died")
    return {
      class: "died",
      at,
      reason: end.reason,
      from: "launch claim",
      next: derivedNext("followup", "died", end.reason),
    };
  return {
    class: end.outcome === "done" ? "converged" : "gates failed",
    at,
    reason: `result ${end.outcome ?? "unrecorded"}`,
    from: "launch claim",
    next: derivedNext(
      "followup",
      end.outcome === "done" ? "converged" : "gates failed",
      `result ${end.outcome ?? "unrecorded"}`,
    ),
  };
}

/** The follow-up markers among the pull request's comments, noted in the sources. */
async function markersOf(
  ctx: AskContext,
): Promise<{ claims: SharedClaim[]; read: boolean }> {
  const { reading, address } = ctx;
  const pr = Number(address.key);
  const listed = await readComments(reading, address.repo, pr);
  reading.note({
    record: "dispatch-followup",
    read: listed.ok,
    ...(listed.ok ? {} : { detail: listed.failure.reason }),
  });
  return {
    read: listed.ok,
    claims: listed.ok
      ? sharedClaimsFrom(
          "followup",
          listed.value,
          { repo: address.repo, pr },
          ctx.login,
        )
      : [],
  };
}

/** The `followup` station's answer. */
export async function askFollowup(ctx: AskContext): Promise<StationAnswer> {
  const pull = await pullFor(ctx);
  if (pull.absent) return pull.answer;
  const { doc } = pull;
  const pr = doc.number;
  const { claims: markers, read: markersRead } = await markersOf(ctx);
  const marker = markerOf(winners(markers));
  const local = await dispatcherReads(
    ctx,
    (r) => r.record.action === "followup" && r.record.pr === pr,
    `PR #${pr}`,
  );
  const rows = local.rows.filter((r) => r.stage === "followup");
  const { state, detail } = !pull.read
    ? {
        state: "unknown",
        detail:
          "the pull request did not read, so whether it merged is not known",
      }
    : !markersRead
      ? {
          state: "unknown",
          detail:
            "the pull request's comments did not read, so whether a follow-up marker exists is not known",
        }
      : stateOf(doc.state === "MERGED", marker, unreadable(markers).length > 0);
  const holding = holdingRecord(local.records);
  const path = ctx.dispatcher === null ? "" : statePath(ctx.dispatcher);
  const claimed = new Set(
    winners(markers).flatMap((c) =>
      c.says.value.record !== null ? [c.says.value.record] : [],
    ),
  );
  return {
    found: true,
    title: doc.title === "" ? null : doc.title,
    url: doc.url,
    holder:
      holding === null ? holderOf(marker, ctx) : recordHolder(holding, null),
    state,
    stateDetail: detail,
    waitsOn: holding === null ? waitsOnOf(state, detail, ctx) : "none",
    last: lastOf(marker, rows),
    entries: [
      ...claimEntries(markers, ctx.name, doc.url, loggedRecords(rows)),
      ...localLaunchEntries(local.records, ctx.name, claimed, path),
      ...logEntries(rows, ctx.name, path),
      ...(ctx.thread ? await labelThread(ctx, pr, doc.url) : []),
    ],
  };
}
