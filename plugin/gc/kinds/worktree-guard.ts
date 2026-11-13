/**
 * gc's side of the launch guard record (`shared/orca-guard.ts`) for one
 * worktree Orca manages: write the admission, keep the worktree for a launch
 * marker that settles or came after it, let the removal through Orca run,
 * and delete the admission whatever happened. Whether Jig's plugin for Orca
 * guards launches (its heartbeat is fresh) is recorded on the receipt line;
 * an unguarded collection runs as it would without the plugin.
 */
import { isMapping } from "../../shared/config-layers.ts";
import {
  admit,
  guardRoot,
  guardState,
  launchVeto,
  sweepLaunches,
} from "../../shared/orca-guard.ts";
import type { CollectionKind, Resource } from "../types.ts";
import { currentMs } from "../../shared/time.ts";

export type Collected = Awaited<ReturnType<CollectionKind["collect"]>>;

/**
 * The code of a removal step's failure when a launch marker kept the
 * worktree: a refusal, not a failure.
 */
export const LAUNCH_VETO = "launch-veto";

/** `"guarded"` or `"unguarded"`, as a receipt line's `details.guard` says it. */
export function guardLabel(root = guardRoot()): {
  label: "guarded" | "unguarded";
  reason: string;
} {
  const state = guardState(root);
  return {
    label: state.guarded ? "guarded" : "unguarded",
    reason: state.reason,
  };
}

/** When each guard directory was last swept: a run collects many checkouts, and one sweep serves them. */
const swept = new Map<string, number>();
const SWEEP_EVERY_MS = 600_000;

function sweepOncePerRun(root: string): void {
  const last = swept.get(root);
  if (last !== undefined && currentMs() - last < SWEEP_EVERY_MS) return;
  swept.set(root, currentMs());
  sweepLaunches(root);
}

/**
 * Collect one worktree Orca reports at `path` under gc's admission. `body`
 * removes it; the `launched` it is given says, when read, why a launch
 * marker now keeps the worktree, and the body reads it after its last read
 * of Orca's registry.
 */
export async function guardedCollection(
  resource: Resource,
  path: string | null,
  body: (launched: () => string | null) => Promise<Collected>,
  root = guardRoot(),
): Promise<Collected> {
  const guard = guardLabel(root);
  const details = {
    ...(isMapping(resource.details) ? resource.details : {}),
    guard: guard.label,
  };
  const kept = (reason: string): Collected => ({
    outcome: "refused",
    reason: `kept: ${reason}; ${guard.reason}`,
    details,
  });
  if (path === null) return kept("Orca's path of the worktree is unknown");
  sweepOncePerRun(root);
  const admission = admit(path, root);
  if (!admission.ok) return kept(admission.failure.reason);
  // The heartbeat is read again at each launch check, the last one being the
  // checkpoint before removal, and the receipt records that observation.
  let observed = guard;
  try {
    const early = launchVeto(admission.value, root);
    if (early !== null) return kept(early);
    const done = await body(() => {
      observed = guardLabel(root);
      return launchVeto(admission.value, root);
    });
    return {
      ...done,
      reason: `${done.reason}; ${observed.reason}`,
      details: {
        ...(isMapping(done.details) ? done.details : details),
        guard: observed.label,
      },
    };
  } finally {
    admission.value.release();
  }
}
