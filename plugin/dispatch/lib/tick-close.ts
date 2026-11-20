/** The tick's closing notes on its receipt: the reflection route's work, and the optional reads a low forge budget skipped. */
import { currentMs } from "../../shared/time.ts";
import type { TickReceipt } from "../receipts.ts";
import { timeLeftMs } from "./actions/launch.ts";
import { routeRecurrences } from "./reflection-route.ts";
import type { TickContext } from "./tick-context.ts";
import { lowBudget, OPTIONAL_READS } from "./tick-reads.ts";

/**
 * The reflection route, after every launch: each class that recurs recorded
 * where reflection is on. What it did goes on the receipt; a failure there
 * leaves the tick's exit status as it is.
 */
export async function routeReflection(
  receipt: TickReceipt,
  context: TickContext,
): Promise<void> {
  const { apply } = context;
  // In the order the repositories were named, not the order their reads finished.
  const named = [...new Set(context.options.repos)];
  const rank = (path: string) => named.indexOf(path);
  const ordered = [...context.reflections].sort(
    (a, b) => rank(a.path) - rank(b.path),
  );
  const reflection = await routeRecurrences(ordered, {
    apply: apply !== null,
    nowMs: currentMs(),
    timeLeftMs: apply === null ? null : timeLeftMs(apply),
  });
  if (reflection !== null) receipt.reflection = reflection;
}

/** Say on the receipt that the optional reads were skipped, when the forge's budget was low as the tick started. */
export async function noteBudget(
  receipt: TickReceipt,
  context: TickContext,
): Promise<void> {
  const budget = await context.reads.budget();
  if (lowBudget(budget))
    receipt.lowBudget = {
      remaining: budget.remaining,
      limit: budget.limit,
      skipped: [...OPTIONAL_READS],
    };
}
