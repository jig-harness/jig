/**
 * The name grammar every drive-pr artifact under `resolveStateDir` is
 * written with — shared between `reap-state.ts` (which uses it to decide
 * what it may compact/retire) and the legacy-state-dir guard
 * (`legacy-state.ts`, which uses it only to decide whether the OLD
 * `--git-common-dir` default still holds anything this skill wrote).
 *
 * Extracted out of `reap-state.ts` rather than re-declared: a
 * second, independently maintained copy of these regexes is exactly the drift
 * `references/consistency.md` warns about ("if this diff changes a
 * state or timeout, verify every actual consumer is updated") — a lock/lease
 * prefix renamed in `lock.ts`/`lease.ts` and forgotten here would silently
 * blind either consumer, not just one.
 */

/**
 * `lib/state/artifacts.ts`'s richer per-artifact classification — declared
 * here, not there, so it can be attached directly to each pattern below
 * instead of living in a second array `artifacts.ts` would otherwise have to
 * keep in positional lockstep with this one. `legacy-state.ts` and
 * `migrate-legacy-state.ts` (this module's other consumers) have no use for
 * it and simply never read the field — see `artifacts.ts`, which re-exports
 * this type for its own consumers.
 */
export type ArtifactFamily =
  | "arm-output"
  | "driver-pr-lock"
  | "driver-worktree-lock"
  | "held-claim"
  | "legacy-migration-marker"
  | "log"
  | "orphan-marker"
  | "pass-handoff"
  | "pr-lease"
  | "ready-claim"
  | "reaper-delete-lock"
  | "reaper-snapshot"
  | "remote-mutation-lock"
  | "state"
  | "stop-completion"
  | "tree-lease";

/**
 * The anchors `lib/state/lock.ts`'s `createLock` is actually pointed at, as
 * name PATTERNS over the state dir.
 *
 * An explicit allowlist, not an inference from "has a `.lock` suffix": the
 * latter would sweep `drive.ts`'s source-named single-instance locks too,
 * which are a different protocol (see `FOREIGN_LOCKS`). Each entry names the
 * family key it belongs to, which is what decides whether the PR predicate or
 * the worktree predicate governs it (reap-state.ts's own use) — the legacy
 * guard ignores `key` entirely and only cares whether `re` matched at all.
 *
 * `family` travels on the SAME object as `re`/`key`, not in a second,
 * independently-ordered array: a parallel family-tag array paired to this one
 * purely by array index, guarded only by a length check, cannot catch a
 * same-length reorder here silently reassigning every family to the wrong
 * pattern. Attaching `family` directly
 * makes that reordering safe by construction: there is nothing left to fall out
 * of sync with.
 */
export const LOCK_ANCHORS: readonly {
  readonly re: RegExp;
  readonly key: "pr" | "actor";
  readonly family: ArtifactFamily;
}[] = [
  // store.ts — the durable per-PR state file.
  { re: /^drive-pr-([0-9]+)\.json$/, key: "pr", family: "state" },
  // lease.ts LEASE_PREFIX — one per (PR, worktree).
  {
    re: /^pr-drive-lease-([0-9]+)-wt-[0-9a-f]{16}\.json$/,
    key: "pr",
    family: "pr-lease",
  },
  // lease.ts PR_REMOTE_MUTATION_LOCK_PREFIX — a mutex anchor that carries no
  // content of its own, so only its `.lock*` children ever exist on disk.
  {
    re: /^drive-pr-remote-lock-([0-9]+)$/,
    key: "pr",
    family: "remote-mutation-lock",
  },
  // lease.ts TREE_LEASE_PREFIX — one per worktree, whichever PR it drives.
  {
    re: /^drive-tree-lease-(wt-[0-9a-f]{16})\.json$/,
    key: "actor",
    family: "tree-lease",
  },
] as const;

/**
 * Entries that are NOT lock anchors — plain output and claim files that
 * retire with their family but have no quarantine of their own to compact.
 *
 * Every shape here was once missed and fell into `unrecognised` (or, for the
 * `.orphan-warned`/`.held-claim.` exact-match gaps, was silently over-matched)
 * before being added.
 *
 * `family` is attached per-entry for the same reason as `LOCK_ANCHORS`
 * above — see that array's own doc comment.
 */
export const PLAIN_ENTRIES: readonly {
  readonly re: RegExp;
  readonly key: "pr" | "actor";
  readonly family: ArtifactFamily;
}[] = [
  {
    re: /^drive-pr-([0-9]+)\.stop-complete\.[0-9a-f]{24}\.json(?:\.[0-9]+\.tmp)?$/,
    key: "pr",
    family: "stop-completion",
  },
  // The driver log, and the generation `lib/driver-log.ts` rotates it to.
  { re: /^drive-pr-([0-9]+)\.log(?:\.1)?$/, key: "pr", family: "log" },
  {
    re: /^drive-pr-([0-9]+)\.ready-claim(?:\.released\.[0-9]+)?$/,
    key: "pr",
    family: "ready-claim",
  },
  {
    re: /^drive-pr-([0-9]+)\.held-claim\..+\.[0-9a-f]{16}(?:\.released\.[0-9]+)?$/,
    key: "pr",
    family: "held-claim",
  },
  { re: /^drive-arm-([0-9]+)\.out$/, key: "pr", family: "arm-output" },
  // pass-handoff.ts — kept answers and an over-long pass notice.
  {
    re: /^drive-pr-([0-9]+)\.(?:answers\.json|notice\.md)(?:\.[0-9a-f]{6})?$/,
    key: "pr",
    family: "pass-handoff",
  },
  {
    re: /^\.drive-pr-([0-9]+)\.orphan-warned(?:\.abandoned\.[0-9]+)?$/,
    key: "pr",
    family: "orphan-marker",
  },
  { re: /^drive-pr-([0-9]+)\.json\.[0-9a-f]{6}$/, key: "pr", family: "state" },
  {
    re: /^pr-drive-lease-([0-9]+)-wt-[0-9a-f]{16}\.json\.[0-9a-f]{6}$/,
    key: "pr",
    family: "pr-lease",
  },
  {
    re: /^drive-tree-lease-(wt-[0-9a-f]{16})\.json\.[0-9a-f]{6}$/,
    key: "actor",
    family: "tree-lease",
  },
] as const;

/**
 * `drive.ts`'s source-named single-instance locks — recognised so a consumer
 * can account for them even though they are not part of the `LOCK_ANCHORS`
 * family/quarantine protocol (they own their own cleanup).
 */
export const FOREIGN_LOCKS: readonly RegExp[] = [
  /^pr-drive-[0-9]+\.lock$/,
  /^pr-drive-worktree-[0-9a-f]{16}\.lock$/,
] as const;

/**
 * `lib/state/lock.ts`'s `.compacting.<canonical>.<24-hex>` staging-leftover
 * grammar — the pattern `sweepLockQuarantine` uses to recover the canonical
 * name a staging copy represents.
 */
export const COMPACTING_STAGING_RE = /^\.compacting\.(.+)\.[0-9a-f]{24}$/;

/**
 * Strip `lib/state/lock.ts`'s lock-suffix grammar off an entry name, returning
 * the anchor it belongs to — or `null` when the name is not part of a lock. The
 * suffix grammar is matched exactly, not with a wildcard: a wildcard tail
 * attributes foreign files that merely start with `.lock` to a family.
 *
 * `generationRe` is a PATTERN STRING (a regex `.source`, e.g. `lock.ts`'s
 * `LOCK_GENERATION_RE`), not a `RegExp` instance — it is spliced directly
 * into a larger pattern string below, and a `RegExp` there would interpolate
 * via `.toString()` and splice in its enclosing `/…/` delimiters as LITERAL
 * characters, silently making every suffix match fail closed to `null`.
 */
export function anchorOf(name: string, generationRe: string): string | null {
  const staging = COMPACTING_STAGING_RE.exec(name);
  if (staging !== null) {
    const stagedLock = new RegExp(
      `^(.*?)\\.lock(?:\\.recovering)?\\.stale\\.${generationRe}$`,
    ).exec(staging[1] ?? "");
    return stagedLock === null ? null : (stagedLock[1] ?? null);
  }
  const lock = new RegExp(
    `^(.*?)\\.lock(?:\\.recovering)?(?:\\.stale\\.${generationRe})?$`,
  ).exec(name);
  return lock === null ? null : (lock[1] ?? null);
}

/** One `LOCK_ANCHORS`/`PLAIN_ENTRIES` family — `id` is `${kind}:${subject}`. */
export interface ClassifiedFamily {
  readonly id: string;
  readonly kind: "pr" | "actor";
  readonly subject: string;
  readonly names: string[];
  readonly anchors: Set<string>;
}

/**
 * Group `names` into the drive-pr families `LOCK_ANCHORS`/`PLAIN_ENTRIES`
 * recognise, plus whatever neither of those nor `FOREIGN_LOCKS` matched.
 *
 * Deliberately WITHOUT `reap-state.ts`'s `isReapOwnArtifact` pre-filter — that
 * skip exists so the reaper does not attribute its OWN bookkeeping
 * (`.reap-state-snapshot.json`, its delete-run lock) to a drive-pr family, a
 * distinction only reap-state.ts's callers care about. Every other consumer
 * (`legacy-state.ts`) either has no such artifacts to exclude or does not
 * care whether an unfiltered reap artifact lands in `unrecognised` — it never
 * inspects that population. `reap-state.ts`'s own `classify()` pre-filters
 * those names out before delegating here, which produces the identical
 * result its test suite already pins.
 */
export function classifyEntries(
  names: readonly string[],
  generationRe: string,
): {
  families: Map<string, ClassifiedFamily>;
  foreign: string[];
  unrecognised: string[];
} {
  const families = new Map<string, ClassifiedFamily>();
  const foreign: string[] = [];
  const unrecognised: string[] = [];

  const family = (kind: "pr" | "actor", subject: string): ClassifiedFamily => {
    const id = `${kind}:${subject}`;
    let f = families.get(id);
    if (f === undefined) {
      f = { id, kind, subject, names: [], anchors: new Set() };
      families.set(id, f);
    }
    return f;
  };

  for (const name of names) {
    if (FOREIGN_LOCKS.some((re) => re.test(name))) {
      foreign.push(name);
      continue;
    }

    const anchor = anchorOf(name, generationRe);
    const subjectName = anchor ?? name;

    const hit = LOCK_ANCHORS.find((a) => a.re.test(subjectName));
    if (hit !== undefined) {
      const m = hit.re.exec(subjectName);
      if (m !== null) {
        const f = family(hit.key, m[1] ?? "");
        f.names.push(name);
        f.anchors.add(subjectName);
        continue;
      }
    }

    if (anchor === null) {
      const plainHit = PLAIN_ENTRIES.find((p) => p.re.test(name));
      if (plainHit !== undefined) {
        const m = plainHit.re.exec(name);
        if (m !== null) {
          family(plainHit.key, m[1] ?? "").names.push(name);
          continue;
        }
      }
    }

    unrecognised.push(name);
  }

  return { families, foreign, unrecognised };
}
