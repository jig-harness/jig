/** Resolve mutation-fence context and verify the state directory before trusting its contents. */
import { resolve, join, dirname, isAbsolute, basename } from "node:path";

import { lstatSync, readdirSync, existsSync, mkdirSync } from "node:fs";

import { type Session, resolveSession } from "./lease-model.ts";

import {
  type DirIdentity,
  assertStateDirIdentityUnchanged,
  statDirIdentity,
  sameDirIdentity2,
  parseDirIdentityToken,
  sameDirIdentity,
} from "./lease-files.ts";

import {
  readVolumeIdentity,
  type VolumeIdentityReader,
} from "./volume-identity.ts";
import { fail } from "../cli.ts";

import { resolveActor } from "./actor.ts";

import { git, gitCallTimeoutSeconds } from "../proc.ts";

import { peekDefaultStateDirFor, resolveLegacyStateDir } from "./store.ts";
import { scopedOverrideDir } from "./override-dir.ts";

import { migratedMarkerPath, legacyFootprint } from "./legacy-state.ts";

/**
 * Is a git repository in play here at all — answered WITHOUT asking git,
 * because git cannot answer it unambiguously.
 *
 * The obvious discriminator, and the one this first used, is `git rev-parse`'s
 * exit status: 128 for "not a git repository", 127 when the binary never ran.
 * It is not sound. 128 is git's GENERIC fatal status — dubious ownership, a
 * permissions failure, a corrupt object store all produce it — so reading 128
 * as "no repository, therefore no lease" authorises the POST on a tree that may
 * hold a live one.
 *
 * The first version of this argued the exposure was bounded by construction: a
 * driver in an unreadable tree could not have written a lease either, because
 * `claimLease` reaches `resolveActor`, whose own `git rev-parse` would fail the
 * same way. That reasoning is WRONG, and its refutation is worth keeping
 * because it is easy to re-derive: it holds only if the failure predates the
 * lease. A drive writes a live lease, the repository then becomes unreadable —
 * an ownership change, a permissions change, a half-finished operation — and
 * the lease is still sitting there, still live, while this probe now says 128.
 *
 * So the allow case is established POSITIVELY instead, from the filesystem:
 * there is no repository here if no `.git` exists anywhere from the working
 * directory up to the root, and no `GIT_*` variable asserts one. `.git` is
 * probed with `lstat` rather than as a directory because a linked worktree's is
 * a FILE (a gitdir pointer) — the normal case in this repository, which is
 * driven from Conductor worktrees.
 *
 * `lstat` rather than `existsSync`, because `existsSync` answers a DIFFERENT
 * question than the one this fence has to ask. It reports `false` for confirmed
 * absence and for every indeterminate failure alike, and the indeterminate ones
 * below are each reachable here AFTER a live lease has been written (measured:
 * `existsSync` reports `false` for every one of them):
 *
 *   - a `.git` that is a BROKEN SYMLINK — `existsSync` follows the link and
 *     reports false, though the marker entry plainly exists (`lstat` succeeds);
 *   - a `.git` under an ancestor that became UNSEARCHABLE — `EACCES` is
 *     indistinguishable from `ENOENT` through `existsSync`, so the walk runs to
 *     the root and concludes no repository exists.
 *
 * Either one turns `resolveFenceContext` into `null` — post permitted, lease
 * never read — which is the same fail-open as the exit-128 check this replaced,
 * one step further in. So only ENOENT/ENOTDIR — a POSITIVE answer that this
 * directory holds no marker — continues the walk; any other error means the
 * filesystem could not answer, and an unanswered question fails CLOSED.
 *
 * An asserted-but-broken environment (`GIT_DIR` naming something unusable)
 * returns `true` here, so the caller demands a working git and refuses when it
 * does not get one. That is the right direction: a caller who named a git
 * directory has claimed a repository exists, and a fence in front of an
 * irreversible mutation must not overrule that claim by looking away.
 */
function repositoryIsInPlay(): boolean {
  for (const v of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) {
    if ((process.env[v] ?? "") !== "") return true;
  }
  let dir = resolve(process.cwd());
  for (;;) {
    try {
      lstatSync(join(dir, ".git"));
      return true;
    } catch (e) {
      // ENOENT: nothing of that name. ENOTDIR: a path component is not a
      // directory, so no marker can be here either. Both are POSITIVE absence
      // at this level — keep walking up. Anything else (EACCES, ELOOP, EIO,
      // ENAMETOOLONG, …) is the filesystem declining to answer, and a fence in
      // front of an irreversible POST treats "unknown" as "in play".
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return true;
    }
    const parent = dirname(dir);
    // `dirname('/') === '/'` — the root is its own parent, and the only
    // termination condition that does not assume a path depth.
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Everything the external-mutation fence needs to decide, or `null` when no
 * drive lease can exist here AT ALL — in which case there is nothing to fence
 * and the caller proceeds unchanged.
 *
 * `null` means exactly one thing: NOT A GIT REPOSITORY. Drive state lives in
 * the git dir, so outside a worktree there is no state directory a lease could
 * sit in, and `git` exiting non-zero here is a definite answer rather than a
 * failed read.
 *
 * A `git` that TIMES OUT is not that answer, and it is the one input this
 * cannot read: it throws (exit 1) rather than returning `null`, because a
 * fence that silently allows on a blind read has verified nothing while
 * reporting that it has.
 * The mutation this guards is unwithdrawable, so the cost of failing closed is
 * a re-run and the cost of failing open is a duplicate outcome reply on a live
 * thread.
 *
 * NOTE the session ladder's tier 3 is NOT a `null` here — this fence still
 * runs for it. `claimLease` now DOES let tier 3 take a durable exclusion
 *: a `holder: 'worktree'` presence lease, keyed by actor rather
 * than pid, so two sessionless resolvers on the same PR still refuse each
 * other. `isMine` recognizes that record as this tree's own (comparing
 * `actor`, since a tier-3 record carries no usable pid), so this fence still
 * passes a tier-3 caller's OWN lease and refuses only a genuinely FOREIGN
 * one. Skipping the check entirely here would have exempted exactly the
 * harnesses that cannot be told apart from a second session in the same
 * tree.
 *
 * A driver exports a resolved clone leaf and a directory baseline; that pair
 * lets its pass fence even after the checkout loses its Git metadata. A raw
 * override root first resolves this clone, matching `resolveStateDir`. Every
 * override asserts a directory exists, and this fence verifies it — the fence
 * has no later write to fail loudly against if it was wrong, so an unverified
 * override is a silent fail-open the moment the asserted directory is gone.
 * `resolveActor` still has to answer, and still refuses outside a worktree —
 * a fence that cannot say WHICH tree it is in cannot read the right lease.
 */
export async function resolveFenceContext(
  label: string,
  readVolume: VolumeIdentityReader = readVolumeIdentity,
): Promise<
  | {
      stateDir: string;
      actor: string;
      session: Session;
      fromOverride: true;
      overrideEntries: string[];
      stateDirIdentity: DirIdentity;
    }
  | {
      stateDir: string;
      actor: string;
      session: Session;
      fromOverride: false;
      /**
       * The raw `--git-common-dir` this branch's `stateDir` was derived
       * from — carried so `assertRemoteMutationAllowed` can re-run
       * `resolveLegacyFallbackDir` live, immediately before it trusts
       * `stateDir`, instead of trusting this snapshot's decision
       * unconditionally (see `resolveLegacyFallbackDir`'s own comment).
       */
      legacyStateDirForFallback: string;
    }
  | null
> {
  const session = resolveSession(label);
  const override = process.env.DRIVE_PR_STATE_DIR ?? "";
  // Matching `resolveStateDir`'s own guard (store.ts): this function reads
  // the raw env var directly rather than going through that function, so a
  // relative override reaching THIS fence would resolve against whichever
  // directory this process happened to launch from — the base checkout and
  // a linked worktree launching from different cwds would silently fence
  // against two different directories.
  if (override !== "" && !isAbsolute(override)) {
    fail(
      2,
      `${label}: $DRIVE_PR_STATE_DIR must be an absolute path, got: ${override}`,
      "A relative override resolves against the current working directory,",
      "so two participants launched from different directories (the base",
      "checkout and a linked worktree, in particular) would silently fence",
      "against two different state directories.",
    );
  }
  const stateDir = override;
  if (stateDir !== "") {
    // A driver exports its resolved leaf and its directory baseline. Preserve
    // that memory even when the checkout's .git has since disappeared. Every
    // state writer still derives the clone key independently in openStore.
    if (
      /^[0-9a-f]{16}$/.test(basename(stateDir)) &&
      parseDirIdentityToken(process.env.DRIVE_PR_STATE_DIR_IDENTITY ?? "")
        .kind === "ok"
    ) {
      return await resolveOverrideContext(label, stateDir, session, readVolume);
    }
    return await resolveOverrideContext(
      label,
      scopedOverrideDir(stateDir, await resolveLegacyStateDir(), true),
      session,
      readVolume,
    );
  }
  return await resolveGitFenceContext(label, session);
}

/**
 * How many times `assertRemoteMutationAllowed`'s lock-acquisition loop may
 * release-and-retry after `resolveLegacyFallbackDir` moves again post-
 * acquire. The decision is monotonic (legacyDir -> newDir, never back), so a
 * real clone needs at most one retry to converge; this only guards against a
 * defect turning that into a spin, not a case expected to fire in practice.
 */
export const MAX_DIR_REFRESH_ATTEMPTS = 3;

/**
 * `legacyDir` vs its relocation, for the non-override fence path.
 * Extracted so `assertRemoteMutationAllowed` can re-run this SAME decision
 * live, right before its enumeration trusts it — see the call site's own
 * comment for why a single snapshot decision here is not enough on its own
 * (a time-of-check-to-time-of-use race).
 *
 * `newDir` existing at all — not just its migration marker — counts as
 * "current-code drive has been admitted here": `ensureMigratedFromLegacy`
 * always `mkdirSync`s it before doing anything else, and its own marker
 * write is best-effort, so a drive can be legitimately using `newDir` with
 * the marker still absent (see the call site in `resolveFenceContext` for
 * the full argument).
 */
export function resolveLegacyFallbackDir(legacyDir: string): string {
  // `peekDefaultStateDirFor`, never `defaultStateDirFor`: this fence is
  // documented (see the call site below) as lightweight and read-only, and
  // `defaultStateDirFor` calls `cloneKey`, which MINTS and durably persists
  // a fresh clone identity the first time it runs on a clone that has none
  // yet — a real, on-disk side effect a read-only check must not have (the
  // same argument `peekCloneKey`'s own doc already makes for
  // `migrate-legacy-state.ts`'s dry-run path). `null` means no identity has
  // ever been minted for this clone — which means nothing could possibly
  // have been admitted into `newDir` either, since admission is what mints
  // the identity in the first place — so the fallback to `legacyDir` below
  // is exact, not a guess.
  const newDir = peekDefaultStateDirFor(legacyDir);
  if (newDir === null) return legacyDir;
  return resolveRelocatedFallback(legacyDir, newDir);
}

/**
 * The fence over an IRREVERSIBLE external mutation: may this session still
 * post to GitHub for this drive?
 *
 * `assertLeaseUnchanged` cannot serve here. It compares an ADMITTED lease, and
 * the callers — `reply-to-thread.ts` and `answer-summary-finding.ts` — hold
 * none: they are fresh processes that never claimed one, which is exactly why
 * they used to meet the lease only afterwards, at the `drive-state.ts hold`
 * that records what they already posted. So this asks the one question that can
 * be answered without an admission token: is SOMEONE ELSE now driving this
 * working tree?
 *
 * Refuses on a lease that is neither ours nor abandoned, and on a lease file it
 * cannot read at all. The cases that proceed are each deliberate:
 *
 *   - NO LEASE FILE. Not a refusal, by design: `/resolve-review-comments`
 *     is usable standalone, and
 *     a pass that has not yet run a mutating `drive-state.ts` command
 *     legitimately holds no lease — the first reply of a round, answering a
 *     `rejected` finding, happens before anything is held.
 *   - THE LEASE IS OURS. Matched by `isMine` on (pid, host) and — when this
 *     caller carries one — `sessionStarted`, not on `generation`: a renewal
 *     preserves the generation and a takeover mints a new one, but this
 *     caller has no earlier generation to compare either against. What it can
 *     prove is that the session named on disk is this one. A tier-3 caller
 *     matches on a different basis entirely — its record names a TREE, so
 *     `isMine` compares actors and never consults the session fields (*     and see that function for why the two cases must not share a test).
 *
 *     CLOSED for the common case: `$DRIVE_PR_SESSION` names a pid inherited
 *     at spawn time, with nothing on its own to prove that pid still means
 *     what it did then. If this pass's own driver dies and the OS later
 *     recycles its exact pid for an unrelated replacement driver, a bare
 *     (pid, host) match would read the replacement's fresh lease as "ours" —
 *     skipping past it without ever reaching the `leaseAlive` check that
 *     would otherwise have refused a live, genuinely foreign session
 *     (reproduced). `isMine` now also requires `sessionStarted` to match
 *     whenever THIS caller carries one, and `drive.ts` always exports
 *     `$DRIVE_PR_SESSION_STARTED` alongside `$DRIVE_PR_SESSION` — so every
 *     pass it spawns carries a token a recycled pid cannot reproduce, and the
 *     replacement's differently-tokened lease is correctly read as foreign.
 *
 *     Narrower now, not gone: a caller that identifies via bare pid with NO
 *     accompanying token — a tier-2 `$CLAUDE_PID` session, or a hand-set
 *     `$DRIVE_PR_SESSION` per SKILL.md § 6 — has nothing to check and falls
 *     back to (pid, host) alone, same as before. Demanding a token there
 *     would answer false for every legitimate renewal under that
 *     configuration — the exact "stand-down" bug `drives.ts`'s
 *     `ownParentDriver` already documents avoiding — so this is not an
 *     oversight left to close later; it is the same trade that function
 *     makes, for the same reason.
 *   - A FOREIGN LEASE THAT IS NOT ALIVE. Its owner is gone or has stopped
 *     driving, so there is no second writer to double-post against. Refusing
 *     here would wedge a tree whose previous drive merely ended — the direction
 *     this module's header refuses to guess in.
 *
 * `pr` widens the search when the caller knows which PR it is posting to
 * (`answer-summary-finding.ts` does; `reply-to-thread.ts` holds a thread node
 * id and would have to spend a network round-trip to learn one) — PR-WIDE,
 * across every worktree that holds a lease for it, not just this tree's own.
 * A driver can legitimately move to a DIFFERENT tree (this one's died, a
 * successor started fresh elsewhere), and a pass left running in the OLD tree
 * must still see that successor's live lease to refuse correctly — the
 * actor-wide search below is blind to every OTHER tree's leases by
 * construction, so a detached pass finds only its own dead driver's lease,
 * refuses nothing, and posts alongside whoever is actually driving the PR now
 *. With no PR it checks every
 * lease THIS WORKING TREE holds instead — PR-wide is not answerable without a
 * network round-trip this hot-path fence does not spend — which is sound for
 * the reason `actor.ts` gives: at most one drive runs per tree, so a live
 * foreign lease in this tree is a second session in it whichever PR it names.
 *
 * Narrowing (either way) is a FILTER over the enumeration, never a direct
 * `leasePathFor` read, and the difference is the fail-closed one. `readLease`
 * answers `null` for a path that does not exist AND for a path it cannot
 * reach — a state directory that is unreadable, or not a directory at all,
 * produces exactly the same "no lease" as a tree that has never been driven.
 * Enumerating first makes an unreadable state directory throw
 * (`leaseFilesForActor` and `leaseFilesFor` both re-raise anything that is
 * not `ENOENT`), so neither scoped path can pass a blind read off as an
 * all-clear.
 *
 * The same argument one level down is why the per-file read goes through
 * `readLeaseForFence` rather than `readLease`: an unreadable DIRECTORY was
 * fenced while an unreadable FILE inside it still read as "no lease" and
 * permitted the post. Fixing the
 * enumeration and leaving the record was the instance, not the class.
 */
/**
 * Re-enumerate the override directory's lease-file names AFTER
 * `assertRemoteMutationAllowed` has (possibly) waited on `remoteLock`
 *.
 *
 * `ctx.overrideEntries` is captured once by `resolveFenceContext`, called by
 * the CALLER before this function ever runs — sound when `checkAllowed` used
 * it essentially back-to-back, which is what every directory-swap fix above
 * assumed. `remoteLock.acquire` breaks that assumption: it can wait up to
 * `LOCK_ACQUIRE_MAX_SEC` for a REPLACEMENT claimant to finish writing its
 * own lease and release the lock, and trusting the pre-wait snapshot after
 * that wait reads the replacement's freshly-written lease as `absent` — the
 * exact handoff race this whole lock exists to close, reopened one level up
 * by the wait itself.
 *
 * The non-override path needs no equivalent fix: its own enumeration
 * (`leaseFilesForActor` / `leaseFilesFor`) runs LIVE, inside `checkAllowed`
 * itself, which is already called after the wait — there is no earlier
 * snapshot for it to go stale relative to.
 *
 * Mirrors `resolveFenceContext`'s own override-branch enumeration: a fresh
 * `readdirSync`, bracketed before/after by `statDirIdentity` so a
 * rename-and-recreate landing DURING this re-enumeration is caught rather
 * than silently read as an empty directory — and the result is ALSO
 * compared against the ORIGINAL `originalIdentity` (not merely against
 * itself), so a swap that happened at any point since the pass started —
 * not just during this one re-read — still fails closed.
 */
export function refreshOverrideEntries(
  label: string,
  stateDir: string,
  originalIdentity: DirIdentity,
): { overrideEntries: string[]; stateDirIdentity: DirIdentity } {
  const { beforeEnumeration, overrideEntries } = enumerateOverrideDirectory(
    stateDir,
    (e) => {
      const code = (e as NodeJS.ErrnoException)?.code;
      fail(
        1,
        `${label}: the drive state directory could not be re-read after waiting on the PR-wide lock (${code ?? String(e)}):`,
        `  ${stateDir}`,
        "",
        "Refusing to post. Whether another live session still holds this PR is now",
        "unknown, and an outcome reply has no undo.",
      );
    },
  );
  const afterEnumeration = statDirIdentity(stateDir);
  if (
    afterEnumeration === null ||
    !sameDirIdentity2(beforeEnumeration, afterEnumeration)
  ) {
    fail(
      1,
      `${label}: the drive state directory was replaced while its lease set was being re-read after the PR-wide lock wait:`,
      `  ${stateDir}`,
      "",
      "Refusing to post. The listing this check would judge from was not taken",
      "from a single, stable directory, so a lease it did not see may still be",
      "live in the directory that moved.",
    );
  }
  if (!sameDirIdentity(originalIdentity, afterEnumeration)) {
    fail(
      1,
      `${label}: the drive state directory changed identity while this call waited on the PR-wide lock:`,
      `  ${stateDir}`,
      "",
      "Refusing to post. A live lease may still be sitting in the directory that",
      "moved before this wait even began.",
    );
  }
  return { overrideEntries, stateDirIdentity: afterEnumeration };
}

async function resolveOverrideContext(
  label: string,
  stateDir: string,
  session: Session,
  readVolume: VolumeIdentityReader,
): Promise<Exclude<Awaited<ReturnType<typeof resolveFenceContext>>, null>> {
  // Resolved BEFORE the enumeration below, not after: an `await` here — and
  // everything `worktreeKey()` does under it — sitting BETWEEN a check and a
  // LATER, separate enumeration is exactly the gap a successor driver can
  // move the git common dir inside of. Awaiting first makes everything from
  // here on purely synchronous.
  const actor = await resolveActor();
  // An inherited override asserts this directory ALREADY exists — `drive.ts`
  // exports it only after resolving its own state dir, which by then holds
  // at least this drive's own lease. Its disappearance (a renamed git common
  // dir, a moved worktree) is therefore an anomaly, not the ordinary
  // "no drive has ever run here" case a fresh, never-driven tree gets.
  //
  // ENUMERATED here, not merely `statSync`'d — and the RESULT carried
  // forward for `assertRemoteMutationAllowed` to filter in-memory, rather
  // than re-ENUMERATING the directory later. Two earlier attempts at
  // narrowing a check-then-later-use gap (statSync ordering, then an
  // `ENOENT`-only indeterminate flag on the later read) both left a real
  // window open: renaming this directory away and creating an EMPTY one at
  // the same pathname raises no `ENOENT` anywhere, so an `ENOENT`-keyed
  // check cannot see it — the enumeration would simply, and wrongly, read
  // as confirmed empty. Freezing the NAME LIST here closes that half: a
  // rename-and-recreate cannot inject or hide a name this fence reasons
  // about, because the list was already fixed before it could land.
  //
  // It does NOT close the CONTENT half, and an earlier version of this
  // comment overclaimed that it did ("there is no later moment left for it
  // to target"): `assertRemoteMutationAllowed` still has to OPEN each
  // candidate afterwards to learn who holds it, and that per-file read is
  // unavoidably a second, genuine filesystem touch against this same path —
  // the file this enumeration saw may no longer be reachable there if the
  // directory itself was swapped, and `readLeaseForFence` would then report
  // `absent` for a lease that is still live in the directory that moved (a
  // swap landing DURING this fence; a swap before the pass started is a
  // different window, closed by the inherited driver baseline further
  // below, not by this).
  // `stateDirIdentity` below is what closes THAT:
  // captured in the same breath as this enumeration, and re-confirmed by
  // `assertStateDirIdentityUnchanged` before any later `absent` read is
  // trusted, and once more immediately before the post is authorized. A
  // rename-and-recreate landing between here and either of those checks now
  // fails closed instead of reading as an all-clear — narrowing the
  // residual to the gap between that LAST identity check and the actual
  // GitHub POST, which is the module header's own "check and post are two
  // moments" residual, not a new one.
  // Opening bracket: the identity BEFORE the listing. Capturing only
  // afterwards would describe whatever directory is at this path by then, so
  // a swap landing between the listing and that capture would be measured
  // against the replacement rather than against what was actually
  // enumerated. This matters
  // here even when a driver baseline IS inherited, and it is the ONLY
  // protection for this window when one is not.
  const { beforeEnumeration, overrideEntries } = enumerateOverrideDirectory(
    stateDir,
    (e) => {
      const code = (e as NodeJS.ErrnoException)?.code;
      fail(
        1,
        `${label}: the inherited drive state directory could not be read (${code ?? String(e)}):`,
        `  ${stateDir}`,
        "",
        "Refusing to post. $DRIVE_PR_STATE_DIR asserts this directory already",
        "holds this drive's own state, so a failure to enumerate it now is not",
        'the ordinary "no drive has run here" case — something moved, removed,',
        "or replaced it, and whether another session still holds this tree's",
        "lease is now unknown.",
      );
    },
  );
  const stateDirIdentity = statDirIdentity(stateDir);
  if (stateDirIdentity === null) {
    fail(
      1,
      `${label}: the inherited drive state directory's identity could not be confirmed right after listing it:`,
      `  ${stateDir}`,
      "",
      "Refusing to post. This directory was just enumerated successfully, so an",
      "identity check failing immediately afterwards means it is being torn down",
      "or replaced right now — exactly the moment a live lease inside it must not",
      "be read as absent.",
    );
  }
  // Closing bracket: the listing above is only trustworthy if it was taken
  // from one stable directory. A mismatch here means it was not, and no
  // later check can repair a name list read from a directory that has since
  // been swapped away.
  if (!sameDirIdentity2(beforeEnumeration, stateDirIdentity)) {
    fail(
      1,
      `${label}: the inherited drive state directory was replaced while it was being listed:`,
      `  ${stateDir}`,
      "",
      "Refusing to post. The name list this fence would judge from was not taken",
      "from a single, stable directory, so a lease it did not see may still be live",
      "in the directory that moved.",
    );
  }
  // The baseline the DRIVER observed, before this pass existed. Everything
  // above proves the directory did not change during this fence; only this
  // can prove it did not change BEFORE it — a rename-and-recreate that
  // completed before the pass started leaves a replacement whose identity
  // is perfectly stable from here on, so a fence that only watches itself
  // reads it as an all-clear.
  //
  // REQUIRED on this path, not optional. This branch is reached only when
  // `$DRIVE_PR_STATE_DIR` is set, and `drive.ts` is the only thing that sets
  // it — and it either exports the identity beside it or refuses to start.
  // So a state-dir override arriving WITHOUT an identity can only come from
  // a driver predating that change, and treating it as "no baseline, carry
  // on" is a compatibility path for superseded code that permanently
  // preserves the unfenced pre-baseline behaviour — which the pre-release
  // stance against backward-compatibility shims rules out.
  //
  // An earlier revision justified the absent case with "an interactive
  // session". That was simply wrong: an interactive session sets no
  // override and never reaches this branch at all — it takes the
  // non-override path below, where "never existed" is the ordinary case and
  // stays allowed. Nothing legitimate is refused here.
  //
  // Present but unparseable → something set it and this process cannot tell
  // what it meant, which is the question going unanswered in front of a
  // mutation with no undo, so it refuses.
  const inherited = parseDirIdentityToken(
    process.env.DRIVE_PR_STATE_DIR_IDENTITY ?? "",
  );
  if (inherited.kind === "absent") {
    fail(
      1,
      `${label}: $DRIVE_PR_STATE_DIR is set but $DRIVE_PR_STATE_DIR_IDENTITY is not:`,
      `  ${stateDir}`,
      "",
      "Refusing to post. A state-directory override asserts a drive resolved this",
      "path, and every current driver exports the directory identity beside it —",
      "so an override arriving without one means this pass cannot tell whether the",
      "directory was already swapped before it started. Re-run through a current",
      "drive.ts, or unset $DRIVE_PR_STATE_DIR to use the ordinary path.",
    );
  }
  if (inherited.kind === "bad") {
    fail(
      1,
      `${label}: $DRIVE_PR_STATE_DIR_IDENTITY is set but not a '<dev>:<ino>' pair or an extended directory identity token:`,
      `  ${process.env.DRIVE_PR_STATE_DIR_IDENTITY}`,
      "",
      "Refusing to post. This variable is the driver-established baseline that",
      "proves the inherited state directory was not swapped before this pass",
      "started; an unreadable one is that proof going missing, not an all-clear.",
    );
  }
  let comparisonIdentity = stateDirIdentity;
  if (
    inherited.kind === "ok" &&
    inherited.id.dev !== stateDirIdentity.dev &&
    inherited.id.volumeUUID !== undefined
  ) {
    const volume = await readVolume(stateDir);
    assertStateDirIdentityUnchanged(
      label,
      stateDir,
      stateDirIdentity,
      "while checking the volume identity",
    );
    if (volume !== null)
      comparisonIdentity = { ...stateDirIdentity, volumeUUID: volume };
  }
  if (
    inherited.kind === "ok" &&
    !sameDirIdentity(inherited.id, comparisonIdentity)
    // `kind === 'absent'` and `'bad'` are already refused above, so this is
    // the only case left to compare — kept as an explicit narrowing rather
    // than an assertion, so a future third kind fails the type-check here
    // instead of silently falling through to "allowed".
  ) {
    fail(
      1,
      `${label}: the inherited drive state directory is not the one this drive resolved:`,
      `  ${stateDir}`,
      "",
      "Refusing to post. The directory could not be matched to the driver baseline.",
      "A device change needs the same inode, birth time, canonical target and a",
      "freshly confirmed volume UUID. Missing proof is not evidence of a benign",
      "change: a live lease may still sit in the directory that moved.",
    );
  }
  return {
    stateDir,
    actor,
    session,
    fromOverride: true,
    overrideEntries,
    stateDirIdentity,
  };
}

async function resolveGitFenceContext(
  label: string,
  session: Session,
): Promise<Awaited<ReturnType<typeof resolveFenceContext>>> {
  let stateDir = "";
  const r = await git(["rev-parse", "--git-common-dir"], {
    stderr: "ignore",
    timeoutSec: gitCallTimeoutSeconds(),
  });
  // A SUCCESSFUL git is the only thing that names the state dir. Every
  // failure — a spawn that never ran, a deadline, any fatal, or an exit 0
  // that named nothing — falls through to the one question that can still be
  // answered soundly: is there a repository here at all?
  //
  // Reading a failure as "no drive state" is a fail-open, and a reproduced
  // one: `PATH=/nonexistent` made the spawn fail and this permitted the POST
  // with no lease checked.
  // Reading git's exit 128 as "no repository" is the SAME fail-open one step
  // narrower, because 128 is git's generic fatal status — see
  // `repositoryIsInPlay`, which is why that question is now answered from the
  // filesystem rather than from git's exit code.
  stateDir = r.code === 0 ? r.stdout.trim() : "";
  if (stateDir === "") {
    // No repository FOUND, and therefore no lease this process can read:
    // nothing here could have written one, whatever git's reason for not
    // answering. This is the standalone `/resolve-review-comments` case, and
    // the ONLY thing that may still post.
    //
    // "No repository found" is weaker than "provably no repository ever",
    // and the gap is the reachable one: a marker DELETED or RENAMED after a
    // drive wrote its lease produces a genuine `ENOENT`, which no filesystem
    // probe can tell apart from a tree that never held a repository
    //. `repositoryIsInPlay` closes
    // the cases where the marker is still THERE but unreadable — a broken
    // symlink, an unsearchable ancestor — and cannot close these.
    //
    // What closes them is not a better probe but durable knowledge, which is
    // why `drive.ts` exports `$DRIVE_PR_STATE_DIR` to every pass it spawns:
    // the override above short-circuits this whole path, so a driven pass
    // reads the real lease no matter what happened to its `.git`. Since a
    // lease exists only because a drive wrote one, and a drive owns its
    // passes, that is the path where an unchecked lease could actually
    // double an outcome reply.
    //
    // RESIDUAL: an interactive session that claimed a lease and then lost
    // its marker has no driver to inherit that from, and nothing here
    // remembers the directory across processes. It is listed with the
    // module's other residuals rather than closed, because closing it needs
    // state kept outside the repository — a strictly larger design than the
    // fence, and one that would itself need a staleness story.
    if (!r.timedOut && !repositoryIsInPlay()) return null;
    fail(
      1,
      `${label}: git could not say where this clone's drive state lives (${r.timedOut ? "timed out" : r.code === 0 ? "exited 0 but named no directory" : `exited ${r.code}`}), and this IS a repository — so whether another session has taken its drive lease is unknown.`,
      "Refusing to post rather than answer that question by assuming: an outcome",
      "reply cannot be withdrawn once it is on the thread.",
      "",
      "Being outside a repository is a different case and still posts — there is",
      "no drive state anywhere for a lease to sit in. It is established from the",
      "filesystem, not from git's exit status, because 128 is git's generic fatal",
      "status and covers dubious ownership and corruption as well.",
    );
  }
  // `stateDir` here is the LEGACY `--git-common-dir` — `resolveStateDir()`'s
  // own default moved off it, so a fence that stopped here would
  // keep reading a location nothing writes to anymore while every other
  // consumer (including this same process's own lease writes) reads and
  // writes `~/.local/state/jig/drive-pr/<cloneKey>/`. A standalone command run
  // without `$DRIVE_PR_STATE_DIR` would then authorize a mutation without
  // ever seeing a live lease that exists only in the relocated directory.
  //
  // NOT routed through `resolveStateDir()`'s own `ensureMigratedFromLegacy`
  // guard, on purpose: that guard is a HARD refusal for a clone with real
  // unmigrated legacy content, correct for a STATE WRITER (a fresh drive
  // must never silently start over an unmigrated clone's parked decisions)
  // but wrong for this lightweight, read-only fence, whose caller may have
  // nothing to do with drive-pr's own durable state at all. Calling it
  // directly would refuse every standalone post on any clone that has not
  // yet run the one-time migration — which, before a human runs it, is
  // every clone in the fleet.
  //
  // Reasoned instead from what a REAL drive can and cannot do: `drive.ts`
  // calls `resolveStateDir()` at startup, so an unmigrated clone SHOULD
  // have no live drive running current code — starting one is blocked at
  // the same gate. But "no marker" does not perfectly prove that: an empty
  // legacy footprint makes `ensureMigratedFromLegacy` create `newDir` and
  // let the caller through WITHOUT the marker if its own best-effort
  // `writeFileSync(marker, '')` fails — deliberately, per that function's
  // own doc comment, so a transient write failure never blocks an
  // otherwise-clean resolution. A drive admitted that way writes its lease
  // into `newDir` while the marker stays absent, and a marker-only check
  // here would still fall back to `legacyDir` and miss it entirely
  //. `newDir` existing at all is the
  // other half of the signal: `ensureMigratedFromLegacy` always `mkdirSync`s
  // it before doing anything else, so its presence means at least one
  // caller reached this point — checking there too, not the marker alone,
  // is what a current-code writer can actually leave behind. Once
  // migrated, the canonical location (and therefore wherever a live lease
  // sits) is the new default; the fence follows it there. Only when
  // `newDir` has never been touched at all does the fallback still check
  // `legacyDir` — an old, older process is the only thing that
  // could be live there, the same residual `legacy-state.ts`'s own header
  // already accepts. Narrower still: a clone with REAL unmigrated content
  // whose only `resolveStateDir()` attempt so far hard-failed also leaves
  // `newDir` existing-but-empty, which this check cannot tell apart from
  // "a current-code drive is genuinely using it" — an old-code lease in
  // `legacyDir` at that exact intersection stays invisible. Accepted for
  // the same reason as the residual above: it needs a REAL old, un-upgraded
  // process racing a REAL unmigrated clone's very first resolution attempt,
  // not closable without checking both locations unconditionally, which
  // is a larger change than this fence's existing single-`stateDir`
  // contract supports today.
  const legacyDir = resolve(stateDir);
  stateDir = resolveLegacyFallbackDir(legacyDir);
  return {
    stateDir,
    actor: await resolveActor(),
    session,
    fromOverride: false,
    legacyStateDirForFallback: legacyDir,
  };
}

function enumerateOverrideDirectory(
  stateDir: string,
  onError: (error: unknown) => never,
): { beforeEnumeration: DirIdentity | null; overrideEntries: string[] } {
  const beforeEnumeration = statDirIdentity(stateDir);
  try {
    return { beforeEnumeration, overrideEntries: readdirSync(stateDir) };
  } catch (error) {
    return onError(error);
  }
}

function resolveRelocatedFallback(legacyDir: string, newDir: string): string {
  if (existsSync(migratedMarkerPath(newDir))) return resolve(newDir);
  // Past this point the marker is ABSENT, and `newDir` existing on its own
  // is NOT reliable proof anything is genuinely using it: both
  // `ensureMigratedFromLegacy` and `migrate-legacy-state.ts --apply`
  // `mkdirSync(newDir)` BEFORE scanning `legacyDir`'s footprint and
  // possibly refusing — so an empty `newDir` is exactly as consistent with
  // "a current-code drive is admitted here" as with "an admission attempt
  // was refused moments ago and never wrote anything". Trusting the bare
  // `existsSync(newDir)` in that second case would select the empty
  // directory and never look at `legacyDir` at all, missing a genuine
  // old-code (or newly-refused) lease sitting there (an earlier "prefer empty
  // newDir" refinement fixed the symmetric case but left this unconditional
  // check itself unfixed).
  //
  // The one signal that tells the two apart without checking both
  // directories on every call: whether `legacyDir` itself still holds real
  // content. Empty means there is nothing there to miss either way, so
  // `newDir` — existing already, or fresh — is safe to prefer. Non-empty
  // means something might depend on it, so `legacyDir` stays authoritative
  // until either the marker publishes or that content clears.
  if (legacyFootprint(legacyDir).length === 0) {
    // `mkdirSync`, not a bare read: a lock acquired inside a directory that
    // does not exist yet has nowhere to write its file and spins for the
    // full acquire timeout instead of failing fast, since the underlying
    // primitive cannot tell "contended" apart from "the parent doesn't
    // exist" cheaply. Creating an EMPTY directory is not the minting side
    // effect this function exists to avoid — no identity is invented, and
    // `ensureMigratedFromLegacy` would create this exact directory moments
    // later for any real admission anyway; recursive because nothing
    // upstream of `.local/state/jig/` is guaranteed to exist either. A no-op when
    // `newDir` already existed.
    mkdirSync(newDir, { recursive: true });
    return resolve(newDir);
  }
  return legacyDir;
}
