/** The independent writes that settle a dispatcher's shared launch claims. */
import type { LaunchEnd, SharedRecords } from "../../shared/records/shared.ts";
import type { ActionBook } from "./failures.ts";
import { settledEnds, type ReadRecord } from "./launches.ts";
import { retryableFollowup } from "./session-startup.ts";

/** The part of a dispatcher tick's context settlement needs. */
interface SettlementContext {
  records: SharedRecords;
  slug: string;
  host: string;
  root?: string;
}

/** One end this host owes: its own claim's, on a pull request. */
export interface OwedEnd {
  pr: number;
  stage: "drive" | "followup";
  id: number;
  end: LaunchEnd;
  /** The host to name on a marker that names none. */
  host?: string;
}

/** Settle the startup markers a prior retry left for this host. */
export async function settleRetryableFollowups(
  ctx: SettlementContext,
  records: readonly ReadRecord[],
  nowIso: string,
  startupScope: ReadonlySet<number> | undefined,
  settle: (
    ctx: Pick<SettlementContext, "records" | "host">,
    record: ReadRecord,
    nowIso: string,
    root?: string,
  ) => Promise<string[]>,
): Promise<string[]> {
  const settled = settledEnds(ctx.root);
  const failures: string[] = [];
  for (const record of records) {
    if (
      record.record.repo !== ctx.slug ||
      !retryableFollowup(record) ||
      settled.has(record.record.id) ||
      (startupScope !== undefined &&
        !startupScope.has(Number(record.record.pr)))
    )
      continue;
    failures.push(...(await settle(ctx, record, nowIso, ctx.root)));
  }
  return failures;
}

/** The failure-ledger target for one end still owed to the forge. */
export function endTarget(o: OwedEnd): {
  key: string;
  kind: "claim-end" | "marker-answer";
  target: string;
} {
  const kind = o.stage === "drive" ? "claim-end" : "marker-answer";
  return {
    key: `${kind} PR #${o.pr} comment ${o.id}`,
    kind,
    target: `PR #${o.pr}`,
  };
}

/** Publish all owed ends that are not backed off, preserving each failure. */
export async function writeOwedEnds(
  ctx: Pick<SettlementContext, "records" | "slug">,
  owing: readonly OwedEnd[],
  book: ActionBook | undefined,
): Promise<{ failures: string[]; written: Set<number> }> {
  const failures: string[] = [];
  const written = new Set<number>();
  for (const end of owing) {
    const target = endTarget(end);
    const backing = book?.waits(target.key) ?? null;
    if (backing !== null) {
      failures.push(
        `PR #${end.pr}: the end of claim comment ${end.id} waits: ${backing}`,
      );
      continue;
    }
    const result = await ctx.records.end(
      { repo: ctx.slug, pr: end.pr },
      end.stage,
      end.id,
      end.end,
      end.host,
    );
    book?.ran(target, result.ok ? null : result.failure.reason);
    if (result.ok) {
      if (end.stage === "drive") written.add(end.id);
      continue;
    }
    failures.push(
      `PR #${end.pr}: the end of claim comment ${end.id} could not be written: ${result.failure.reason}`,
    );
  }
  return { failures, written };
}
