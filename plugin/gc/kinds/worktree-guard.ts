/**
 * gc's side of the launch guard record (`shared/orca-guard.ts`) for one
 * worktree Orca manages: write the admission, keep the worktree for a launch
 * marker that settles or came after it, mark the admission submitted just
 * before `orca worktree rm`, and delete it unless that call was made and
 * gave no answer. A claim kept that way is settled by a later collection of
 * the repository that wrote it: one that takes it over and gets the call's
 * answer, one that finds the worktree gone from Orca's list and from the
 * disk, or one that finds another incarnation of the worktree at its path.
 * Whether Jig's plugin for
 * Orca guards launches (its heartbeat is fresh) is recorded on the receipt
 * line; an unguarded collection runs as it would without the plugin.
 */
import { lstatSync } from "node:fs";
import { isMapping } from "../../shared/config-layers.ts";
import { errnoCode } from "../../shared/errors.ts";
import {
  admit,
  guardRoot,
  guardState,
  incarnationOf,
  launchVeto,
  releaseAbsent,
  releaseSuperseded,
  repositoryOwner,
  type StaleAdmission,
  staleAdmissions,
  sweepLaunches,
  unreadableAdmissions,
} from "../../shared/orca-guard.ts";
import { ok, type Outcome } from "../../shared/outcome.ts";
import type { CollectionKind, Proof, Resource } from "../types.ts";
import { removalAnswered, type StepOutcome } from "../worktree-removal.ts";
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

/** What a guarded collection's removal is given. */
export interface GuardedRemoval {
  /**
   * Why a launch marker now keeps the worktree, or `null`; read after the
   * last read of Orca's registry.
   */
  launched(): string | null;
  /**
   * Mark the admission submitted, immediately before `orca worktree rm`;
   * the call is not made when it fails.
   */
  submit(): StepOutcome;
  /**
   * Hand over the removal's outcome: only the answer of `orca worktree rm`,
   * success or Orca's explicit refusal, releases a submitted admission.
   */
  settle(removed: Outcome<unknown>): void;
  /**
   * Whether the admission is submitted, by this collection or by the dead
   * one it took over, and no answer of `orca worktree rm` settled it: Orca
   * may be deleting the worktree still. Read after `settle`.
   */
  unsettled(): boolean;
}

/**
 * Collect one worktree Orca reports at `path` under gc's admission for
 * `repository`'s collection. `body`
 * removes it with the `GuardedRemoval` it is given. The admission is deleted
 * on every exit unless it was submitted, by this collection or by the dead
 * one it took over, and the removal call gave no answer: then it stays, so
 * the plugin's hook keeps refusing launches into the worktree until a later
 * collection settles it, and the receipt says so.
 */
export async function guardedCollection(
  resource: Resource,
  path: string | null,
  repository: string,
  body: (guard: GuardedRemoval) => Promise<Collected>,
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
  const admitted = admit(path, repository, root);
  if (!admitted.ok) return kept(admitted.failure.reason);
  const admission = admitted.value;
  let answered = false;
  /** Why the admission outlives this collection, or `null` when it is released. */
  const claimKept = (): string | null =>
    admission.submitted === null || answered
      ? null
      : `the launch guard claim stays: orca worktree rm was called under it at ${admission.submitted} and its answer left the removal unsettled, so the next collection asks again`;
  const noting = (reason: string): string => {
    const why = claimKept();
    return why === null ? reason : `${reason}; ${why}`;
  };
  // The heartbeat is read again at each launch check, the last one being the
  // checkpoint before removal, and the receipt records that observation.
  let observed = guard;
  try {
    const early = launchVeto(admission, root);
    if (early !== null) {
      const refused = kept(noting(early));
      return claimKept() === null
        ? refused
        : {
            ...refused,
            details: { ...details, claim: "kept", claimNote: undefined },
          };
    }
    const done = await body({
      launched: () => {
        observed = guardLabel(root);
        return launchVeto(admission, root);
      },
      submit: () => {
        const marked = admission.submit();
        return marked.ok ? ok(undefined) : marked;
      },
      settle: (removed) => {
        answered = removalAnswered(removed);
      },
      unsettled: () => claimKept() !== null,
    });
    return {
      ...done,
      reason: `${noting(done.reason)}; ${observed.reason}`,
      details: {
        ...(isMapping(done.details) ? done.details : details),
        guard: observed.label,
        // The inventory's standing-claim note no longer holds once the claim
        // is settled; the merge over the listed details keeps an absent key.
        claim: claimKept() === null ? undefined : "kept",
        claimNote: undefined,
      },
    };
  } finally {
    if (claimKept() === null) admission.release();
  }
}

/** Whether anything stands at `path`; an error other than its absence counts as present. */
export function onDisk(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ENOENT";
  }
}

/** The receipt detail that marks a resource as a dead collector's claim on a worktree that is gone. */
const GONE = "gone";

/** Whether `resource` is a claim `goneClaims` listed. */
export function isGoneClaim(resource: Resource): boolean {
  return isMapping(resource.details) && resource.details.claim === GONE;
}

/**
 * The admissions collectors that ended left on worktrees `mine` accepts, and
 * whether `repository` owns each: an admission names the repository whose
 * collection wrote it, and only that repository's list of Orca's worktrees
 * can hold the worktree. One written before admissions named a repository is
 * owned by none.
 */
function claimsUnder(
  mine: (path: string) => boolean,
  repository: string,
  root: string,
): { admission: StaleAdmission; owned: boolean }[] {
  const owner = repositoryOwner(repository);
  return staleAdmissions(root)
    .filter(({ path }) => mine(path))
    .map((admission) => ({
      admission,
      owned: admission.repository === owner,
    }));
}

/** The receipt detail on a gone claim no repository's list can settle: it names no repository. */
const UNOWNED =
  "it was written before launch guard admissions named their repository, so absence from this repository's list of Orca's worktrees does not show the worktree gone; it blocks launches at its path until it is removed after inspection";

/**
 * A resource for each admission a collector that ended left on a worktree
 * `mine` accepts and that is gone from the disk, written by `repository`'s
 * collection or by one that named no repository; the caller keeps only those
 * Orca's list does not hold either. Collecting one deletes the admission,
 * which nothing else would, since a gone worktree is never collected again.
 * One that names no repository is reported, never collected.
 */
export function goneClaims(
  mine: (path: string) => boolean,
  repository: string,
  root = guardRoot(),
): Resource[] {
  return claimsUnder(mine, repository, root)
    .filter(
      ({ admission, owned }) =>
        (owned || admission.repository === null) && !onDisk(admission.path),
    )
    .map(({ admission: { path, submitted }, owned }) => ({
      id: path,
      details: {
        runtime: "orca",
        orcaPath: path,
        claim: GONE,
        ...(submitted === null ? {} : { submitted }),
        ...(owned ? {} : { unowned: UNOWNED }),
      },
    }));
}

/** The receipt detail that marks a resource as a dead collector's claim on an earlier incarnation of a worktree. */
const SUPERSEDED = "superseded";

/** Whether `resource` is a claim `supersededClaims` listed. */
export function isSupersededClaim(resource: Resource): boolean {
  return isMapping(resource.details) && resource.details.claim === SUPERSEDED;
}

/**
 * A resource for each admission `repository`'s collection left, when it
 * ended, on a worktree `mine` accepts that has been made again: what stands
 * at its path is another incarnation than the one it claimed. The removal it
 * claimed is settled, and the new worktree would otherwise inherit its block
 * on launches. Its id is the admission's file, since the worktree at the
 * path is a resource of its own.
 */
export function supersededClaims(
  mine: (path: string) => boolean,
  repository: string,
  root = guardRoot(),
): Resource[] {
  return claimsUnder(mine, repository, root)
    .filter(({ admission, owned }) => owned && superseded(admission))
    .map(({ admission: { file, path, submitted } }) => ({
      id: file,
      details: {
        runtime: "orca",
        orcaPath: path,
        claim: SUPERSEDED,
        ...(submitted === null ? {} : { submitted }),
      },
    }));
}

/** Whether another incarnation than the one `admission` claimed stands at its path. */
function superseded(admission: StaleAdmission): boolean {
  if (admission.incarnation === null) return false;
  const now = incarnationOf(admission.path);
  return now !== null && now !== admission.incarnation;
}

/** The proof of a superseded claim: decided again when it is collected, under its lock. */
export function proveSuperseded(): Proof {
  return {
    state: "dead",
    reason:
      "the collection that holds the launch guard claim has ended, and the worktree it claimed is gone: another one was made at its path",
  };
}

/** Delete the superseded claim's admission, reading the worktree's incarnation once more under its lock. */
export function releaseSupersededClaim(
  resource: Resource,
  root = guardRoot(),
): Collected {
  const path =
    isMapping(resource.details) && typeof resource.details.orcaPath === "string"
      ? resource.details.orcaPath
      : null;
  if (path === null)
    return { outcome: "refused", reason: "kept: the claim names no worktree" };
  const released = releaseSuperseded(path, root);
  return released.ok
    ? {
        outcome: "collected",
        reason:
          "released the launch guard claim of an earlier worktree at this path, so the one made there since can take launches",
      }
    : { outcome: "refused", reason: `kept: ${released.failure.reason}` };
}

/** The receipt detail that marks a resource as an admission gc cannot read. */
const UNREADABLE = "unreadable";

/** Whether `resource` is an admission `unreadableClaims` listed. */
export function isUnreadableClaim(resource: Resource): boolean {
  return isMapping(resource.details) && resource.details.claim === UNREADABLE;
}

/**
 * A resource for each admission gc cannot read. It still blocks launches, and
 * nothing else would say so: it is reported unverified, never collected.
 */
export function unreadableClaims(root = guardRoot()): Resource[] {
  return unreadableAdmissions(root).map(({ file, reason }) => ({
    id: file,
    details: {
      runtime: "orca",
      claim: UNREADABLE,
      reason: `an admission gc cannot read stands at ${file} (${reason}); it blocks launches until it is removed after inspection`,
    },
  }));
}

/** The proof of an unreadable admission: never collectable, its reason is the receipt's. */
export function proveUnreadable(resource: Resource): Proof {
  const reason =
    isMapping(resource.details) && typeof resource.details.reason === "string"
      ? resource.details.reason
      : "an admission gc cannot read blocks launches";
  return { state: "unverified", reason };
}

/**
 * The dead collectors' claims standing on worktrees that are still on the
 * disk, by path: a worktree that is active, dirty or locked is never
 * collected, so its claim would otherwise go unreported. A claim on an
 * earlier incarnation of the worktree is not standing on it.
 */
export function standingClaims(root = guardRoot()): Map<string, string | null> {
  return new Map(
    staleAdmissions(root)
      .filter(
        (admission) => admission.submitted !== null && !superseded(admission),
      )
      .map(({ path, submitted }) => [path, submitted]),
  );
}

/**
 * The proof that a gone claim's worktree is still gone: Orca's list, read
 * again by `listed`, does not hold it, and nothing stands at its path. A
 * list that cannot be read keeps the claim.
 */
export async function proveGone(
  resource: Resource,
  listed: () => Promise<Outcome<(path: string) => boolean>>,
): Promise<Proof> {
  if (
    isMapping(resource.details) &&
    typeof resource.details.unowned === "string"
  )
    return { state: "unverified", reason: resource.details.unowned };
  const read = await listed();
  if (!read.ok) return { state: "unverified", reason: read.failure.reason };
  if (read.value(resource.id))
    return { state: "live", reason: "Orca lists the worktree again" };
  if (onDisk(resource.id))
    return { state: "live", reason: "the worktree is on the disk again" };
  return {
    state: "dead",
    reason:
      "the worktree is gone from Orca's list and from the disk, and the collection that holds its launch guard claim has ended",
  };
}

/** Delete the gone claim of `repository`'s collection, reading the disk once more under its lock. */
export function releaseGone(
  resource: Resource,
  repository: string,
  root = guardRoot(),
): Collected {
  const released = releaseAbsent(
    resource.id,
    repository,
    () => !onDisk(resource.id),
    root,
  );
  return released.ok
    ? {
        outcome: "collected",
        reason:
          "released the launch guard claim of a worktree gone from Orca's list and from the disk",
      }
    : { outcome: "refused", reason: `kept: ${released.failure.reason}` };
}
