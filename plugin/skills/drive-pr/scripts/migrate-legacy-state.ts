#!/usr/bin/env bun
/**
 * The one-time, per-clone migration `legacy-state.ts`'s guard sends a human
 * to: copies drive-pr's durable state out of the legacy
 * `--git-common-dir` location into the new default (`~/.local/state/jig/drive-pr/
 * <cloneKey>/`), then marks this clone migrated so `resolveStateDir` never
 * re-scans the legacy location again.
 *
 * ## What "durable state" means here, and what is deliberately left behind
 *
 * Only the content that carries a PARKED HUMAN DECISION or a round budget is
 * MOVED: each family's `LOCK_ANCHORS` bare content file (the state JSON, a
 * PR lease, a tree lease — never `drive-pr-remote-lock-<n>`, which "carries
 * no content of its own" per its own doc comment in `state-file-patterns.ts`)
 * is copied, verified, and its legacy original removed, protected throughout
 * by a REAL per-anchor lock (see the next section). Its `.log`/
 * `.orphan-warned` siblings are COPIED but never removed — see "Why the
 * plain siblings are copied, never deleted" below.
 *
 * Everything else — `.lock`/`.lock.stale.<gen>`/`.lock.recovering*`
 * quarantine, `.compacting.*` staging, and in-flight `.ready-claim`/
 * `.held-claim.*` files — is LEFT IN PLACE, reported, and never touched.
 * More than one reason:
 *
 *   1. It carries no durable content of its own — a quarantine tombstone
 *      exists purely to fence a `rename(2)`, never to be read back.
 *   2. Deleting it here would need the SAME resurrection-race safety
 *      argument `lock.ts`'s own `tombstone` doc comment makes for never
 *      sweeping it naively — "nothing can prove no observer still holds a
 *      reference to that generation" — and this script has no stronger
 *      proof than the reaper does. `reap-state.ts` already owns that
 *      lifecycle (COMPACT/RETIRE) for whichever location `resolveStateDir`
 *      currently resolves to; this migration does not duplicate it.
 *   3. It is FINITE, not growing, the moment nothing writes to the legacy
 *      location anymore — which migrating the durable content and marking
 *      this clone migrated is what accomplishes. The debris left behind is a
 *      one-time remainder, not the unbounded-growth problem an earlier change exists
 *      to fix; a human can `rm -rf` it manually once confident, and this
 *      script names exactly what it left so they can.
 *
 * ## Why the plain siblings are copied, never deleted
 *
 * `.log`/`.orphan-warned` files are appended by callers that take no lock at
 * all (`drive.ts`'s bare `appendFileSync` for its log, `orphans.ts`'s bare
 * `writeFileSync` for `.orphan-warned`) — including while console output is
 * merely being narrated, well outside any window `drive.ts`'s own
 * single-instance lock covers. Three successive fixes each added one more
 * re-read immediately before the delete to narrow the gap a concurrent
 * append could land in, and a measurement then showed the pattern structurally
 * unfixable: the read and the delete are two different syscalls, so there is
 * always one more gap between "the last read that could catch a concurrent
 * write" and the `rmSync` itself — no amount of additional narrowing closes it,
 * it only relocates it one read later.
 *
 * So this script stops trying to win that race and sidesteps it instead:
 * `.log`/`.orphan-warned` files are copied durably (fsynced, byte-verified)
 * but `src` is never removed. Once every family finishes and the marker
 * publishes, `resolveStateDir` never points at `legacyDir` again for ANY
 * caller (see the next section), so nothing ever appends to the retained
 * copy again — it becomes exactly the same self-limiting, harmless debris
 * reasons 1–3 above already accept for lock/quarantine files, reported the
 * same way and safe to remove by hand once confident.
 *
 * ## Exclusion: a global snapshot up front, a REAL per-anchor lock during --apply
 *
 * A one-time directory snapshot at the top of the run does NOT hold for the
 * run's whole duration — a `drive.ts` single-instance lock
 * (`pr-drive-<n>.lock` / `pr-drive-worktree-<hash>.lock`) can appear the
 * instant after this script checked for it, and a bare `existsSync` on an
 * anchor's own `.lock` has the identical gap between the check and the
 * copy-then-delete it was meant to protect. So:
 *
 *   - GLOBALLY refuse the whole run if any `drive.ts` single-instance lock
 *     exists anywhere in the legacy dir at start-up — that is `drive.ts`'s
 *     OWN "a driver is running" signal, and it is refused on sight. This
 *     remains a snapshot, not a guarantee: `drive.ts` owns that protocol's
 *     staging+rename dance internally, and nothing here replicates or
 *     acquires it, so a driver that starts after this check is not stopped
 *     by it. It is a fast, informative early exit for the common case, never
 *     the actual safety mechanism.
 *   - What actually protects each content anchor's copy-then-delete, under
 *     `--apply`, is taking the SAME `createLock` mutex any live or future
 *     `drive-state.ts`/`lease.ts` invocation would take on that exact file
 *     (`lib/state/lock.ts`) — real exclusion, held for the copy-verify-delete
 *     and released immediately after, not a snapshot. A driver that starts
 *     after the global scan above cannot mutate that anchor while this
 *     script holds its lock, and if it gets there first, this script's own
 *     `acquire` contends with it exactly as any other consumer would. A
 *     held-but-STALE lock (a crashed driver) is broken by `acquire` the
 *     same way it would be for any other contender, so a dead holder's
 *     leftover `.lock` no longer blocks migration permanently; a genuinely
 *     LIVE holder simply outlasts the bounded wait
 *     (`ANCHOR_LOCK_MAX_WAIT_SEC`), and this script skips that one anchor,
 *     reports it, and blocks the run for a re-run once it clears — the same
 *     outcome the old `existsSync` check gave, now reached safely instead of
 *     by racing it.
 *   - Per-anchor locking protects each anchor's OWN copy-then-delete, not the
 *     run's whole duration — a driver that starts after the initial global
 *     scan but has not yet reached its first state write by the time this
 *     script races past every family can still write into the legacy
 *     directory after the marker publishes. `publishMigratedMarker` re-runs the
 *     SAME global scan immediately before writing the marker — narrowing
 *     that window to the gap between this second scan and the write itself,
 *     never claiming to close it entirely, the same residual the FIRST scan
 *     already accepts. Refusing there is safe, not merely convenient:
 *     without the marker, `resolveStateDir`'s own guard
 *     (`legacy-state.ts`) keeps refusing every caller toward this script
 *     rather than silently falling back to the legacy location, so a
 *     content anchor already copied by THIS run stays copied — nothing here
 *     re-copies it — and only the marker publish itself is retried.
 *   - This DOES mint one quarantine tombstone per acquired anchor in the
 *     legacy location —
 *     the exact cost a pure liveness check would want to avoid. Accepted
 *     deliberately: this script runs AT MOST once per clone (gated by the
 *     `.migrated-from-legacy` marker), so the count it can ever add is
 *     bounded by this one run's own family count, nothing like the
 *     unbounded, months-of-driver-traffic growth an earlier change measured.
 *   - A bare, no-`--apply` DRY RUN keeps the cheap `existsSync` snapshot
 *     instead of taking a real lock: it changes nothing on disk either way,
 *     so there is no copy-delete window for a lock to protect, and taking
 *     one anyway would only add a tombstone for a run that promises to leave
 *     no trace.
 *
 * Idempotent and resumable: a name already copied and removed from the
 * legacy dir simply does not appear in a re-run's classification, so an
 * interrupted run (a skipped family, or the process killed mid-way) picks up
 * exactly where it left off rather than double-copying or erroring.
 *
 * ## Dry-run by default, like `reap-state.ts`
 *
 * Bare invocation reports what WOULD be migrated, skipped and left as debris
 * — no file is copied, removed or written, and the marker is never set.
 * `--apply` is required to actually act. This is not optional caution: a
 * script whose only job is copying and deleting real per-PR round history —
 * `parked`/`held` entries can be the only record of a reviewer decision a
 * human has not yet re-made — must not be one accidental invocation away
 * from mutating it. Same posture as `reap-state.ts`'s `--delete`.
 *
 * Usage:
 *   bun <skill-dir>/scripts/migrate-legacy-state.ts            # dry run
 *   bun <skill-dir>/scripts/migrate-legacy-state.ts --apply    # act
 *
 * Exit codes: 0 = fully migrated (or nothing to migrate) — with `--apply`,
 * this clone is now marked and `resolveStateDir` will never scan the
 * legacy location again; without it, this is only a report of what a
 * following `--apply` run would do. 1 = partially blocked — an anchor's lock
 * could not be acquired (still live, or a genuine driver may be running), an
 * in-flight claim or an atomic-write staging leftover is present, or a
 * best-effort plain-file copy failed; re-run once the cause has cleared.
 * 2 = could not resolve the legacy or new location at all (not a git repo;
 * set $DRIVE_PR_STATE_DIR instead), or an unknown argument.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { stagingLive } from "./lib/claim.ts";
import { fail, runMain } from "./lib/cli.ts";
import {
  atomicWrite,
  createExclusiveDurable,
  fsyncDirectoryBestEffort,
  fsyncFileSync,
} from "./lib/state/fsutil.ts";
import {
  createStateDirDurably,
  migratedMarkerPath,
} from "./lib/state/legacy-state.ts";
import {
  createLock,
  LOCK_GENERATION_RE,
  RECOVERING_STALE_MS,
} from "./lib/state/lock.ts";
import {
  classifyEntries,
  FOREIGN_LOCKS,
  LOCK_ANCHORS,
} from "./lib/state/state-file-patterns.ts";
import {
  defaultStateDirFor,
  peekDefaultStateDirFor,
  resolveLegacyStateDir,
} from "./lib/state/store.ts";

/**
 * `LOCK_ANCHORS` minus `drive-pr-remote-lock-<n>` — see the header. Filtered
 * by source text rather than array position, so a reordering of
 * `LOCK_ANCHORS` upstream cannot silently change which anchor this excludes.
 */
const CONTENT_ANCHOR_PATTERNS = LOCK_ANCHORS.filter(
  (a) => !a.re.source.includes("remote-lock"),
);

const PLAIN_DURABLE_RE =
  /^(?:drive-pr-[0-9]+\.log|\.drive-pr-[0-9]+\.orphan-warned(?:\.abandoned\.[0-9]+)?)$/;

/**
 * `drive.ts`'s own `stagingDirFor` naming for its single-instance lock's
 * staging directory (`${lock.dir}.${pid}.${host}.staging`, created before the
 * `renameSync` that installs the real `pr-drive-<n>.lock` / `pr-drive-
 * worktree-<hash>.lock` name `FOREIGN_LOCKS` matches) — scoped to
 * `FOREIGN_LOCKS`'s own two base names rather than `migrate-state-dir.ts`'s
 * generic `.+\.lock\.([1-9][0-9]*)\.(.+)\.staging$` (that script already
 * knows each entry's own base name from its artifact classification; this
 * one does not, so the base names are spelled out here instead).
 */
const FOREIGN_LOCK_STAGING_RE =
  /^(pr-drive-[0-9]+\.lock|pr-drive-worktree-[0-9a-f]{16}\.lock)\.([1-9][0-9]*)\.(.+)\.staging$/;

/**
 * Is `name` a LIVE staging directory for one of `FOREIGN_LOCKS`'s own
 * single-instance locks — a driver still inside `takeLock`'s create-then-
 * rename window, invisible to a bare `FOREIGN_LOCKS` name match because the
 * directory this scan sees is not yet named `pr-drive-<n>.lock` at all
 * (`publishMigratedMarker` can therefore publish while that driver is still
 * mid-take, stranding its subsequent write in the now-abandoned legacy
 * directory). `stagingLive` is the SAME liveness policy `drive.ts`'s own
 * `sweepStaleStaging` and `migrate-state-dir.ts`'s `lockClaim` already apply,
 * so a genuinely abandoned (crashed) staging directory ages out rather than
 * blocking this script forever — "excluding stale quarantines" is what makes an
 * age check necessary here rather than a bare name match. A stat failure is NOT
 * uniformly read as not-live: ENOENT (the directory vanished between the
 * listing and this stat — ordinary under real contention) is safe to treat that
 * way, but any other failure (EACCES, EIO, ...) tells us nothing about whether
 * the directory is actually gone, so it is read as live/blocking instead — fail
 * closed rather than risk publishing over a staging directory this scan simply
 * could not confirm cleared.
 */
function isLiveForeignStaging(name: string, dirPath: string): boolean {
  const m = FOREIGN_LOCK_STAGING_RE.exec(name);
  if (m === null) return false;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(join(dirPath, name)).mtimeMs;
  } catch (e) {
    // ENOENT means the entry vanished between the listing and this stat —
    // ordinary under real contention, and safe to read as not live. Any
    // OTHER failure (EACCES, EIO, ...) does not tell us the entry is gone;
    // treating it as "not live" would let `publishMigratedMarker` publish
    // over a staging directory we simply could not confirm cleared — fail
    // closed and report it live/blocking instead.
    return (e as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
  return stagingLive({
    pid: Number.parseInt(m[2] as string, 10),
    host: m[3] as string,
    ageMs: Math.max(0, Date.now() - mtimeMs),
  });
}

/**
 * Is `${anchor}.lock.recovering` (`lib/state/lock.ts`'s `createLock` — a
 * second, short-lived mkdir-based gate a breaker holds while displacing a
 * dead lock generation) a live hold right now? A bare presence check would
 * treat an abandoned, crashed-mid-dance `.recovering` as blocking forever —
 * exactly the "excluding stale quarantines" case this function must not
 * regress into — so this ages it out the identical way `createLock`'s own
 * `recoveringIsLive` does for ITS first check: within `RECOVERING_STALE_MS`
 * of its own mtime is live, older is dead debris. Deliberately does not
 * attempt `recoveringIsLive`'s own deeper identity-verified break (rename to
 * a quarantine path, re-check by generation marker) — this script is a
 * read-only OBSERVER of the gate, never a contender for it, so there is
 * nothing here to break or restore; over-reporting `false` past the
 * staleness window is the same residual `createLock`'s own first check
 * accepts before falling through to that deeper verification.
 */
function isLiveRecoveringGate(anchor: string, dirPath: string): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(join(dirPath, `${anchor}.lock.recovering`)).mtimeMs;
  } catch (e) {
    // Same ENOENT-only carve-out as `isLiveForeignStaging` above: gone is
    // safe to treat as not live, an unreadable-but-present gate is not.
    return (e as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
  return Date.now() - mtimeMs <= RECOVERING_STALE_MS;
}

/**
 * Matches BOTH a live claim name and its `removeClaimFile` leftover
 * (`claims.ts`: released by renaming to `${path}.released.${pid}` before
 * deleting, so a crash between the two can leave that renamed copy behind
 * forever). `RELEASED_SUFFIX_RE` below is what tells them apart — this
 * regex alone must NOT be used to decide "in-flight", since a released
 * leftover carries no durable content and is not the ongoing dispatch this
 * check exists to defer to.
 */
const CLAIM_RE = /\.ready-claim(?:\.released\.[0-9]+)?$|\.held-claim\./;

/** A `removeClaimFile` leftover — debris, never a live in-flight claim. */
const RELEASED_SUFFIX_RE = /\.released\.[0-9]+$/;

/**
 * `fsutil.ts`'s `atomicWrite` staging-leftover suffix — `<target>.<6-hex>`,
 * created before the rename that produces the real content file
 * (`state-file-patterns.ts`'s `PLAIN_ENTRIES` already attributes these to
 * their family, which is how they reach `family.names` at all). Unlike a
 * `.log`/`.orphan-warned` file, a crash between the write and the rename can
 * leave one of these as the ONLY persisted copy of a content anchor — never
 * safe to silently leave as harmless debris the way `PLAIN_DURABLE_RE`'s
 * best-effort copies are.
 */
const STAGING_LEFTOVER_RE = /\.json\.[0-9a-f]{6}$/;

/**
 * How long ONE anchor's `createLock().acquire()` may wait before this
 * script gives up on it for this run — mirrors `reap-state.ts`'s
 * `DELETE_LOCK_MAX_WAIT_SEC` and its reasoning exactly: `0` looks like the
 * right fit for "never block a one-time migration on a live contender", but
 * breaking a genuinely STALE lock does not itself complete the acquisition —
 * it only clears the canonical path for the loop's NEXT attempt — so `0`
 * would make even an uncontended, now-cleared stale lock time out before
 * that retry ever runs. A few seconds gives that one retry cycle (the
 * rename/tombstone work is microseconds) while still refusing, well within
 * a one-time script's own definition of "fast", against a lock a live
 * driver actually holds.
 */
const ANCHOR_LOCK_MAX_WAIT_SEC = 3;

/**
 * Re-scans for a `drive.ts` foreign lock AND any reappeared content anchor,
 * and writes the migrated marker only if neither is present NOW — repeating,
 * right before publication, the exact FOREIGN_LOCKS check the top-of-run scan
 * already makes at the OTHER end of the window it cannot close on its own,
 * plus a second check the top-of-run scan never made at all.
 *
 * The top-of-run scan and each anchor's own `createLock` together still
 * leave a gap: a older driver that starts AFTER the initial scan (so
 * `foreign` there was empty) is not stopped by it, and per-anchor locking
 * only protects THAT anchor's own copy-then-delete — not the run's whole
 * duration. A driver that has taken its single-instance lock but has not
 * yet reached its first actual state write by the time this script races
 * past every family can still write into the (about to be abandoned)
 * legacy directory after the marker publishes, with nothing to notice
 *. Re-checking
 * here narrows that window to the gap between THIS scan and the marker
 * write — microseconds, not the whole run — and does not claim to close it
 * entirely: a driver starting in that final gap is still possible, the same
 * residual the header already accepts for the FIRST scan.
 *
 * The FOREIGN_LOCKS half of that residual is accepted; the CONTENT half
 * never was. `main`'s own per-family loop only examines anchors it reads
 * ONCE, at the top of the run — a caller that never takes `drive.ts`'s own
 * single-instance lock at all (a standalone `drive-state.ts`/`lease.ts`
 * write, which is `createLock`'s own per-anchor mutex, not `FOREIGN_LOCKS`)
 * can start, take an anchor's lock, write a fresh `drive-pr-<pr>.json` /
 * lease / claim, and release — anywhere from the moment this run's own scan
 * of that anchor finished to the very end of the loop, a window that spans
 * the whole run's duration for an anchor processed early, not microseconds —
 * and the marker still published over it, since nothing here ever re-checked
 * for CONTENT. Closed by
 * re-classifying this fresh `names` listing and refusing on any content
 * anchor that has real content on disk right now: `main` never reaches
 * this call with `blocked` true (it returns before `publishMigratedMarker`
 * runs at all — see its own call sites), so every content anchor this run
 * found was already copied-and-removed by the time we get here — anything
 * with content present at this final scan is therefore new or recreated
 * since, never something this run's own loop already accounted for.
 * Deliberately narrower than "any name at all": the debris this script's own
 * header documents as expected to survive (`.lock`/quarantine/staging, a
 * released claim) is not a content anchor and must not block an otherwise
 * clean publish.
 *
 * That first cut of the CONTENT check was itself still too narrow: it only
 * examined `family.anchors` filtered to `CONTENT_ANCHOR_PATTERNS` — a fresh
 * `.ready-claim`/`.held-claim.` file, an atomic-write `.json.<6-hex>`
 * staging leftover, and a live `drive-pr-remote-lock-<n>` are every one of
 * them signs an old process is actively preparing a non-idempotent write,
 * and every one of them was invisible to that check: the first two are
 * `PLAIN_ENTRIES`, landing in `family.names` rather than `family.anchors`,
 * and the third is deliberately excluded from `CONTENT_ANCHOR_PATTERNS`
 * (it has no bare content to compare — see the comment on
 * `remoteLockAnchors` above). Publishing over any of them risks the exact
 * duplicate-dispatch/abandoned-state failure this whole function exists to
 * prevent. Closed the same way:
 * a live claim or staging leftover in `family.names` (excluding a released
 * claim's harmless leftover, `RELEASED_SUFFIX_RE`) blocks, and a remote-lock
 * anchor's `.lock` existing right now blocks — the identical liveness check
 * `main`'s own dry-run path already uses for the same anchor kind.
 *
 * Fails closed (refuses to publish) if the directory cannot even be listed
 * at this point — a read failure is not evidence the location is clear.
 *
 * None of the scans above ever look at `marker` itself — they are scoped to
 * `legacyDir`, and `marker` lives under `newDir`, a different directory
 * entirely. So a symlink planted at `marker`'s own path between `main`'s
 * initial `lstatSync(marker)` check (which can run well before a long
 * migration finishes) and this function's own publish write is invisible to
 * every check above; only the publish write itself can catch it. That write
 * goes through `createExclusiveDurable`, whose publish step is `link(2)`
 * from an already-durable temp file: `link` fails with `EEXIST` if `marker`
 * names anything at all right now — symlink included — without ever
 * following or overwriting it, so a planted symlink is neither followed
 * (no write-through to its external target) nor silently clobbered (the
 * call fails instead of guessing). See `reason: 'marker-reappeared'` below.
 *
 * One more gap survived all of the above: none of it ever revisits a
 * `PLAIN_DURABLE_RE` sibling (a `.log`/`.orphan-warned` file) once the
 * per-family loop in `main` has copied it. Those files are deliberately
 * excluded from the `reappeared` scan above — they are EXPECTED to remain in
 * `legacyDir` (see the module header) — but their unlocked writers
 * (`drive.ts`'s log append, `orphans.ts`'s `.orphan-warned` write) can still
 * append to `src` any time before this function actually publishes the
 * marker, since `resolveStateDir` keeps resolving here until it does. A
 * copy taken mid-loop, long before every other family finishes, would then
 * be stale relative to that append, and nothing would ever notice — the
 * marker publishes, `resolveStateDir` stops looking at `legacyDir`
 * forever, and the write is stranded in what the header calls "harmless
 * debris" even though it is not. So
 * this function re-copies every `PLAIN_DURABLE_RE` name in the SAME final
 * scan that already confirmed nothing else reappeared, immediately before
 * the publish write below — narrowing the gap to the same
 * scan-to-write window every other check here already accepts, never
 * claiming to close it. `copyPlainSiblingBestEffort` never deletes `src`
 * and unconditionally overwrites `dst`, so re-running it here is safe and
 * idempotent even when nothing changed since the family loop's own copy.
 *
 * Two more shapes of "live, but invisible to a bare name match" survived
 * every fix above: `drive.ts`'s single-instance lock is a DIRECTORY
 * installed by `takeLock`'s create-then-rename dance, so a driver still
 * mid-take has only a `pr-drive-<n>.lock.<pid>.<host>.staging` sibling on
 * disk — `FOREIGN_LOCKS` never matches that name, only the installed one the
 * rename produces. And `createLock`'s own per-anchor `.lock` can be
 * momentarily absent during ITS stale-break/release dance while `.lock.
 * recovering` is the only thing actually marking the anchor live — the
 * `${anchor}.lock` checks above never looked at it. Both scans below now
 * also recognise these two forms (`isLiveForeignStaging`,
 * `isLiveRecoveringGate`), each aged out by the SAME staleness policy their
 * own owning protocol already uses (`stagingLive`, `RECOVERING_STALE_MS`) so
 * a genuinely abandoned one does not block this function forever.
 */
export type PublishMigratedMarkerResult =
  | { ok: true }
  | {
      ok: false;
      /**
       * `scan-failed`: could not even re-list `legacyDir` — `names` carries
       * one synthetic diagnostic entry, not a real filename.
       * `foreign-lock`: a `drive.ts` single-instance lock is present.
       * `reappeared-content`: a content anchor has real content on disk that
       * this run's own loop did not put there — see this function's own doc.
       * `marker-reappeared`: something already occupies `marker`'s own path
       * at publish time — this run never put it there (it only reached this
       * point because `main()` found no marker moments before) — `names`
       * carries `marker` itself.
       */
      reason:
        | "scan-failed"
        | "foreign-lock"
        | "reappeared-content"
        | "marker-reappeared";
      names: string[];
    };

/**
 * The headline both `publishMigratedMarker()` call sites print above
 * `published.names` — a mapping from every `PublishMigratedMarkerResult`
 * reason to its own headline, not the two-way ternary an earlier version
 * used (which mapped everything except `reappeared-content` to the
 * foreign-lock wording, so a `scan-failed` result — a `readdirSync` failure,
 * `names` carrying a synthetic diagnostic string rather than a real lock
 * name — was reported as "a drive.ts single-instance lock appeared"
 *). One copy, not two independently
 * maintained ternaries that could disagree with each other.
 */
export function publishFailureHeadline(
  reason:
    | "scan-failed"
    | "foreign-lock"
    | "reappeared-content"
    | "marker-reappeared",
): string {
  switch (reason) {
    case "scan-failed":
      return "migrate-legacy-state.ts: refusing to publish the migrated marker — the legacy location could not be re-scanned:";
    case "reappeared-content":
      return "migrate-legacy-state.ts: refusing to publish the migrated marker — content reappeared in the legacy location during this run:";
    case "foreign-lock":
      return "migrate-legacy-state.ts: refusing to publish the migrated marker — a drive.ts single-instance lock appeared during this run:";
    case "marker-reappeared":
      return "migrate-legacy-state.ts: refusing to publish the migrated marker — something already occupies the marker path:";
  }
}

/**
 * Best-effort re-fsync of an ALREADY-VISIBLE marker file and its directory —
 * for `main()`'s "already migrated, nothing to do" fast path, where the
 * marker's mere existence is not proof its original publish ever confirmed
 * durable. `publishMigratedMarker`'s own `writeFileSync` could have
 * succeeded while one of its two following fsync calls threw and aborted
 * that earlier run, leaving a visible-but-unconfirmed marker behind — a
 * bare "nothing to do" here would never retry those fsyncs, so a
 * subsequent crash could still lose the marker after this tool already
 * reported success once.
 * Cannot un-corrupt a marker that somehow lost its content — only its
 * durability.
 */
export function reconfirmMarkerDurably(marker: string): void {
  fsyncFileSync(marker);
  fsyncDirectoryBestEffort(dirname(marker));
}

export function publishMigratedMarker(
  legacyDir: string,
  marker: string,
): PublishMigratedMarkerResult {
  let names: string[];
  try {
    names = readdirSync(legacyDir);
  } catch (e) {
    return {
      ok: false,
      reason: "scan-failed",
      names: [
        `<could not re-scan ${legacyDir}: ${e instanceof Error ? e.message : String(e)}>`,
      ],
    };
  }
  const foreign = names.filter(
    (n) =>
      FOREIGN_LOCKS.some((re) => re.test(n)) ||
      isLiveForeignStaging(n, legacyDir),
  );
  if (foreign.length > 0) {
    return { ok: false, reason: "foreign-lock", names: foreign };
  }

  const { families } = classifyEntries(names, LOCK_GENERATION_RE);
  // `names` (the readdirSync listing right above) is checked against
  // directly — a `Set` for O(1) lookup — rather than re-probing the
  // filesystem with `existsSync`: `existsSync` FOLLOWS symlinks and reports
  // false for a dangling one even though its entry is real and was already
  // captured in `names`, silently collapsing "unstatable" into "absent" and
  // letting the marker publish over a legacy anchor whose target could
  // reappear later. Re-probing
  // at all would also reopen a second, later instant for a TOCTOU window
  // this function's whole purpose is to narrow, not widen.
  const nameSet = new Set(names);
  const reappeared: string[] = [];
  for (const family of families.values()) {
    for (const anchor of family.anchors) {
      if (CONTENT_ANCHOR_PATTERNS.some((p) => p.re.test(anchor))) {
        if (nameSet.has(anchor)) reappeared.push(anchor);
        // A legacy standalone writer (never took `drive.ts`'s own
        // single-instance lock, so invisible to FOREIGN_LOCKS) can create
        // this anchor's own write mutex — `createLock`'s per-anchor lock,
        // taken before the content file itself is written — after this
        // anchor was already copied-and-removed but before this final
        // scan. The bare-content check above misses it: content genuinely
        // does not exist yet, only the in-flight writer's lock does. Check
        // the same way the remote-lock anchor below already does.
        // `.lock.recovering` is checked alongside it, not instead of it:
        // `createLock`'s stale-break/release dance can hold `.recovering` in a
        // window where `.lock` itself is momentarily absent, invisible to a
        // bare `.lock` check. Reported by whichever of the two is the one
        // actually found, not always the bare `.lock` name, so the operator
        // sees the artifact that was really there.
        if (nameSet.has(`${anchor}.lock`)) {
          reappeared.push(`${anchor}.lock`);
        } else if (isLiveRecoveringGate(anchor, legacyDir)) {
          reappeared.push(`${anchor}.lock.recovering`);
        }
        continue;
      }
      // The remaining anchors are the `drive-pr-remote-lock-<n>` mutex —
      // no bare content to compare, so its liveness is whether a lock is
      // held on it right now, the same check main()'s own dry-run path
      // uses for this anchor kind — plus the same `.recovering` liveness
      // check as the content-anchor branch above, for the same reason.
      if (nameSet.has(`${anchor}.lock`)) {
        reappeared.push(`${anchor}.lock`);
      } else if (isLiveRecoveringGate(anchor, legacyDir)) {
        reappeared.push(`${anchor}.lock.recovering`);
      }
    }
    for (const name of family.names) {
      if (CLAIM_RE.test(name) && !RELEASED_SUFFIX_RE.test(name)) {
        reappeared.push(name);
      } else if (STAGING_LEFTOVER_RE.test(name)) {
        reappeared.push(name);
      }
    }
  }
  if (reappeared.length > 0) {
    return { ok: false, reason: "reappeared-content", names: reappeared };
  }

  // Refresh every plain durable sibling one last time, from this exact
  // scan, before publishing — see this function's own doc for why: a
  // family's own copy earlier in `main()`'s loop can be stale relative to an
  // unlocked writer's append that landed after it but before this publish.
  // Never deletes `src`, always overwrites `dst`, so this is safe to redo
  // even for a name the loop already migrated cleanly. A verification
  // failure here propagates uncaught, same posture as every other
  // unguarded copy/fsync call in this file: publishing over a refresh that
  // could not confirm its own bytes would defeat the point of doing it.
  const newDir = dirname(marker);
  for (const name of names) {
    if (PLAIN_DURABLE_RE.test(name)) {
      copyPlainSiblingBestEffort(legacyDir, newDir, name);
    }
  }

  // A bare `writeFileSync(marker, '')` follows a symlink and would write
  // through to whatever it names — see this function's own doc for why
  // nothing above ever scanned `marker`'s own path for one. `createExclusiveDurable`
  // closes both the durability gap the original comment here described (a
  // crash right after a bare `writeFileSync` can lose the marker file, or
  // just its directory entry, while the migration it was meant to certify
  // survives intact — `legacyFootprint()` then finds the deliberately-
  // retained lock/quarantine debris nonempty and `resolveStateDir()` refuses
  // an otherwise complete migration until an operator re-runs this script)
  // and the symlink-follow gap: it stages the empty content in a temp file,
  // fsyncs it, then publishes with `link(2)`, which fails with `EEXIST` —
  // never following, never overwriting — if `marker` already names anything
  // at all, symlink included.
  try {
    createExclusiveDurable(marker, "");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
      // `createExclusiveDurable`'s own contract: an `EEXIST` from the
      // publishing `link` is the one outcome where this call never touched
      // `marker` at all, so nothing needs undoing — report it exactly like
      // every other "state changed underneath this run" reason above.
      return { ok: false, reason: "marker-reappeared", names: [marker] };
    }
    // Any other failure (a temp-file write/fsync/close error, or a
    // publishing `link` failure that isn't `EEXIST`, or the post-publish
    // directory fsync) is a genuine, unexpected I/O failure this function
    // has no typed reason for — same posture as every other unguarded
    // `fsyncFileSync`/`copyFileSync` call elsewhere in this file: propagate
    // rather than inventing a result shape for it.
    throw e;
  }
  return { ok: true };
}

/**
 * Copies `name`, fsyncs the copy durable, verifies it byte-identical, then
 * removes the original. Throws on verification failure — never deletes an
 * original whose copy was not confirmed.
 *
 * Content-anchor use ONLY — every caller holds `createLock`'s real per-anchor
 * mutex for the duration of this call (see the header's "Exclusion" section),
 * the same one any live or future `drive-state.ts`/`lease.ts` write to that
 * exact anchor would take, so a cooperating writer cannot be mid-write while
 * this function reads-then-deletes. `.log`/`.orphan-warned` siblings used to
 * share this function too, back when the only defense available for their
 * unlocked writers was narrowing the read-then-delete window one more
 * re-read at a time; that narrowing proved structurally unable to close
 * (see the header's "Why the plain siblings are copied, never deleted"), so
 * they now go through `copyPlainSiblingBestEffort` instead, which never
 * deletes `src` at all.
 *
 * `copyFileSync` only guarantees the copy landed in the page cache; without
 * an explicit fsync of the destination file AND its directory entry, a
 * crash right after this returns can lose the copy while the original is
 * already gone.
 *
 * The verification read is placed LAST, immediately before `rmSync(src)`,
 * rather than right after the copy, purely to keep the already-narrow window
 * a lock cannot cover — a bug in a caller that forgets to take this anchor's
 * lock, not the ordinary case — as small as the two back-to-back reads
 * immediately below, rather than widening it by the fsync calls' own
 * duration.
 *
 * `dst` is checked for existing content FIRST, never blindly overwritten:
 * a retry after `publishMigratedMarker` refused on `reappeared-content` (an
 * old process recreated `src` after this same anchor already migrated
 * cleanly) re-enters `main()`, which re-walks `legacyDir` and calls this
 * function again for the SAME name — and `copyFileSync` overwrites `dst`
 * unconditionally, so a first cut of this retry path replaced the already-
 * migrated, correct destination with whatever the resurrected legacy file
 * happened to contain, silently losing the round history and parked
 * decisions the first migration preserved. An identical `dst` is the resumable
 * case — this anchor's copy already completed, so just clear the reappeared
 * legacy leftover. A DIFFERENT `dst` means two independent copies of this
 * anchor now disagree and neither is safe to discard automatically; refuse for
 * manual reconciliation instead of guessing which one is current.
 */

/**
 * Is `path` an entry on disk — a dangling symlink included — never whether
 * its TARGET resolves.
 *
 * `existsSync` follows a symlink and reports `false` for a dangling one even
 * though its directory entry is real, which is exactly what
 * `publishMigratedMarker` above already works around by checking `readdirSync`
 * output directly rather than re-probing with `existsSync`. The content-anchor
 * migration gates below used to keep the `existsSync` check instead: a
 * dangling `drive-pr-<n>.json` symlink then read as absent everywhere in this
 * loop, so dry run silently reported "would migrate 0 file(s)" and apply left
 * it untouched in `legacyDir` — where `publishMigratedMarker`'s correct
 * `readdirSync` check then saw it, reported `reappeared-content`, and exited 1
 * on every subsequent run with a message describing content that had, in
 * fact, never moved. `lstatSync` stats the
 * link itself, never the target, so it agrees with `publishMigratedMarker`'s
 * `readdirSync`-based check instead of disagreeing with it. A non-`ENOENT`
 * error is not absence and is not swallowed — the same discipline the marker
 * `lstatSync` above already applies.
 */
function entryPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw e;
  }
}

/**
 * Requires `path` to be a real, regular file — `lstatSync`, never a
 * symlink-following `existsSync`/`readFileSync`/`copyFileSync`/
 * `fsyncFileSync` call, which is all this function's other I/O uses and all
 * of which transparently follow a symlink. Without this, a `src` symlink
 * copies whatever external content its target names and is then removed as
 * if it were a migrated artifact; a pre-existing, LIVE `dst` symlink whose
 * target happens to byte-match `src` takes the resumable branch and
 * publishes the migration marker while the canonical destination still
 * points outside `newDir`; and a DANGLING `dst` symlink instead falls
 * through to the fresh-copy branch, where `copyFileSync` follows it and
 * creates the target file wherever it points, outside `newDir` entirely.
 * The sibling general migration
 * (`captureArtifactIdentities`/`assertArtifactIdentity` in
 * `migrate-state-dir.ts`) enforces the identical real-file invariant for the
 * same reason.
 */
function assertRealFile(path: string, label: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    fail(
      1,
      `migrate-legacy-state.ts: ${label} is not a real file, refusing to treat it as migratable content: ${path}`,
      "",
      "Reconcile it by hand (a symlink or non-regular entry where the legacy",
      "state directory should hold only plain files), then re-run.",
    );
  }
}

export function copyAndRemove(
  legacyDir: string,
  newDir: string,
  name: string,
): void {
  const src = join(legacyDir, name);
  const dst = join(newDir, name);
  assertRealFile(src, `legacy ${name}`);
  // `entryPresent`, never `existsSync`, decides which branch `dst` takes:
  // `existsSync` reports `false` for a DANGLING symlink even though its
  // directory entry is real, which used to fall this case straight through
  // to the fresh-copy branch below — where `copyFileSync` follows the link
  // and creates the target file wherever it points, outside `newDir`
  // entirely. `entryPresent` sees the
  // entry regardless of where (or whether) its target resolves, and
  // `assertRealFile` immediately below then refuses it the same way it
  // refuses a live symlink.
  if (entryPresent(dst)) {
    assertRealFile(dst, `migrated ${name}`);
    const existing = readFileSync(dst);
    const incoming = readFileSync(src);
    if (!existing.equals(incoming)) {
      fail(
        1,
        `migrate-legacy-state.ts: ${name} already exists at the migrated destination and differs from the legacy copy — refusing to overwrite.`,
        `  destination: ${dst}`,
        `  legacy:      ${src}`,
        "",
        "This means an already-migrated file and a later, different legacy file",
        "both exist for the same name (most likely an old process recreated the",
        "legacy file after this anchor already migrated cleanly). Reconcile by",
        "hand — decide which content is current, remove the other — then re-run.",
      );
    }
    // The byte match alone does not prove `dst` is DURABLE: if an earlier
    // run crashed after `copyFileSync` but before this function's own
    // `fsyncFileSync`/directory-fsync, the cached bytes this retry just
    // compared can still be sitting only in the page cache. Deleting `src`
    // here without fsyncing first would leave that scenario one crash away
    // from losing the state entirely — the same durability gap the
    // fresh-copy path below already closes, applied to the resumed path too.
    fsyncFileSync(dst);
    fsyncDirectoryBestEffort(newDir);
    // Re-read `src` immediately before deleting it, rather than trusting the
    // comparison from before the two fsync calls above: those calls are real
    // disk I/O and take measurable time, and this call's own anchor lock
    // only binds a COOPERATING writer — a bug that writes to this anchor
    // without taking it (or a legacy older process this repo does
    // not know about) is exactly the residual this re-read defends, not the
    // ordinary case. This narrows that residual window to the gap between
    // this read and `rmSync` itself — it does not close it entirely, the
    // same limit every other narrowing in this function
    // (`publishMigratedMarker`'s re-scan, the destination-durability fsync
    // above) already accepts rather than claims to close — which is exactly
    // why the `.log`/`.orphan-warned` siblings, which have no cooperating
    // lock to bind in the first place, no longer go through this path at
    // all (see the header). The real-file check is repeated here for the
    // same reason: byte content matching does not rule out `src` having been
    // swapped for a symlink to attacker-controlled content with identical
    // bytes since the check at this function's entry.
    assertRealFile(src, `legacy ${name}`);
    if (!readFileSync(src).equals(incoming)) {
      fail(
        1,
        `migrate-legacy-state.ts: ${name} changed in the legacy location after this run already verified and durably copied it — refusing to delete a source that may carry unmigrated bytes.`,
        `  legacy: ${src}`,
        "",
        "A writer that does not hold this anchor lock — a bug, or a legacy",
        "process outside this migration — most likely wrote to this file",
        "between the copy and the delete. The destination already has the",
        "content this run verified; reconcile the legacy file by hand — decide",
        "whether the new bytes matter — then re-run.",
      );
    }
    rmSync(src, { force: true });
    // The deletion itself is not durable until `legacyDir`'s own directory
    // entry is fsynced — without this, a crash right after `rmSync` can
    // leave the unlink uncommitted while `dst` and (once every anchor
    // finishes) the migrated marker survive, resurrecting `src` on the next
    // boot. A subsequently run older process can then resume against
    // that resurrected legacy copy and diverge from the relocated one this
    // migration already published as canonical.
    fsyncDirectoryBestEffort(legacyDir);
    return;
  }
  // `atomicWrite`, not `copyFileSync(src, dst)`: at this point `dst` was
  // confirmed ABSENT by `entryPresent(dst)` above, but that check and this
  // write are two different moments — a symlink planted at `dst` in between
  // would make `copyFileSync` follow it and write through to whatever it
  // names, outside `newDir` entirely, the same class of gap `entryPresent`/
  // `assertRealFile` close for the RESUMABLE branch's pre-existing `dst`
  // but cannot close here by adding one more check (this file's own header
  // already records why narrowing a check-then-act window only relocates
  // it). `atomicWrite` sidesteps the window instead: it stages the bytes in
  // a temp file, fsyncs them, then publishes with `renameSync`, which
  // REPLACES whatever directory entry currently occupies `dst` — a symlink
  // included — without ever opening or following it.
  const staged = readFileSync(src);
  atomicWrite(dst, staged);
  const a = readFileSync(src);
  const b = readFileSync(dst);
  if (!a.equals(b)) {
    fail(
      1,
      `migrate-legacy-state.ts: copy of ${name} did not verify byte-identical — aborting without deleting the original.`,
    );
  }
  // Same reasoning as the resumable branch above: re-read `src` immediately
  // before deleting it rather than trusting `a`, which is now one function
  // call (and, for the resumable branch's callers retrying this same name,
  // potentially a fsync's worth of time) removed from the actual delete
  // — the residual it narrows is a
  // writer that does not hold this anchor's lock, not the ordinary
  // cooperating case. Same real-file re-check as the resumable branch
  // above, for the same substitution-race reason.
  assertRealFile(src, `legacy ${name}`);
  if (!readFileSync(src).equals(b)) {
    fail(
      1,
      `migrate-legacy-state.ts: ${name} changed in the legacy location after this run already verified and durably copied it — refusing to delete a source that may carry unmigrated bytes.`,
      `  legacy: ${src}`,
      "",
      "A writer that does not hold this anchor lock — a bug, or a legacy",
      "process outside this migration — most likely wrote to this file",
      "between the copy and the delete. The destination already has the",
      "content this run verified; reconcile the legacy file by hand — decide",
      "whether the new bytes matter — then re-run.",
    );
  }
  rmSync(src, { force: true });
  // Same reasoning as the resumable branch above: fsync legacyDir so this
  // deletion cannot be lost to a crash after the destination and marker
  // already survived it.
  fsyncDirectoryBestEffort(legacyDir);
}

/**
 * Best-effort durable copy of a `.log`/`.orphan-warned` PLAIN sibling —
 * unlike `copyAndRemove`, this NEVER deletes `src`. See the header's "Why
 * the plain siblings are copied, never deleted": no producer of these files
 * takes any lock before writing, so no re-read immediately before a delete
 * can ever close the gap between that read and the delete itself — three
 * successive narrowings still left one, and measurement established that
 * the gap cannot be closed by reading more, only moved later. Retaining
 * `src` sidesteps the race instead of continuing to chase it: once every
 * family finishes and the marker publishes, nothing ever writes to `legacyDir`
 * again, so the retained copy becomes the same harmless, self-limiting debris
 * the header already accepts for lock/quarantine files.
 *
 * `dst` is overwritten unconditionally on every call, unlike
 * `copyAndRemove`'s resumable branch: these files only ever grow by append,
 * so a later run's snapshot of `src` is always at least as fresh as an
 * earlier one's, and there is no "only surviving copy" concern to protect
 * against — `src` is never removed, so an earlier run's copy is never the
 * sole durable record the way a content anchor's would be. The
 * unconditional overwrite goes through `atomicWrite`, never a direct
 * `copyFileSync(src, dst)`: this function takes no lock on `dst` at all, so
 * nothing here (unlike `copyAndRemove`'s branches) has ever checked what
 * currently occupies `dst`'s path — a symlink planted there is followed by
 * `copyFileSync` and written through to its external target, `newDir`
 * entirely bypassed. `atomicWrite` stages the bytes in a temp file, fsyncs
 * them, and publishes with `renameSync`, which replaces whatever directory
 * entry is at `dst` — symlink included — without ever opening or following
 * it.
 *
 * Still throws on a verification mismatch (never silently accepts a torn
 * copy) — not because `src` would be lost, but because a migration that
 * reports success while `newDir` holds an unverified copy is still wrong.
 */
export function copyPlainSiblingBestEffort(
  legacyDir: string,
  newDir: string,
  name: string,
): void {
  const src = join(legacyDir, name);
  const dst = join(newDir, name);
  assertRealFile(src, `legacy ${name}`);
  atomicWrite(dst, readFileSync(src));
  const a = readFileSync(src);
  const b = readFileSync(dst);
  if (!a.equals(b)) {
    fail(
      1,
      `migrate-legacy-state.ts: copy of ${name} did not verify byte-identical — legacy original left in place.`,
    );
  }
}

function parseArgs(argv: readonly string[]): { apply: boolean } {
  let apply = false;
  for (const a of argv) {
    if (a === "--apply") apply = true;
    else fail(2, `migrate-legacy-state.ts: unknown argument '${a}'.`);
  }
  return { apply };
}

async function main(): Promise<number> {
  const { apply } = parseArgs(process.argv.slice(2));
  const verb = apply
    ? "migrating"
    : "would migrate (dry run — pass --apply to act)";

  const legacyDir = await resolveLegacyStateDir();

  let newDir: string;
  if (apply) {
    newDir = defaultStateDirFor(legacyDir);
    // `createStateDirDurably`, not a bare `mkdirSync`: this run's own
    // `copyAndRemove` explicitly fsyncs each legacy source deletion, so a
    // directory-entry-only `mkdirSync` here could leave every copied file
    // durably inside `newDir` while `newDir`'s own entry in its parent
    // never committed, and the legacy originals already gone. Same helper
    // `ensureMigratedFromLegacy` uses, for the identical reason — see its own
    // doc comment.
    createStateDirDurably(newDir);
  } else {
    // A bare dry run must not mint a clone identity merely to preview the
    // destination `--apply` would resolve to: `defaultStateDirFor` calls
    // `cloneKey`, which durably persists a fresh `drive-pr-clone-id` inside
    // the git common directory the very first time it is called on a clone
    // that doesn't have one yet — contradicting this script's own "a dry
    // run writes nothing" promise.
    // `peekDefaultStateDirFor` never mints; when nothing is persisted yet,
    // there is also nothing that could already be marked migrated under it,
    // so the marker check below naturally reads as "not migrated" against
    // this placeholder rather than needing a special case here.
    newDir =
      peekDefaultStateDirFor(legacyDir) ??
      "<a fresh clone identity, to be minted on --apply>";
  }

  const marker = migratedMarkerPath(newDir);
  // `lstatSync`, never `existsSync`: this is the only production writer of
  // `marker` (`publishMigratedMarker`'s `createExclusiveDurable(marker, '')`
  // — an empty regular file, published via `link(2)`, never followed or
  // overwritten through a pre-existing symlink), so anything else at this
  // path is corruption, not a marker. `existsSync` alone can't tell a
  // directory or a symlink apart from a real marker, and both
  // `fsyncFileSync` (opens read-only, which POSIX permits on a directory)
  // and a plain `writeFileSync` retry would silently misbehave against
  // either — reporting "already migrated" over a directory, or
  // fsyncing/writing through a symlink's TARGET rather than validating the
  // marker itself. `lstatSync` never
  // follows a symlink, so its own type is reported, not the target's. This
  // check and the eventual publish are still two separate moments in time
  // — see `publishMigratedMarker`'s own doc for why a symlink planted at
  // `marker` in between is the publish write's problem to catch, not this
  // one's.
  let markerStat: ReturnType<typeof lstatSync> | null = null;
  try {
    markerStat = lstatSync(marker);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      fail(
        2,
        `migrate-legacy-state.ts: cannot inspect the migration marker at ${marker}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (markerStat !== null) {
    if (!markerStat.isFile()) {
      fail(
        2,
        `migrate-legacy-state.ts: ${marker} exists but is not a regular file — refusing to treat it as a migration marker.`,
        "The only thing that ever creates this path is an empty writeFileSync,",
        "never a directory or a symlink. Investigate by hand — this may mean",
        "something outside drive-pr created it, or the filesystem is corrupted —",
        "then remove it and re-run once you are confident nothing depends on it.",
      );
    }
    // The marker's mere EXISTENCE is not proof its publish was ever
    // confirmed durable — see `reconfirmMarkerDurably`'s own doc comment.
    // Never on a dry run: this file's whole "bare invocation touches
    // nothing" contract covers a durability-only fsync too, not just a
    // content write.
    if (apply) reconfirmMarkerDurably(marker);
    console.log(
      `migrate-legacy-state.ts: ${newDir} is already marked migrated — nothing to do.`,
    );
    return 0;
  }

  let names: string[];
  try {
    names = readdirSync(legacyDir);
  } catch (e) {
    fail(
      2,
      `migrate-legacy-state.ts: cannot read the legacy location ${legacyDir}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const { families, foreign } = classifyEntries(names, LOCK_GENERATION_RE);

  if (foreign.length > 0) {
    console.error(
      "migrate-legacy-state.ts: refusing — a drive.ts single-instance lock exists in the legacy location:",
    );
    for (const n of foreign) console.error(`  ${n}`);
    console.error("A driver may still be running against it. Stop it first");
    console.error(
      "(bun <skill-dir>/scripts/drives.ts --stop <PR>) or wait for",
    );
    console.error("it to finish, then re-run this migration.");
    return 1;
  }

  if (families.size === 0) {
    if (apply) {
      const published = publishMigratedMarker(legacyDir, marker);
      if (!published.ok) {
        console.error(publishFailureHeadline(published.reason));
        for (const n of published.names) console.error(`  ${n}`);
        if (published.reason === "marker-reappeared") {
          console.error(
            "Nothing else in this codebase ever creates this path (a concurrent",
          );
          console.error(
            "migration of this same clone, or something else entirely) — reconcile",
          );
          console.error("it by hand, then re-run once it is clear.");
        } else if (published.reason !== "scan-failed") {
          console.error(
            "A driver started after this migration began. Nothing was migrated or",
          );
          console.error("touched; re-run once it clears.");
        }
        return 1;
      }
      console.log(
        `migrate-legacy-state.ts: no drive-pr state found in ${legacyDir} — marked ${newDir} migrated.`,
      );
    } else {
      console.log(
        `migrate-legacy-state.ts: no drive-pr state found in ${legacyDir} — would mark ${newDir} migrated. Pass --apply to act.`,
      );
    }
    return 0;
  }

  let migratedCount = 0;
  let blocked = false;
  const debris: string[] = [];

  for (const family of families.values()) {
    const claims = family.names.filter(
      (n) => CLAIM_RE.test(n) && !RELEASED_SUFFIX_RE.test(n),
    );
    if (claims.length > 0) {
      console.error(
        `migrate-legacy-state.ts: skipping ${family.id} — in-flight claim file(s) present:`,
      );
      for (const n of claims) console.error(`  ${n}`);
      blocked = true;
      debris.push(...family.names);
      continue;
    }

    const stagingLeftovers = family.names.filter((n) =>
      STAGING_LEFTOVER_RE.test(n),
    );
    if (stagingLeftovers.length > 0) {
      console.error(
        `migrate-legacy-state.ts: skipping ${family.id} — atomic-write staging leftover(s) present (may be the only persisted copy of a content file after a crash):`,
      );
      for (const n of stagingLeftovers) console.error(`  ${n}`);
      console.error(
        "  Inspect manually before re-running: if one is the sole surviving copy, rename it to its canonical name first.",
      );
      blocked = true;
      debris.push(...family.names);
      continue;
    }

    // EVERY implied content anchor, not just the ones that currently have a
    // bare content file — `family.anchors` (`state-file-patterns.ts`) already
    // carries an anchor whose only on-disk trace is its `.lock`, because
    // `anchorOf()` strips the lock suffix to recover it. A family with ONLY
    // a `.lock` and no content yet (an old, older driver mid-way
    // through its FIRST write to a brand-new anchor) used to fall through
    // `contentNames` — filtered from `family.names` by file NAME, so a
    // not-yet-existing content file was never a candidate — entirely: no
    // lock attempt, no block, the `.lock` left as harmless-looking debris
    // while the marker was written anyway. That old driver's write then
    // lands in the now-abandoned legacy directory, which every migrated
    // command ignores from then on. Filtered to `CONTENT_ANCHOR_PATTERNS` (never
    // the bare `LOCK_ANCHORS`) because `drive-pr-remote-lock-<n>` carries no
    // content of its own to copy — but its LIVENESS still matters, and is
    // checked separately just below, never skipped.
    const contentAnchors = [...family.anchors].filter((a) =>
      CONTENT_ANCHOR_PATTERNS.some((p) => p.re.test(a)),
    );
    // `family.anchors` only ever contains anchors matched against
    // `LOCK_ANCHORS` (see `classifyEntries`), so whatever is left after
    // removing `contentAnchors` is exactly the `drive-pr-remote-lock-<n>`
    // mutex, when this family's PR has one on disk right now.
    const remoteLockAnchors = [...family.anchors].filter(
      (a) => !contentAnchors.includes(a),
    );
    const plainNames = family.names.filter((n) => PLAIN_DURABLE_RE.test(n));
    const migrated = new Set<string>();

    // A live `drive-pr-remote-lock-<n>` blocks the family even though it has
    // no content of its own to migrate: `lease.ts`'s `claimLease` acquires
    // this mutex FIRST, before the per-PR state mutex or any lease lock (see
    // its own doc in `lib/state/lease.ts`), so an old, older process
    // can be holding it while still on its way to writing a real state or
    // lease anchor into this exact directory. Excluding it from
    // `CONTENT_ANCHOR_PATTERNS` above (correctly — it has no content to
    // copy) used to also exclude it from every liveness check, so this scan
    // never saw that in-flight claim, let the marker publish, and orphaned
    // the old process's subsequent write into the now-abandoned legacy
    // location with nothing to notice.
    // Checked with the exact same `createLock` mutex any real claimant would
    // take — real exclusion, not a snapshot — and, on dry run, the same
    // `existsSync` preview every other anchor gets.
    //
    // A failure here has to block the WHOLE family, not just this loop:
    // `lease.ts`'s `claimLease` takes this remote-mutation lock BEFORE the
    // per-PR state mutex, so a claimant we failed to out-wait here is
    // actively on its way to acquiring `contentAnchors`' own lock next. The
    // `continue` below used to only advance THIS `for` loop, after which
    // execution fell straight through into the `contentAnchors` loop for
    // the very same family — so migration could win the race for the
    // content anchor's lock, copy-and-remove it, and release, all before
    // the claimant reached it; the claimant then found an absent file,
    // treated it as fresh, and wrote a new one into the now-abandoned
    // legacy directory — permanently orphaning the copy already migrated
    //. `remoteLockFailed` records the
    // failure across the whole loop (a family can carry more than one
    // remote-lock anchor's worth of names in principle) and the check right
    // after it skips straight to the next family, exactly like the
    // claim/staging-leftover blocks above.
    let remoteLockFailed = false;
    for (const anchor of remoteLockAnchors) {
      if (!apply) {
        if (existsSync(join(legacyDir, `${anchor}.lock`))) {
          console.error(
            `migrate-legacy-state.ts: skipping ${family.id} — a live or crashed remote-mutation lock is present at ${anchor}.lock; re-run once it clears.`,
          );
          blocked = true;
          remoteLockFailed = true;
        }
        continue;
      }
      const remoteLock = createLock(
        join(legacyDir, anchor),
        "migrate-legacy-state.ts",
        family.id,
      );
      try {
        await remoteLock.acquire(ANCHOR_LOCK_MAX_WAIT_SEC);
      } catch (e) {
        console.error(
          `migrate-legacy-state.ts: skipping ${family.id} — could not acquire its remote-mutation lock at ${anchor} (a live driver may be running against it): ${e instanceof Error ? e.message : String(e)}. Re-run once it clears.`,
        );
        blocked = true;
        remoteLockFailed = true;
        remoteLock.dispose();
        continue;
      }
      // Nothing to copy — holding the lock for the instant it takes to
      // confirm no live claimant is the entire point (see the comment
      // above).
      remoteLock.release();
      remoteLock.dispose();
    }
    if (remoteLockFailed) {
      debris.push(...family.names);
      continue;
    }

    for (const anchor of contentAnchors) {
      if (!apply) {
        // Dry run: an existsSync snapshot is an honest preview and changes
        // nothing on disk — see the header for why only --apply takes a
        // real lock.
        if (existsSync(join(legacyDir, `${anchor}.lock`))) {
          console.error(
            `migrate-legacy-state.ts: skipping ${anchor} (${family.id}) — a live or crashed lock is present; re-run once it clears.`,
          );
          blocked = true;
          continue;
        }
        if (entryPresent(join(legacyDir, anchor))) {
          console.log(
            `migrate-legacy-state.ts: ${verb} ${anchor} (${family.id})`,
          );
          migrated.add(anchor);
          migratedCount++;
        }
        continue;
      }

      const anchorLock = createLock(
        join(legacyDir, anchor),
        "migrate-legacy-state.ts",
        family.id,
      );
      try {
        await anchorLock.acquire(ANCHOR_LOCK_MAX_WAIT_SEC);
      } catch (e) {
        console.error(
          `migrate-legacy-state.ts: skipping ${anchor} (${family.id}) — could not acquire its lock (a live driver may be running against it): ${e instanceof Error ? e.message : String(e)}. Re-run once it clears.`,
        );
        blocked = true;
        anchorLock.dispose();
        continue;
      }
      try {
        // Holding the lock is what actually matters for an anchor with no
        // content YET: it confirms no live writer is mid-creation at this
        // instant, even though there is nothing here to copy.
        if (entryPresent(join(legacyDir, anchor))) {
          console.log(
            `migrate-legacy-state.ts: ${verb} ${anchor} (${family.id})`,
          );
          copyAndRemove(legacyDir, newDir, anchor);
          migrated.add(anchor);
          migratedCount++;
        }
      } finally {
        anchorLock.release();
        anchorLock.dispose();
      }
    }

    for (const name of plainNames) {
      // No lock protocol governs these (see the header), and — unlike the
      // content anchor above — no re-read immediately before a delete can
      // ever close the gap an unlocked writer's append can land in, so this
      // never deletes `src` at all (see `copyPlainSiblingBestEffort` and the
      // header's "Why the plain siblings are copied, never deleted"). A
      // failed copy still DOES block the family: `src` survives the
      // failure, but a migration that reports complete while `newDir` never
      // received a copy at all is still wrong.
      console.log(
        `migrate-legacy-state.ts: ${apply ? "copying (legacy copy retained)" : "would copy (legacy copy retained — dry run, pass --apply to act)"} ${name} (${family.id})`,
      );
      if (!apply) {
        migrated.add(name);
        migratedCount++;
        continue;
      }
      try {
        copyPlainSiblingBestEffort(legacyDir, newDir, name);
        migrated.add(name);
        migratedCount++;
      } catch (e) {
        console.error(
          `migrate-legacy-state.ts: could not copy ${name} (${family.id}): ${e instanceof Error ? e.message : String(e)} — left in place.`,
        );
        blocked = true;
      }
    }

    debris.push(...family.names.filter((n) => !migrated.has(n)));
  }

  if (debris.length > 0) {
    console.log(
      "migrate-legacy-state.ts: left in place (inert once nothing writes to the legacy location — see the header for why; safe to remove manually once confident):",
    );
    for (const n of debris) console.log(`  ${join(legacyDir, n)}`);
  }

  if (blocked) {
    console.error(
      apply
        ? "migrate-legacy-state.ts: migration INCOMPLETE — some entries were skipped (see above). Re-run once they have cleared; already-migrated files are not re-copied."
        : "migrate-legacy-state.ts: would be INCOMPLETE — some entries would be skipped (see above). This dry run changed nothing.",
    );
    return 1;
  }

  if (!apply) {
    console.log(
      `migrate-legacy-state.ts: dry run — would migrate ${migratedCount} file(s) to ${newDir} and mark this clone migrated. Pass --apply to act.`,
    );
    return 0;
  }

  // `newDir` already exists — created above, before the copy loop needed it
  // as a destination.
  const published = publishMigratedMarker(legacyDir, marker);
  if (!published.ok) {
    console.error(publishFailureHeadline(published.reason));
    for (const n of published.names) console.error(`  ${n}`);
    if (published.reason === "marker-reappeared") {
      console.error(
        "Nothing else in this codebase ever creates this path (a concurrent",
      );
      console.error(
        "migration of this same clone, or something else entirely) —",
      );
      console.error("reconcile it by hand before re-running. The");
    } else if (published.reason !== "scan-failed") {
      console.error(
        `A driver or standalone command started after this migration began. The`,
      );
    }
    console.error(
      `${migratedCount} file(s) already copied stay migrated — each landed under its own`,
    );
    console.error(
      "anchor lock and this clone is simply not yet marked; re-run once the writer",
    );
    console.error("clears and the rest will pick up where this run left off.");
    return 1;
  }
  console.log(
    `migrate-legacy-state.ts: migrated ${migratedCount} file(s) to ${newDir}. This clone is now marked migrated.`,
  );
  return 0;
}

// Unguarded, merely IMPORTING this module for its exported helpers would run
// the whole migration against the importing process's own repository.
if (import.meta.main) runMain("migrate-legacy-state.ts", main);
