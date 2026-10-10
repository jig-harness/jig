/**
 * The legacy-state-dir guard.
 *
 * `resolveStateDir`'s default moved off `--git-common-dir` to
 * stop `.git/` growing without bound. That relocation reproduces,
 * at repo-wide scale, a failure an earlier change's own investigation already hit once
 * by hand: two sibling sessions resolved drive-pr state to two different
 * directories, and each SILENTLY started a fresh round-0 drive over the
 * other's in-flight round budget and held decisions — no error surfaced
 * either time (PRs #4596/#4609). A session running new code must never
 * silently proceed on a fresh, empty new-location state file while the OLD
 * location still holds a drive nobody has migrated — it must refuse loudly
 * instead, and name the fix.
 *
 * Gated on a persistent per-clone MARKER (`migratedMarkerPath`), not
 * re-checked on every `resolveStateDir` call: the check itself is a
 * `readdirSync` of the very directory (`.git`) whose unbounded entry count is
 * this ticket's motivating problem — paying that cost on every invocation,
 * forever, would reintroduce it for exactly the clones that need this fix
 * most (a `.git` with hundreds of thousands of entries measured at ~10s per
 * `readdir`). Once a clone's migration is confirmed (or confirmed
 * unnecessary), the marker makes every later call a plain `existsSync` — the
 * cost this default relocation exists to eliminate is never reintroduced.
 * The residual this trades away: a stray OLD-code session that starts
 * writing to the legacy location AFTER this clone's marker is written is not
 * caught by a later NEW-code call. The incident this guard defends against
 * is the one where NO session has migrated yet and two disagree about where
 * to look — covered unconditionally, since the marker cannot exist until a
 * human has run the migration (or the legacy location was already empty).
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fail } from "../cli.ts";
import { fsyncDirectoryBestEffort } from "./fsutil.ts";
import { LOCK_GENERATION_RE } from "./lock.ts";
import { classifyEntries } from "./state-file-patterns.ts";

/**
 * The bare filename `migratedMarkerPath` writes inside every migrated
 * clone's default state directory — exported so a consumer that needs to
 * recognise the marker by NAME (rather than construct its full path) has
 * one place to import it from, rather than a second hardcoded copy of the
 * string (`reap-state.ts`'s own bookkeeping exclusions — chatgpt-codex-
 * connector, PR #4618 round 13: without this, the reaper's `classify()`
 * had no way to tell this marker apart from real backlog, and reported
 * every healthy migrated clone as containing an "unrecognised" entry).
 */
export const MIGRATED_MARKER_FILENAME = ".migrated-from-legacy";

/**
 * Written once this clone's migration is confirmed — either a human ran the
 * migration script, or the legacy location never held a drive-pr footprint at
 * all (a clone that never drove a PR before an earlier change shipped, or one already
 * on `$DRIVE_PR_STATE_DIR` throughout). Its presence is the ONLY thing that
 * skips the legacy scan on later calls — see the module doc comment.
 */
export function migratedMarkerPath(newDir: string): string {
  return join(newDir, MIGRATED_MARKER_FILENAME);
}

/**
 * Every entry name in `legacyDir` that the drive-pr lock/lease/claim/state
 * grammar recognises as its own — the SAME recognizer `reap-state.ts` uses to
 * decide what it owns (`lib/state/state-file-patterns.ts`, extracted for
 * exactly this reuse). Reused rather than re-declared: a second,
 * independently maintained copy of these name patterns is exactly the drift
 * `references/consistency.md` warns about.
 *
 * Deliberately OVER-inclusive: a lock-quarantine tombstone or a transient
 * claim file carries no meaningful durable content by itself, but its mere
 * presence means a drive-pr process — quite possibly a still-running
 * OLD-code one — has touched this location, which is exactly the condition
 * this guard exists to catch. `unrecognised` entries (git's own files,
 * `worktrees/`, anything this grammar does not name) are excluded: including
 * them would fail closed on ordinary `.git` contents that have nothing to do
 * with this skill, on every clone, forever.
 *
 * A NONEXISTENT `legacyDir` (ENOENT — this process may not be inside a git
 * repo's common dir at all when `$DRIVE_PR_STATE_DIR` was previously the
 * only way it ever ran) reads as "nothing to migrate", the safe direction:
 * there is no state that could be silently abandoned if the directory
 * genuinely is not there. Any OTHER `readdirSync` failure — EACCES, EIO —
 * is a different claim entirely: `resolveLegacyStateDir` has already
 * resolved a real git common directory, so the directory exists and this
 * call simply could not inspect it. Reading that as "empty" would let
 * `ensureMigratedFromLegacy` write the migrated marker over state it never
 * actually looked at, abandoning whatever parked decisions and round budget
 * the guard exists to protect — so only ENOENT is treated as empty; every
 * other error refuses loudly instead (docomply-review, a reference-implementation pull request).
 */
export function legacyFootprint(legacyDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(legacyDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    fail(
      2,
      `drive-pr: cannot read the legacy state location ${legacyDir}: ${(e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.message : String(e))}`,
      "This directory exists but could not be inspected, which may mean it",
      "still holds unmigrated drive-pr state — refusing rather than silently",
      "treating it as empty. Fix the underlying permissions/IO problem and",
      "retry, or run the migration manually once the directory is readable:",
      "  bun <skill-dir>/scripts/migrate-legacy-state.ts --apply",
    );
  }
  const { families, foreign } = classifyEntries(names, LOCK_GENERATION_RE);
  const hit: string[] = [...foreign];
  for (const f of families.values()) hit.push(...f.names);
  return hit;
}

/** Entries named in the refusal before it truncates to "...and N more". */
const MAX_NAMED_ENTRIES = 10;

/**
 * `mkdirSync(dir, { recursive: true })`, fsyncing every NEWLY CREATED
 * ancestor's own parent directory entry — not just `dir`'s immediate
 * parent. Shared by `ensureMigratedFromLegacy` below and
 * `migrate-legacy-state.ts`'s own `--apply` path, which had the mechanically
 * identical creation with no fsync at all: `mkdirSync` alone does not make
 * a new directory ENTRY durable, and a crash right after it, before its
 * parent's own entry for it commits, can lose the directory even though
 * every write later fsynced INSIDE it was individually durable. Worse for
 * `migrate-legacy-state.ts` specifically — its legacy-source deletions are
 * explicitly fsynced (see `copyAndRemove`), so the directory could
 * disappear while the originals it was supposed to replace are already
 * gone (chatgpt-codex-connector, a reference-implementation pull request round 15).
 *
 * `{ recursive: true }` can create SEVERAL path components at once — on a
 * machine with no `~/.local/state/groundwork` at all yet, `dir` sits several
 * new levels deep and `mkdirSync` creates all of them in one call. Fsyncing
 * only `dirname(dir)` protects the deepest new entry alone: the newly created
 * `groundwork` entry in `~/.local/state`, and the newly created `drive-pr`
 * entry in `groundwork`, would both still be uncommitted, so a crash right after this call can lose the
 * WHOLE new hierarchy even though the deepest fsync "succeeded" (chatgpt-
 * codex-connector, PR #4618 round 17). Walking up from `dir` before
 * `mkdirSync` to find every ancestor that does not exist YET, then fsyncing
 * each one's own parent after creation, protects the whole chain — not
 * just its last link.
 *
 * `dirname(dir)` is ALWAYS fsynced, even when `dir` itself already existed
 * before this call (so the walk above found nothing new to add): existence
 * alone is not proof of prior durability. A previous call could have had
 * `mkdirSync` succeed and then crashed, or its fsync itself throw and
 * abort, before ever confirming `dir`'s entry — leaving `dir` visible on a
 * retry with `existed` reading true, which used to skip the fsync
 * permanently. A retry must reconfirm, not trust presence (chatgpt-codex-
 * connector, PR #4618 round 17, fresh evidence after the round-15 fix).
 * One shared helper, not two independently maintained copies, per
 * `references/consistency.md`.
 */
export function createStateDirDurably(dir: string): void {
  const created: string[] = [];
  for (let p = dir; !existsSync(p); p = dirname(p)) {
    created.push(p);
    if (dirname(p) === p) break; // filesystem root — always exists; guards against an infinite loop if it somehow didn't
  }
  mkdirSync(dir, { recursive: true });
  // `created` is deepest-first (`dir` itself, then its parent, …); fsync
  // each one's OWN parent — never itself — to commit that directory's
  // entry in whatever held it. `dirname(dir)` is forced into the set even
  // when `dir` pre-existed (so it is not already `dirname` of some entry
  // in `created`) — see the doc comment above for why presence alone must
  // not skip the reconfirm.
  const toFsync = new Set(created.map((p) => dirname(p)));
  toFsync.add(dirname(dir));
  for (const p of toFsync) fsyncDirectoryBestEffort(p);
}

/**
 * The gate itself: refuse loudly when `legacyDir` still holds an
 * unmigrated drive-pr footprint and this clone's migration has not been
 * recorded — or record that none was ever needed and let the caller proceed.
 *
 * Called with `newDir` already resolved (but not yet required to exist);
 * `createStateDirDurably` here is what makes every later `join(newDir, …)`
 * caller's implicit "the state dir already exists" assumption hold for the
 * new default the same way it always held for `--git-common-dir` (which is
 * always present) — `drive.ts`'s own state-dir consumer, for one, writes its
 * driver log there with no directory creation of its own.
 */
export function ensureMigratedFromLegacy(
  legacyDir: string,
  newDir: string,
): void {
  const marker = migratedMarkerPath(newDir);
  if (existsSync(marker)) return;
  createStateDirDurably(newDir);

  let footprint = legacyFootprint(legacyDir);
  if (footprint.length === 0) {
    // Re-check immediately before publishing, narrowing the window between
    // the scan above and this write to microseconds — the same pattern
    // migrate-legacy-state.ts's publishMigratedMarker() already uses for its
    // own final re-scan. A older process that begins its first
    // legacy write in that gap would otherwise still get the marker
    // published over it: every later resolveStateDir() call trusts the
    // marker without re-scanning, so the old process's state is abandoned
    // permanently, with nothing to notice (chatgpt-codex-connector, PR
    // #4618 round 13). Does not claim to close the window entirely — a
    // process starting after THIS second check is the same accepted
    // residual the module doc above already documents.
    footprint = legacyFootprint(legacyDir);
  }
  if (footprint.length === 0) {
    // Best-effort: a write failure here just means the NEXT call re-scans
    // legacyDir (empty again, cheaply) rather than losing the marker's
    // benefit permanently — never a reason to refuse an otherwise-clean
    // resolution.
    try {
      writeFileSync(marker, "");
    } catch {
      // retried on the next call
    }
    return;
  }

  const shown = footprint.slice(0, MAX_NAMED_ENTRIES);
  const lines = [
    `drive-pr: unmigrated state found in the legacy location, ${legacyDir}:`,
    ...shown.map((n) => `  ${n}`),
  ];
  if (footprint.length > shown.length) {
    lines.push(`  … and ${footprint.length - shown.length} more`);
  }
  lines.push(
    `The default state directory moved to ${newDir} — the legacy`,
    "location grows without bound and slows every git-aware tool that walks",
    "this checkout. Run the one-time migration before continuing:",
    "  bun <skill-dir>/scripts/migrate-legacy-state.ts --apply",
    "(bare, no --apply, prints a dry-run report and changes nothing)",
    "If a drive is currently live against the legacy location, let it finish",
    "or stop it first (bun <skill-dir>/scripts/drives.ts) — the",
    "migration refuses to run while a live lock is held there, for the same",
    "reason this check refuses to proceed silently.",
  );
  fail(2, ...lines);
}
