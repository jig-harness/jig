import { ciHoldTransitions } from "../ci-hold.ts";
import { ciHoldLabelSetting } from "../overlay.ts";
import { timelineEvents } from "../pr-timeline.ts";

/** The repository's CI-hold label (`ci.hold_label`), or `null` when it has none. */
export function holdLabel(): string | null {
  return ciHoldLabelSetting() ?? null;
}

/** How messages name the hold label. */
export function holdLabelName(): string {
  return holdLabel() ?? "CI hold";
}

/**
 * The PR's CI-hold label-transition timeline, straight from GitHub — the live
 * source of truth a local stored state can only ever cache. Shared by
 * `set-verified` (freshness proof) and `reset` (destructive-recovery guard): a
 * local file's raw bytes can be truncated before the `ciHold` key was ever
 * serialized — `freshState()` emits it after several other fields — so scanning
 * only those bytes for evidence produces a false "no evidence" on a transition
 * that is very much live on GitHub. Unreadable (`null`) for a repository
 * without a hold label: an older drive may have held under a label the
 * configuration no longer names, and no timeline read can rule that out.
 * `set-verified` does not read it in that mode.
 */
export async function readCiHoldTimeline(
  pr: string,
): Promise<ReturnType<typeof ciHoldTransitions>> {
  const label = holdLabel();
  if (label === null) return null;
  const events = await timelineEvents(pr);
  return events === null ? null : ciHoldTransitions(events, label);
}
