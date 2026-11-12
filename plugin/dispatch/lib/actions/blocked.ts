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
  type BlockedOutcome,
  type BlockedPr,
  projectBlocked,
} from "../../../skills/do-item/scripts/lib/blocked-move.ts";
import type { IssueKeys } from "../../../skills/do-item/scripts/lib/tracker/keys.ts";
import {
  type Tracker,
  trackerStateMaps,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { Contention } from "../contention.ts";
import {
  type LabelChange,
  type LabelConfig,
  type Projected,
  stateOf,
} from "../labels.ts";
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

/** Whether the tick projects this pull request: open, read for a ledger, not merged, and not one serialization holds or cannot place. */
function projects(input: BlockedInput, pr: number): boolean {
  return (
    input.read.has(pr) &&
    !input.merged.has(pr) &&
    input.serialized?.held.has(pr) !== true &&
    input.serialized?.unplaced.has(pr) !== true
  );
}

/** The pull request as the writer reads it, from its listing and its ledger. */
function blockedPr(
  drive: DrivenPr,
  pr: BlockedInput["open"][number],
  projected: Projected,
): BlockedPr {
  const { started, round } = drive.evidence;
  return {
    pr: drive.number,
    url: pr.url ?? null,
    body: pr.body ?? "",
    labels: pr.labels ?? [],
    projected,
    stop: stopKey(
      typeof started === "string" ? started : null,
      typeof round === "number" ? round : 0,
    ),
    causes: parkCauses(drive.waiting ?? [], {
      class: drive.class,
      reason: drive.why,
    }),
  };
}

/** Why this pull request's write waits for a later tick; `null` to write it now. */
async function waitsFor(mode: BlockedMode, pr: number): Promise<string | null> {
  return (
    mode.late() ?? (await mode.current?.({ pr, add: [], remove: [] })) ?? null
  );
}

/** The receipt's lines for one pull request's moves, refusals, and reportable skips. */
function receiptLines(target: string, moved: BlockedOutcome[]): BlockedWrite[] {
  return moved
    .filter((o) => o.outcome !== "kept")
    .map((o) => ({
      target,
      item: o.item,
      outcome:
        o.outcome === "refused"
          ? "failed"
          : o.outcome === "skipped"
            ? "skipped"
            : "written",
      detail: o.detail,
    }));
}

/** Move each managed pull request's linked items as its ledger says; the receipt's lines. */
export async function writeBlocked(
  input: BlockedInput,
  mode: BlockedMode,
  project: typeof projectBlocked = projectBlocked,
): Promise<BlockedWrite[]> {
  const { tracker, keys } = input;
  if (!mode.apply || tracker === null || keys === null) return [];
  if (!trackerStateMaps(tracker).some((map) => map.blocked !== null)) return [];
  const out: BlockedWrite[] = [];
  const byNumber = new Map(input.open.map((p) => [p.number, p]));
  for (const drive of [...input.drives].sort((a, b) => a.number - b.number)) {
    const pr = byNumber.get(drive.number);
    const projected = stateOf(drive);
    if (pr === undefined || !projects(input, drive.number)) continue;
    if (projected === "unknown" || projected.state === null) continue;
    const target = `PR #${drive.number}`;
    const waits = await waitsFor(mode, drive.number);
    if (waits !== null) {
      out.push({ target, item: null, outcome: "waits", detail: waits });
      continue;
    }
    const moved = await project(
      tracker,
      keys,
      input.config,
      blockedPr(drive, pr, projected),
    );
    out.push(...receiptLines(target, moved));
  }
  return out;
}
