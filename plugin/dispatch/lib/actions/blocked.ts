/**
 * The projection's tracker output at the tick: each managed open pull
 * request's linked items moved to `blocked` while its ledger reads parked,
 * and back to the state they left once it reads driving, converged or stale
 * (`do-item/scripts/lib/blocked-move.ts`). It runs beside the state label
 * write, under its rules: only with `--apply` for a repository the machine
 * file lists and this host owns, never on a pull request serialization holds
 * or a person's `hold` is on, and not before the ledger is read again just
 * before the write (`label-freshness.ts`). Without `--apply` nothing is read
 * from the tracker. A move the tracker refuses is a line of the receipt, and
 * the next tick tries again.
 */
import { parkCauses, stopKey } from "../../../shared/pr-labels/blocked.ts";
import {
  projectBlocked,
  type BlockedOutcome,
} from "../../../skills/do-item/scripts/lib/blocked-move.ts";
import type { IssueKeys } from "../../../skills/do-item/scripts/lib/tracker/keys.ts";
import type { Tracker } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { Contention } from "../contention.ts";
import { type LabelChange, type LabelConfig, stateOf } from "../labels.ts";
import type { BlockedWrite, DrivenPr } from "../types.ts";

export interface BlockedInput {
  config: LabelConfig;
  tracker: Tracker | null;
  keys: IssueKeys | null;
  /** The open pull requests, with their descriptions and labels. */
  open: ReadonlyArray<{
    number: number;
    url?: string;
    body?: string;
    labels?: string[];
  }>;
  /** The open pull requests read for a ledger this tick. */
  read: ReadonlySet<number>;
  drives: readonly DrivenPr[];
  /** The pull requests merged since, which the follow-up moves instead. */
  merged: ReadonlySet<number>;
  serialized?: Pick<Contention, "held" | "unplaced">;
}

export interface BlockedMode {
  apply: boolean;
  late: () => string | null;
  /** Just before a write, why it waits (its ledger changed since the tick read it); `null` to write. */
  current?: (change: LabelChange) => Promise<string | null>;
}

/** Move each managed pull request's linked items as its ledger says; the receipt's lines. */
export async function writeBlocked(
  input: BlockedInput,
  mode: BlockedMode,
  project: typeof projectBlocked = projectBlocked,
): Promise<BlockedWrite[]> {
  const { tracker, keys } = input;
  if (
    !mode.apply ||
    tracker === null ||
    keys === null ||
    tracker.stateName("blocked") === null
  )
    return [];
  const out: BlockedWrite[] = [];
  const byNumber = new Map(input.open.map((p) => [p.number, p]));
  for (const drive of [...input.drives].sort((a, b) => a.number - b.number)) {
    const pr = byNumber.get(drive.number);
    if (
      pr === undefined ||
      !input.read.has(drive.number) ||
      input.merged.has(drive.number) ||
      input.serialized?.held.has(drive.number) === true ||
      input.serialized?.unplaced.has(drive.number) === true
    )
      continue;
    const target = `PR #${drive.number}`;
    const late = mode.late();
    if (late !== null) {
      out.push({ target, item: null, outcome: "waits", detail: late });
      continue;
    }
    const projected = stateOf(drive);
    if (projected === "unknown" || projected.state === null) continue;
    const waits =
      (await mode.current?.({ pr: drive.number, add: [], remove: [] })) ?? null;
    if (waits !== null) {
      out.push({ target, item: null, outcome: "waits", detail: waits });
      continue;
    }
    const moved: BlockedOutcome[] = await project(tracker, keys, input.config, {
      pr: drive.number,
      url: pr.url ?? null,
      body: pr.body ?? "",
      labels: pr.labels ?? [],
      projected,
      stop: stopKey(
        typeof drive.evidence.started === "string"
          ? drive.evidence.started
          : null,
        typeof drive.evidence.round === "number" ? drive.evidence.round : 0,
      ),
      causes: parkCauses(drive.waiting ?? [], {
        class: drive.class,
        reason: drive.why,
      }),
    });
    for (const o of moved)
      if (o.outcome !== "kept")
        out.push({
          target,
          item: o.item,
          outcome: o.outcome === "refused" ? "failed" : "written",
          detail: o.detail,
        });
  }
  return out;
}
