/** The newest tick's needs and queue for this repository, with the line's source recorded once. */
import { readLine } from "../../dispatch/lib/line-store.ts";
import type {
  LineNeed,
  LineQueued,
  LineSnapshot,
} from "../../dispatch/lib/dashboard-contract.ts";
import type { AskContext } from "./station.ts";

/** Each context's line, read once. */
const lines = new WeakMap<AskContext, LineSnapshot | null>();

function lineOf(ctx: AskContext): LineSnapshot | null {
  if (ctx.dispatcher === null) return null;
  if (lines.has(ctx)) return lines.get(ctx) ?? null;
  const line = readLine(ctx.dispatcher);
  ctx.reading.note(
    line.ok
      ? { record: "dispatch-tick-line", read: true, local: true }
      : {
          record: "dispatch-tick-line",
          read: false,
          local: true,
          detail: line.failure.reason,
        },
  );
  const value = line.ok ? line.value : null;
  lines.set(ctx, value);
  return value;
}

export function lineNeeds(ctx: AskContext): LineNeed[] {
  return (lineOf(ctx)?.needs ?? []).filter((n) => n.repo === ctx.address.repo);
}

/** The newest tick's queue entries for this repository. */
export function lineQueue(ctx: AskContext): LineQueued[] {
  return (lineOf(ctx)?.queue ?? []).filter((q) => q.repo === ctx.address.repo);
}

/** The newest tick's busy-holder need about this pull request: a checkout the runtime does not list holds its branch and is in use. */
export function busyHolderNeed(
  ctx: AskContext,
  pr: number,
): LineNeed | undefined {
  return lineNeeds(ctx).find(
    (n) =>
      n.cause === "busy-holder" && (n.pr === pr || n.target === `PR #${pr}`),
  );
}
