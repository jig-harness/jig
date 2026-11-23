import type { TickContext } from "./tick-context.ts";
import type { RepoObservation } from "./tick-observe.ts";

/** Only the repository's owning dispatcher reconciles drive ledgers during apply. */
export function canReconcileDriveLedgers(
  context: TickContext,
  { opened, ctx, forge }: RepoObservation,
): boolean {
  return (
    context.apply !== null &&
    opened.listed &&
    opened.stages.has("rearm") &&
    ctx.owner &&
    forge.ok
  );
}
