/**
 * gc's side of the Orca guard record (`shared/orca-guard.ts`) for one
 * worktree Orca manages: write the admission, keep the worktree for a launch
 * marker that settles or came after it, let the removal through Orca run,
 * and delete the admission whatever happened. Whether Jig's plugin for Orca
 * guards launches (its heartbeat is fresh) is recorded on the receipt line;
 * an unguarded collection runs as it would without the plugin.
 */
import { isMapping } from "../../shared/config-layers.ts";
import { GcError } from "../../shared/gc-error.ts";
import {
  admit,
  guardRoot,
  guardState,
  launchVeto,
  sweepLaunches,
} from "../../shared/orca-guard.ts";
import type { CollectionKind, Resource } from "../types.ts";

export type Collected = Awaited<ReturnType<CollectionKind["collect"]>>;

/** A launch marker kept the worktree: a refusal, not a failure. */
export class GuardKeep extends GcError {
  override name = "GuardKeep";
}

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
  sweepLaunches(root);
  const admission = admit(path, root);
  if (!admission.ok) return kept(admission.failure.reason);
  try {
    const early = launchVeto(admission.value, root);
    if (early !== null) return kept(early);
    const done = await body(() => launchVeto(admission.value, root));
    return {
      ...done,
      reason: `${done.reason}; ${guard.reason}`,
      details: {
        ...(isMapping(done.details) ? done.details : details),
        guard: guard.label,
      },
    };
  } finally {
    admission.value.release();
  }
}
