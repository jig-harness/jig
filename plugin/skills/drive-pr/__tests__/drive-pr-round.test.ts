/**
 * drive-pr suite: announce-merge-ready.ts, marker overrides, round-delta.ts, round-plan.ts, the PR-target channel and guarded-push.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  changedFilesSince,
  changedFilesSinceExcludingMerges,
} from "../scripts/lib/round-delta.ts";
import {
  assertTreeMutationAllowed,
  type Session,
  stateDirIdentityToken,
  treeLeasePathFor,
} from "../scripts/lib/state/lease";
import { worktreeRoot } from "../scripts/lib/state/actor";
import { createLock } from "../scripts/lib/state/lock";
import { appendDirective } from "../scripts/lib/state/mailbox";

import {
  SCRIPTS,
  REPO_ROOT,
  writeVerifiedSha,
  HEAD,
  PREV,
  GIT_PUSH_FLAG_GUARD,
  ACTOR,
  type Fixture,
  DORMANT_ARM,
  tmpRoot,
  binDir,
  scratchClean,
  gitCleanEnv,
  makeScratchRepo,
  makeUnresolvedMergeRepo,
  makeRebasePausedRepo,
  writeFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { recheckHookEntry } from "./push-hold-recheck-hook.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import {
  byPlatform,
  skipsOnWindows,
} from "../../../../lib/test-helpers/windows-skip.ts";

useDrivePrSuite();

/** A path as a shell script inside double quotes reads it on every platform. */
const shellPath = (p: string): string => p.replaceAll("\\", "/");

/** The real `git`, for a stub that wraps it from a shell script. */
function realGitForShell(): string {
  const real = Bun.which("git");
  if (!real) throw new Error("no git on PATH to wrap for this probe");
  return shellPath(real);
}

const NO_TREE_KILL = skipsOnWindows(
  "process-lifecycle",
  "killing a process on Windows does not reach its children, so a hung or slow child process tree outlives the deadline",
);
const NO_QUOTE_NAMES = skipsOnWindows(
  "file-system",
  "a double quote is not a legal file-name character on Windows, so the file cannot be created",
);

describe("announce-merge-ready.ts", () => {
  // The announcement's literal opening line, as the script composes it. The
  // sweep matches on this SHAPE — opener first, head marker last — so the
  // fixture has to reproduce it exactly; a rival that does not is not an
  // announcement, which is the whole point of the guard.
  const OPENER = "**Safe to merge from the driver's perspective.**";

  async function announce(
    f: Fixture,
    paginateFails: boolean,
    opts: {
      raceAfterPost?: boolean;
      postedIdBase?: string;
      /** Add a lower-id comment that merely QUOTES the head marker. */
      quoter?: boolean;
      /** Add a lower-id, perfectly-shaped announcement from an untrusted author. */
      forger?: boolean;
      /** An earlier run's announcement, left standing for this (now stale) head. */
      staleAnnouncementFor?: string;
      /** Id of the rival's announcement in the race fixture. Default 1. */
      rivalId?: string;
      /** Extra environment — deadline knobs, stub stall mode. */
      env?: Record<string, string>;
      /** Working tree to run in. Defaults to the CLEAN scratch repo. */
      cwd?: string;
      /**
       * A scratch edit lands in `cwd` once the shared head-reads counter
       * exceeds this number — modelling the tree going from clean to dirty
       * partway through the run, after the up-front cleanliness pass has
       * already seen it clean.
       */
      dirtyAfterReads?: number;
      /**
       * A COMMIT lands in `cwd` once the shared head-reads counter exceeds
       * this number — advancing local HEAD past what drive-status.ts already
       * verified, while leaving `git status` clean.
       */
      commitAfterReads?: number;
      /** A scratch edit lands in `cwd` DURING the POST call itself. */
      dirtyOnPost?: boolean;
      /**
       * A scratch edit lands in `cwd` once the shared sweep-reads counter
       * exceeds this number — for pinning a specific comment sweep among the
       * several this script makes.
       */
      dirtyAfterSweeps?: number;
      /** A scratch edit lands in `cwd` DURING a comment DELETE call. */
      dirtyOnDelete?: boolean;
      /**
       * The PR flips to draft once checkLiveState()'s OWN read counter
       * exceeds this number — its first call (liveRc) still sees the
       * fixture's own isDraft, so this models the owner converting the PR
       * to draft during the comment sweep or a later re-check.
       */
      draftAfterLiveStateReads?: number;
      /** checkLiveState()'s own isDraft read answers with the field omitted. */
      malformedIsDraftOnLiveStateReads?: boolean;
      /** Prepended ahead of `binDir` in PATH — for a probe's own `git` stub. */
      extraBinDir?: string;
      dryRun?: boolean;
      /** Spawn a wrapper that deletes this association from the LIVE
       * `TRUSTED_ASSOCIATIONS` object before dynamically importing
       * announce-merge-ready.ts itself — the live-dependency test, below. */
      deleteAssociationBeforeLoad?: string;
    } = {},
  ) {
    const { dir, stateDir } = writeFixture(f);
    // Every announcement is downstream of the PR-global final-verification
    // gate. Tests in this block exercise the announcement's own later
    // fail-closed branches, so seed the exact-head pointer they require; the
    // dedicated negative probe below omits it deliberately.
    writeVerifiedSha(stateDir, f.head ?? HEAD);
    if (paginateFails) writeFileSync(join(dir, "paginate-fails"), "");
    if (opts.raceAfterPost) writeFileSync(join(dir, "race-after-post"), "");
    if (opts.staleAnnouncementFor) {
      writeFileSync(join(dir, "stale-announcement"), opts.staleAnnouncementFor);
    }
    if (opts.dirtyAfterSweeps !== undefined) {
      writeFileSync(
        join(dir, "dirty-after-sweeps"),
        String(opts.dirtyAfterSweeps),
      );
    }
    if (opts.dirtyOnDelete) writeFileSync(join(dir, "dirty-on-delete"), "");
    if (opts.dirtyAfterReads !== undefined) {
      writeFileSync(
        join(dir, "dirty-after-reads"),
        String(opts.dirtyAfterReads),
      );
    }
    if (opts.commitAfterReads !== undefined) {
      writeFileSync(
        join(dir, "commit-after-reads"),
        String(opts.commitAfterReads),
      );
    }
    if (opts.draftAfterLiveStateReads !== undefined) {
      writeFileSync(
        join(dir, "draft-after-live-state-reads"),
        String(opts.draftAfterLiveStateReads),
      );
    }
    if (opts.malformedIsDraftOnLiveStateReads) {
      writeFileSync(join(dir, "malformed-isdraft-on-live-state-reads"), "");
    }
    if (opts.dirtyOnPost) writeFileSync(join(dir, "dirty-on-post"), "");
    let entryScript = join(SCRIPTS, "announce-merge-ready.ts");
    if (opts.deleteAssociationBeforeLoad !== undefined) {
      entryScript = join(dir, "announce-mutation-wrapper.ts");
      writeFileSync(
        entryScript,
        [
          "#!/usr/bin/env bun",
          `import { TRUSTED_ASSOCIATIONS } from ${JSON.stringify(join(SCRIPTS, "summary-findings.ts"))};`,
          `TRUSTED_ASSOCIATIONS.delete(${JSON.stringify(opts.deleteAssociationBeforeLoad)});`,
          `await import(${JSON.stringify(join(SCRIPTS, "announce-merge-ready.ts"))});`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
    }
    const proc = Bun.spawn(
      scriptArgv(entryScript, "999", ...(opts.dryRun ? ["--dry-run"] : [])),
      {
        // A scratch repo, never the real checkout: the script refuses to
        // announce over a dirty tree, and the real checkout is dirty whenever
        // anyone is editing it. gitCleanEnv, not process.env: a git hook
        // exports GIT_DIR and GIT_INDEX_FILE, and inheriting them points every
        // git call inside the script back at the real repository.
        cwd: opts.cwd ?? scratchClean.dir,
        env: {
          ...gitCleanEnv(),
          PATH: `${opts.extraBinDir ? `${opts.extraBinDir}${delimiter}` : ""}${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(stateDir),
          DRIVE_PR_MERGE_MARKER_FIXTURE: `<!-- drive-pr-merge-ready: ${f.head} -->`,
          DRIVE_PR_ANNOUNCE_OPENER_FIXTURE: OPENER,
          ...(opts.rivalId ? { DRIVE_PR_RIVAL_ID: opts.rivalId } : {}),
          ...(opts.quoter ? { DRIVE_PR_QUOTER: "1" } : {}),
          ...(opts.forger ? { DRIVE_PR_FORGER: "1" } : {}),
          ...(opts.postedIdBase
            ? { DRIVE_PR_POSTED_ID_BASE: opts.postedIdBase }
            : {}),
          ...(opts.env ?? {}),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const posted = existsSync(join(dir, "posted.jsonl"));
    const deleted = existsSync(join(dir, "deleted.jsonl"))
      ? readFileSync(join(dir, "deleted.jsonl"), "utf8").trim().split("\n")
      : [];
    return { stderr, exitCode, posted, deleted };
  }

  // announce-merge-ready.ts calls drive-status.ts with no --no-head-sync (it is
  // announcing about the REAL branch), so the fixture head must be the local
  // HEAD of the tree it runs in or every probe here stops at HEAD_LAG —
  // passing the fail-closed assertion for entirely the wrong reason. That
  // tree is the clean scratch repo every spawn above defaults to, so its HEAD
  // is the fixture head.
  let CONVERGED: Fixture;
  beforeAll(() => {
    CONVERGED = {
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
    };
  });

  it("refuses when the existing-announcement check cannot be read", async () => {
    // `gh api --paginate | grep -q` answers "not announced yet" in two ways it
    // does not actually know: grep exits on its first match and SIGPIPEs the
    // still-paginating gh, which `pipefail` turns into a false condition; and a
    // transient read failure is swallowed into the same false. Both post a
    // SECOND announcement on a PR that already had one — and an announcement is
    // the artefact a human acts on without re-deriving it, so it must fail
    // closed rather than duplicate.
    const r = await announce(CONVERGED, true);
    expect(r.exitCode).toBe(1);
    expect(r.posted).toBe(false);
    // The SPECIFIC refusal, not just any exit 1: every other rejection path in
    // this script (HEAD_LAG, not-CONVERGED, CI not green) also says "refusing
    // to announce", so a loose assertion passes without the guard existing.
    expect(r.stderr).toContain("cannot read PR #999's comments");
  });

  it("bounds the drive-status.ts INVOCATION, not just the calls inside it", async () => {
    // GH_CALL_TIMEOUT bounds one request; it says nothing about the helper
    // process making them. A `drive-status.ts --once` that stalls anywhere its
    // own per-call wrapper does not reach parks THIS script — the one whose job
    // is to post an artefact a human acts on without re-deriving it — for as
    // long as the child's own deadlines allow, which is every remaining call
    // times GH_CALL_TIMEOUT rather than any bound this script advertises.
    //
    // The narrowing is what makes this pin the right guard: the stall is
    // scoped to `check-runs`, an endpoint only drive-status.ts's evidence path
    // asks for, so this script's own liveness read and comment sweep answer
    // normally and the probe cannot pass by refusing earlier for an unrelated
    // reason.
    //
    // The elapsed time IS the assertion. GH_CALL_TIMEOUT is pinned well above
    // the helper bound so that removing `timeoutSec` below does not hang the
    // suite — it fails on the clock, visibly, in ~30s instead.
    const started = Date.now();
    const r = await announce(CONVERGED, false, {
      env: {
        DRIVE_PR_HELPER_TIMEOUT: "1",
        GH_CALL_TIMEOUT: "30",
        DRIVE_PR_STUB_HANG: "30",
        DRIVE_PR_STUB_HANG_ON: "check-runs",
      },
    });
    const elapsed = Date.now() - started;
    expect(r.exitCode).toBe(1);
    expect(r.posted).toBe(false);
    expect(r.stderr).toContain("could not read drive status");
    expect({ boundedBeforeTheChildFinished: elapsed < 15_000 }).toEqual({
      boundedBeforeTheChildFinished: true,
    });
  });

  it("announces once on a converged, green head", async () => {
    // The other half of the guard: failing closed must not mean never posting.
    const r = await announce(CONVERGED, false);
    expect(r).toMatchObject({ exitCode: 0, posted: true, deleted: [] });
  });

  it("refuses a green aggregate without PR-global final verification", async () => {
    const { dir, stateDir } = writeFixture(CONVERGED);
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "announce-merge-ready.ts"), "999"),
      {
        cwd: scratchClean.dir,
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_MERGE_MARKER_FIXTURE: `<!-- drive-pr-merge-ready: ${CONVERGED.head} -->`,
          DRIVE_PR_ANNOUNCE_OPENER_FIXTURE: OPENER,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(existsSync(join(dir, "posted.jsonl"))).toBe(false);
    expect(stderr).toContain("not the globally green-verified SHA");
  });

  it("refuses to announce while 'ci:hold' is present", async () => {
    const r = await announce({ ...CONVERGED, ciHeld: true }, false);
    expect(r.exitCode).toBe(4);
    expect(r.posted).toBe(false);
    expect(r.stderr).toContain("'ci:hold' is still present");
  });

  it("withdraws a same-head announcement while 'ci:hold' is present", async () => {
    const r = await announce({ ...CONVERGED, ciHeld: true }, false, {
      staleAnnouncementFor: CONVERGED.head,
    });
    expect(r.exitCode).toBe(4);
    expect(r.posted).toBe(false);
    expect(r.deleted).toContain("7");
    expect(r.stderr).toContain("'ci:hold' is still present");
  });

  it("refuses to announce a converged PR that is still a draft", async () => {
    // CONVERGED is a claim about the posting reviewer,
    // which reviews drafts — it says nothing about CodeRabbit, which refuses
    // one outright. Announcing "safe to merge" about a PR CodeRabbit has
    // never seen, and by repo policy never will until a human or a drive
    // marks it Ready, is exactly the false terminal drive.ts itself now
    // refuses to report as exit 0.
    //
    // This is now `checkLiveState()`'s own draft message, not a bespoke
    // up-front one: the up-front check
    // used to trust `status.draft`, captured before real elapsed time (the
    // comment sweep, worktree checks) that a human could mark the PR Ready
    // during — folded into `checkLiveState()`'s fresh read instead, which
    // already ran next either way.
    const r = await announce({ ...CONVERGED, isDraft: true }, false);
    expect(r.exitCode).toBe(4);
    expect(r.posted).toBe(false);
    expect(r.stderr).toContain("is a draft again as of this re-read");
  });

  it("withdraws an existing announcement when the PR is ALREADY draft at the up-front gate, not just when it turns draft mid-run", async () => {
    // The up-front `status.draft === true` check used to fire through `fail()`
    // before `existingIds` was even computed, so a PR that is ALREADY a draft
    // when this run starts — with a "Safe to merge" comment already standing
    // for its current head — refused correctly but skipped every withdrawal
    // guard below it entirely, leaving the stale comment visible. The first fix
    // still trusted the STALE `status.draft` rather than a fresh read, so it
    // was folded into `checkLiveState()` entirely — its own draft-confirmed
    // branch already withdraws `existingIds` via `withdrawIfConfirmedStale`.
    const r = await announce({ ...CONVERGED, isDraft: true }, false, {
      staleAnnouncementFor: CONVERGED.head,
    });
    expect(r.exitCode).toBe(4);
    expect(r.posted).toBe(false);
    expect(r.deleted).toEqual(["7"]);
    expect(r.stderr).toContain("withdrawing now-stale announcement");
    expect(r.stderr).toContain("is a draft again as of this re-read");
  });

  it("genuinely depends on the LIVE TRUSTED_ASSOCIATIONS object, not a same-valued copy", async () => {
    // Same regression class the reconcile-replied-threads.ts sibling test
    // closes: a consumer that builds its OWN Set with today's members — `new
    // Set(['OWNER', 'MEMBER', 'COLLABORATOR'])` — would pass every import
    // check, every no-local-const check, and every call-site regex, because
    // the decoy happens to agree with the export right now. It only reveals
    // itself once the two diverge.
    //
    // The stale-announcement comment above is authored by an OWNER
    // (`author_association: "OWNER"`, the stub's fixed value — see the stub's
    // own comment near `$F/stale-announcement`), and the baseline test just
    // above proves the script recognises it and withdraws it (`deleted`:
    // `['7']`). Deleting 'OWNER' from the object announce-merge-ready.ts
    // actually imports, before it loads, should make that SAME comment
    // unrecognised — nothing left standing to withdraw. A consumer holding a
    // structurally separate copy would not see the deletion and would still
    // withdraw it, exactly like the baseline.
    const r = await announce({ ...CONVERGED, isDraft: true }, false, {
      staleAnnouncementFor: CONVERGED.head,
      deleteAssociationBeforeLoad: "OWNER",
    });
    expect(r.deleted).toEqual([]);
    expect(r.stderr).not.toContain("withdrawing now-stale announcement");
  });

  it("refuses to announce (or leave a standing announcement) when the PR turns draft during the sweep", async () => {
    // The up-front gate only catches a draft PR AT THAT MOMENT. checkLiveState()
    // is what the comment sweep and both idempotence-path checks call
    // afterward, and none of them previously re-read isDraft — so an owner
    // converting the PR back to draft in the window while the sweep runs
    // could still get a "Safe to merge" posted (or left standing) overriding
    // the very signal that made it stop being true. draftAfterLiveStateReads:
    // 1 lets checkLiveState()'s FIRST call (liveRc, right after the opening
    // CONVERGED gate) still see the fixture's own non-draft answer, and flips
    // to draft for every call after that.
    const r = await announce(CONVERGED, false, {
      draftAfterLiveStateReads: 1,
    });
    expect(r.exitCode).toBe(4);
    expect(r.posted).toBe(false);
    expect(r.stderr).toContain("is a draft again as of this re-read");
  });

  it("refuses to announce when checkLiveState()'s isDraft read is malformed, not merely `!== true`", async () => {
    // isDraft is decision evidence from an external response — the same
    // discipline evaluate() and mark-ready.ts already apply to it. An
    // absent, null, or otherwise non-boolean value must not read as "not a
    // draft"; that is the fail-open direction that would announce over a PR
    // whose current draftness this read could not actually confirm.
    const r = await announce(CONVERGED, false, {
      malformedIsDraftOnLiveStateReads: true,
    });
    expect(r.exitCode).toBe(1);
    expect(r.posted).toBe(false);
    expect(r.stderr).toContain("not a boolean");
  });

  it("withdraws an EXISTING announcement when the PR is confirmed draft again, not just the CONFLICTING case", async () => {
    // `liveConfirmedDraft` mirrors `liveConfirmedConflicting`: a draft
    // confirmed by the very first `checkLiveState()` call — the one this
    // function's top-level `liveRc` check reads before ever reaching the
    // comment sweep or the idempotence branch. Without it, this exact case —
    // an announcement already exists for this head, and the PR has since
    // gone back to draft — refused correctly but left the stale "Safe to
    // merge" comment standing, because the withdrawal condition checked only
    // `liveConfirmedConflicting`. `draftAfterLiveStateReads: 0` makes every
    // `checkLiveState()` call see draft, including the first.
    const r = await announce(CONVERGED, false, {
      staleAnnouncementFor: CONVERGED.head,
      draftAfterLiveStateReads: 0,
    });
    expect(r.posted).toBe(false);
    expect(r.exitCode).toBe(4);
    expect(r.deleted).toEqual(["7"]);
    expect(r.stderr).toContain("withdrawing now-stale announcement");
    expect(r.stderr).toContain("the PR is a draft again");
  });

  it('re-checks draftness (not just readLiveness\'s state+head) before reporting "already announced"', async () => {
    // The idempotence path used to re-confirm with `readLiveness`, which
    // answers state and head only — so a PR that went back to draft during
    // the comment sweep still passed this check and reported "already
    // announced ... nothing to do", leaving the stale announcement standing
    // and reporting success. The fix reuses `checkLiveState()` here, the same
    // function that already carries the withdrawal logic used at the top of
    // this function. `draftAfterLiveStateReads: 1` lets the top-level `liveRc`
    // call (the first) see the fixture's own non-draft answer — reaching the
    // idempotence branch at all — and flips to draft for the branch's own
    // confirmation call.
    const r = await announce(CONVERGED, false, {
      staleAnnouncementFor: CONVERGED.head,
      draftAfterLiveStateReads: 1,
    });
    expect(r.posted).toBe(false);
    expect(r.exitCode).toBe(4);
    expect(r.deleted).toEqual(["7"]);
    expect(r.stderr).toContain("withdrawing now-stale announcement");
    expect(r.stderr).toContain("the PR is a draft again");
    expect(r.stderr).not.toContain("already announced for");
  });

  it("re-checks draftness one last time after the post-write reconciliation sweep, before the final success return", async () => {
    // `afterRc` (right after the POST) already re-reads isDraft, but the
    // duplicate-reconciliation sweep that follows it is itself a real
    // round-trip an owner's Ready→draft conversion can land in — and until
    // this fix, nothing after `afterRc` asked the question again before the
    // LAST possible success return. `draftAfterLiveStateReads: 3` lets the
    // first three `checkLiveState()` calls (top-level liveRc, pre-POST, and
    // post-write afterRc) all see the fixture's own non-draft answer — so the
    // POST genuinely happens and afterRc genuinely passes — and flips to
    // draft only for the fourth call, the new final recheck.
    const r = await announce(CONVERGED, false, {
      draftAfterLiveStateReads: 3,
    });
    expect(r.posted).toBe(true);
    expect(r.deleted).toEqual(["9001"]);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("is a draft again as of this re-read");
    expect(r.stderr).toContain("withdrawing this announcement");
  });

  it("re-checks draftness before the dry-run success return too, not just the tree", async () => {
    // The dry-run branch only re-checked cleanliness before its success
    // return; `--dry-run` reporting "would announce" over a PR that went back
    // to draft since the up-front check is the same stale-eligibility mistake
    // as posting for real would be. `draftAfterLiveStateReads: 1` lets the
    // top-level `liveRc` call (the first) see the fixture's own non-draft
    // answer — reaching the dry-run branch at all — and flips to draft for
    // the dry-run branch's own recheck, its second call.
    const r = await announce(CONVERGED, false, {
      draftAfterLiveStateReads: 1,
      dryRun: true,
    });
    expect(r.posted).toBe(false);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("is a draft again as of this re-read");
  });

  it("withdraws the RIVAL announcement too, not just refuses, when the race path confirms draft", async () => {
    // The race-duplicate branch (our own comment withdrawn, a rival's stands)
    // already re-checked cleanliness one last time before its success return.
    // An earlier version added the same recheck for draftness, but only to
    // REFUSE: a confirmed draft must not retain a STANDING announcement,
    // whoever posted it, so this now withdraws the rival's surviving comment
    // too — `withdrawIfConfirmedStale` runs against `[lowest]`, not the
    // pre-POST `existingIds` (which named nothing here; the rival's comment did
    // not exist yet when that sweep ran).
    // `draftAfterLiveStateReads: 3` lets the first three `checkLiveState()`
    // calls (top-level, pre-POST, post-write afterRc) see the fixture's own
    // non-draft answer — so the POST and the duplicate reconciliation genuinely
    // happen — and flips to draft for the fourth call, the race-path recheck.
    const dirty = makeScratchRepo("scratch-announce-draft-race-reconcile");
    const r = await announce(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      false,
      {
        cwd: dirty.dir,
        raceAfterPost: true,
        postedIdBase: "9000",
        draftAfterLiveStateReads: 3,
      },
    );
    expect(r.posted).toBe(true);
    // Our own duplicate (9001), then the rival's (1) once draft is confirmed.
    expect(r.deleted).toEqual(["9001", "1"]);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("withdrawing this duplicate");
    expect(r.stderr).toContain("is a draft again as of this re-read");
    expect(r.stderr).toContain("withdrawing now-stale announcement");
  });

  it("refuses to announce over a dirty worktree, converged and green as it is", async () => {
    // CONVERGED and the CI verdict are claims about the remote; neither sees
    // an edit no round shipped. This comment is the artefact a human merges
    // on without re-deriving it, and a merge is exactly when an unshipped
    // local edit dies silently — so the announcement is gated on the same
    // clean-tree check the per-thread resolvers already enforce.
    const dirty = makeScratchRepo("scratch-announce-dirty");
    writeFileSync(
      join(dirty.dir, "leftover.txt"),
      "an edit no round shipped\n",
    );
    const r = await announce(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      false,
      { cwd: dirty.dir },
    );
    expect(r.exitCode).toBe(1);
    expect(r.posted).toBe(false);
    // The SPECIFIC refusal: every other rejection path here also says
    // "refusing" — a loose assertion passes without the guard existing.
    expect(r.stderr).toContain("uncommitted state");
    expect(r.stderr).toContain("leftover.txt");
  });

  it('re-checks cleanliness at the LAST point before "already announced", not only up front', async () => {
    // The up-front pass above sees a clean tree — but this script still does
    // real work after it (the comment sweep, the idempotence-path liveness
    // re-read) before reaching the "already announced" success return, and any
    // of that is a window a scratch edit can land in. `dirtyAfterReads: 3`
    // lets the up-front pass and drive-status.ts's own two reads answer over a
    // clean tree, then dirties it starting at this script's OWN first re-read
    // (its idempotence-path check_live_state) — strictly after the up-front
    // pass already ran, strictly before the idempotent return this probe
    // targets.
    const dirty = makeScratchRepo("scratch-announce-dirty-midrun-idempotent");
    const r = await announce(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      false,
      { cwd: dirty.dir, staleAnnouncementFor: dirty.head, dirtyAfterReads: 3 },
    );
    expect(r.posted).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain("already announced for");
    expect(r.stderr).toContain("uncommitted state");
    expect(r.stderr).toContain("leftover-midrun.txt");
  });

  it("re-checks cleanliness at the LAST point before POSTing, not only up front", async () => {
    // Same window on the path that actually writes a comment: body
    // construction and the dry-run branch sit between the up-front pass and
    // the POST, and this is the narrowest point left to close it before a real
    // comment gets written. No existing announcement here, so this exercises
    // the pre-POST guard rather than the idempotent-return one above.
    const dirty = makeScratchRepo("scratch-announce-dirty-midrun-prepost");
    const r = await announce(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      false,
      { cwd: dirty.dir, dirtyAfterReads: 3 },
    );
    expect(r.posted).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("uncommitted state");
    expect(r.stderr).toContain("leftover-midrun.txt");
  });

  it("re-checks cleanliness at the LAST point before --dry-run's own success return", async () => {
    // `--dry-run` never posts, but it is still a success return, and body
    // construction sits between the up-front pass and it — the same window
    // the pre-POST and idempotent-return guards close on the paths that DO
    // write something.
    const dirty = makeScratchRepo("scratch-announce-dirty-dryrun");
    const r = await announce(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      false,
      { cwd: dirty.dir, dirtyAfterReads: 3, dryRun: true },
    );
    expect(r.posted).toBe(false);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("uncommitted state");
    expect(r.stderr).toContain("leftover-midrun.txt");
  });

  it("refuses to announce when the head moved after the status call", async () => {
    // drive-status.ts re-checking internally cannot cover this window: it opens
    // after that call returns and stays open across the comment sweep and body
    // composition. An announcement is the artefact a human is most likely to act
    // on without re-deriving it, so a stale one is the expensive mistake.
    //
    // `headMovesAfter: 4` also lets the final-CI certificate's own PR snapshot
    // answer truthfully, so this pins THIS script's pre-POST guard rather than
    // the certificate, the status helper, or the cleanup.
    const r = await announce(
      { ...CONVERGED, headMovesTo: PREV, headMovesAfter: 4 },
      false,
    );
    expect(r.exitCode).toBe(4);
    expect(r.posted).toBe(false);
  });

  it("refuses when the PR stopped being mergeable before the post", async () => {
    // CONVERGED is a claim about the REVIEW and deliberately survives a base
    // that moved — gating it on the live base tip would mean never converging,
    // because GitHub's baseRefOid lags an active base as a standing condition.
    // But THIS artefact says "safe to merge", and that claim does depend on
    // mergeability, so it is re-read at the last possible moment alongside the
    // head. `mergeableMovesTo` rides the same read counter as `headMovesTo`,
    // and `2` lets drive-status.ts's own reads answer truthfully first — so
    // this pins THIS script's guard, not the one a layer down.
    const r = await announce(
      { ...CONVERGED, mergeableMovesTo: "CONFLICTING", headMovesAfter: 2 },
      false,
    );
    expect(r.exitCode).toBe(4);
    expect(r.posted).toBe(false);
    expect(r.stderr).toContain("SAFE TO MERGE");
  });

  it("refuses as INDETERMINATE (exit 1), not PR_NOT_OPEN (5), on a missing last-moment state", async () => {
    // Exit 5 is the shared PR_NOT_OPEN contract elsewhere in this skill and
    // asserts the PR is POSITIVELY known finished (MERGED/CLOSED). A missing
    // or unrecognized `state` on an otherwise-successful read only proves the
    // read partial, not that the PR is finished — conflating the two would
    // claim a certainty this evidence does not support, and a later poll could
    // easily see `state` populated again. `stateMovesTo` rides the same read
    // counter as `mergeableMovesTo`/`headMovesTo`; `5` also lets the final-CI
    // certificate's PR snapshot answer truthfully — including its own
    // last-moment re-check, one more read than the certificate used to make
    // — so this pins THIS
    // script's own last-moment guard.
    const r = await announce(
      { ...CONVERGED, stateMovesTo: null, headMovesAfter: 5 },
      false,
    );
    expect(r.exitCode).toBe(1);
    expect(r.posted).toBe(false);
    expect(r.deleted).toEqual([]);
    expect(r.stderr).toContain("not a recognized value");
  });

  it("still refuses (exit 5) on a recognized terminal last-moment state", async () => {
    // The other half: splitting the guard must not have swallowed the
    // positively-known case it was ALSO asked to keep distinct from. Same
    // read count as the sibling probe above, for the same reason.
    const r = await announce(
      { ...CONVERGED, stateMovesTo: "MERGED", headMovesAfter: 5 },
      false,
    );
    expect(r.exitCode).toBe(5);
    expect(r.posted).toBe(false);
    expect(r.deleted).toEqual([]);
  });

  it("WITHDRAWS its own announcement when the head moved across the POST", async () => {
    // The pre-post head read narrows the window; it cannot close it. The GET and
    // the POST stay separate operations, so a push landing between them still
    // publishes "Safe to merge" for a head nobody reviewed — and the race
    // reconciliation below does not help, because it only dedupes marker ids:
    // one announcement for an unreviewed head is not a duplicate of anything.
    //
    // `headMovesAfter: 9` (was 7): `ci-hold.ts final-ready` now re-snapshots
    // the PR a second time before returning success — its own last-moment
    // re-check, closing an equivalent race one layer down
    // — so each of this script's
    // two `confirmFinalCi()` calls ahead of this window (`prePostFinalCiRc`,
    // before the POST, and the read this test targets sits behind both of
    // them) now consumes one more read apiece. Net +2, verified empirically
    // against this suite rather than re-derived by hand.
    const r = await announce(
      { ...CONVERGED, headMovesTo: PREV, headMovesAfter: 9 },
      false,
    );
    expect(r.exitCode).toBe(4);
    expect(r.posted).toBe(true);
    expect(r.deleted).toEqual(["9001"]);
    expect(r.stderr).toContain("withdrawing this announcement");
  });

  it("WITHDRAWS its own announcement when the worktree became dirty DURING the POST", async () => {
    // The pre-POST tree check narrows this window; it cannot close it. The
    // check and the POST stay separate operations, so an edit landing in the
    // working directory while the POST is in flight still leaves "Safe to
    // merge" standing over a tree that shipped nothing — the exact loss mode
    // the pre-POST guard was added to close, now reached on the far side of
    // the write instead of before it. `dirtyOnPost` writes the scratch edit
    // as a side effect of the stub answering the POST itself, so the tree is
    // verifiably clean through every read before it and dirty from that
    // point on.
    const dirty = makeScratchRepo("scratch-announce-dirty-during-post");
    const r = await announce(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      false,
      { cwd: dirty.dir, dirtyOnPost: true },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.posted).toBe(true);
    expect(r.deleted).toEqual(["9001"]);
    expect(r.stderr).toContain("uncommitted state");
    expect(r.stderr).toContain("withdrawing this announcement");
  });

  it("re-checks cleanliness at the LAST point before the final success return", async () => {
    // The reconciliation sweep after the post-write confirmation is itself a
    // real round-trip, and the normal (no-race) path returns 0 right after it
    // with no further check — reopening the exact check-then-act window the
    // earlier guards were added to close, one step later. Three sweep calls
    // happen before this one: retract_stale's, the idempotence-decision one,
    // and this reconciliation one — `dirtyAfterSweeps: 2` lets the first two
    // answer over a clean tree and dirties it starting at the third.
    const dirty = makeScratchRepo("scratch-announce-dirty-reconcile-sweep");
    const r = await announce(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      false,
      { cwd: dirty.dir, dirtyAfterSweeps: 2 },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.posted).toBe(true);
    expect(r.deleted).toEqual(["9001"]);
    expect(r.stderr).toContain("uncommitted state");
    expect(r.stderr).toContain("withdrawing this announcement");
  });

  it("re-checks cleanliness after withdrawing a duplicate in the race path too", async () => {
    // Even in the branch where OUR announcement is withdrawn (a rival's
    // stands), exit 0 is still this session's own claim to leave nothing on
    // the floor — and the DELETE that withdraws our duplicate is itself a
    // real round-trip an edit can land in. Unlike the other late guards,
    // there is nothing further of OURS to withdraw here (our comment is
    // already gone), so a dirty tree just turns the exit non-zero.
    const dirty = makeScratchRepo("scratch-announce-dirty-race-delete");
    const r = await announce(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      false,
      {
        cwd: dirty.dir,
        raceAfterPost: true,
        postedIdBase: "9000", // ours lands at 9001, above the rival's id 1
        dirtyOnDelete: true,
      },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.posted).toBe(true);
    expect(r.deleted).toEqual(["9001"]);
    expect(r.stderr).toContain("withdrawing this duplicate");
    expect(r.stderr).toContain("uncommitted state");
  });

  it.skipIf(NO_TREE_KILL)(
    "the worktree cleanliness check refuses on a TIMEOUT rather than hanging",
    async () => {
      // `checkWorktreeClean()`'s `git status --porcelain` call carried no
      // deadline: a stalled filesystem or a lock held by another process could
      // hang the announcement indefinitely instead of returning the documented
      // unreadable-tree refusal. This wraps `git` with a stub that hangs ONLY on
      // `status --porcelain` — every other git call (drive-status.ts's own
      // `rev-parse HEAD`, etc.) still reaches the REAL binary, or the probe
      // would time out for the wrong reason before ever reaching the call this
      // targets.
      const dirty = makeScratchRepo("scratch-announce-git-status-hang");
      const realGit = realGitForShell();
      const gitBinDir = mkdtempSync(join(tmpdir(), "drive-pr-git-stub-"));
      const gitStubPath = join(gitBinDir, "git");
      writeFakeProgram(
        gitStubPath,
        [
          "#!/usr/bin/env bash",
          'if [ "${1:-}" = "status" ] && [ "${2:-}" = "--porcelain" ]; then',
          "  sleep 30",
          "  exit 0",
          "fi",
          `exec "${realGit}" "$@"`,
          "",
        ].join("\n"),
      );
      const started = Date.now();
      const r = await announce(
        { threads: [], reviewedSha: dirty.head, head: dirty.head },
        false,
        {
          cwd: dirty.dir,
          extraBinDir: gitBinDir,
          env: { GIT_CALL_TIMEOUT: "1" },
        },
      );
      const elapsed = Date.now() - started;
      expect(r.posted).toBe(false);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("cannot read the working tree");
      expect({
        boundedWellBeforeTheStubsSleepFinished: elapsed < 15_000,
      }).toEqual({ boundedWellBeforeTheStubsSleepFinished: true });
    },
  );

  it.skipIf(NO_TREE_KILL)(
    "the unconcluded-git-op probe itself refuses on a TIMEOUT rather than hanging",
    async () => {
      // The FIRST call `checkWorktreeClean()` makes (`unconcludedGitOpMarker`)
      // needs its own deadline, distinct from the later `git status --porcelain`
      // call the sibling probe above targets — a synchronous `existsSync()`
      // inside that helper had no deadline at all, and folding the whole check
      // into one bounded subprocess is what closed it. This stub hangs ONLY on
      // `rev-parse --git-dir` — the one call that helper's own script makes — so
      // the probe pins THIS call, not the status one.
      const dirty = makeScratchRepo("scratch-announce-git-rev-parse-hang");
      const realGit = realGitForShell();
      const gitBinDir = mkdtempSync(
        join(tmpdir(), "drive-pr-git-revparse-stub-"),
      );
      const gitStubPath = join(gitBinDir, "git");
      writeFakeProgram(
        gitStubPath,
        [
          "#!/usr/bin/env bash",
          'if [ "${1:-}" = "rev-parse" ] && [ "${2:-}" = "--git-dir" ]; then',
          "  sleep 30",
          "  exit 0",
          "fi",
          `exec "${realGit}" "$@"`,
          "",
        ].join("\n"),
      );
      const started = Date.now();
      const r = await announce(
        { threads: [], reviewedSha: dirty.head, head: dirty.head },
        false,
        {
          cwd: dirty.dir,
          extraBinDir: gitBinDir,
          env: { GIT_CALL_TIMEOUT: "1" },
        },
      );
      const elapsed = Date.now() - started;
      expect(r.posted).toBe(false);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("cannot read the working tree");
      expect({
        boundedWellBeforeTheStubsSleepFinished: elapsed < 15_000,
      }).toEqual({ boundedWellBeforeTheStubsSleepFinished: true });
    },
  );

  it("still detects an untracked leftover under status.showUntrackedFiles=no", async () => {
    // `git status --porcelain` alone inherits `status.showUntrackedFiles` from
    // repo or user config; under `=no` it reports an untracked scratch file as
    // a clean tree, silently certifying a leftover as shipped. An explicit
    // `--untracked-files=normal` overrides that config regardless of where it
    // was set.
    const dirty = makeScratchRepo("scratch-announce-showuntracked-no");
    Bun.spawnSync(["git", "config", "status.showUntrackedFiles", "no"], {
      cwd: dirty.dir,
      env: gitCleanEnv(),
    });
    writeFileSync(
      join(dirty.dir, "leftover-untracked.txt"),
      "an edit no round shipped, never git add-ed\n",
    );
    const r = await announce(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      false,
      { cwd: dirty.dir },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.posted).toBe(false);
    expect(r.stderr).toContain("uncommitted state");
    expect(r.stderr).toContain("leftover-untracked.txt");
  });

  it("still detects a dirty submodule ignored via submodule.<name>.ignore=all", async () => {
    // `git status` — even with an explicit untracked-files mode — still
    // honours `submodule.<name>.ignore`/`.gitmodules`: `ignore = all` on a
    // tracked submodule hides an uncommitted content change inside it. An
    // explicit `--ignore-submodules=none` overrides that regardless of where
    // it was set, same as `--untracked-files=normal` does for untracked
    // files.
    const src = makeScratchRepo("scratch-announce-submodule-src");
    const dirty = makeScratchRepo("scratch-announce-submodule-outer");
    Bun.spawnSync(
      [
        "git",
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        src.dir,
        "sub",
      ],
      { cwd: dirty.dir, env: gitCleanEnv() },
    );
    Bun.spawnSync(["git", "add", "-A"], { cwd: dirty.dir, env: gitCleanEnv() });
    Bun.spawnSync(["git", "commit", "-qm", "add submodule", "--no-verify"], {
      cwd: dirty.dir,
      env: gitCleanEnv(),
    });
    Bun.spawnSync(["git", "config", "submodule.sub.ignore", "all"], {
      cwd: dirty.dir,
      env: gitCleanEnv(),
    });
    writeFileSync(
      join(dirty.dir, "sub", "seed.txt"),
      "an edit no round shipped, inside the submodule\n",
    );
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: dirty.dir,
      env: gitCleanEnv(),
    })
      .stdout.toString()
      .trim();
    const r = await announce({ threads: [], reviewedSha: head, head }, false, {
      cwd: dirty.dir,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.posted).toBe(false);
    expect(r.stderr).toContain("uncommitted state");
  });

  it("refuses over an unconcluded merge even though porcelain status is empty", async () => {
    // `git checkout --ours f && git add f` resolves a conflict back to a
    // tree that matches what was already committed — `git status
    // --porcelain --untracked-files=normal --ignore-submodules=none` reports
    // NOTHING, yet `MERGE_HEAD` is still sitting in the git-dir because
    // nothing has committed the merge. The status predicate alone cannot see
    // this; the dedicated MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD check runs
    // first and catches it.
    const dirty = makeUnresolvedMergeRepo("scratch-announce-unconcluded-merge");
    const r = await announce(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      false,
      { cwd: dirty.dir },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.posted).toBe(false);
    expect(r.stderr).toContain("unconcluded git operation");
    expect(r.stderr).toContain("MERGE_HEAD");
  });

  it("refuses over a paused interactive rebase even though the tree is clean", async () => {
    // Same gap as the merge case above, one state further: an `edit`-paused
    // rebase leaves the checked-out commit's tree fully clean while
    // `rebase-merge` sits in the git-dir because the rebase itself was
    // never continued or aborted.
    const dirty = makeRebasePausedRepo("scratch-announce-rebase-paused");
    const r = await announce(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      false,
      { cwd: dirty.dir },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.posted).toBe(false);
    expect(r.stderr).toContain("unconcluded git operation");
    expect(r.stderr).toContain("rebase-merge");
  });

  it("refuses over a local commit that landed after drive-status.ts already verified HEAD", async () => {
    // The up-front check passes: local HEAD still matches the reviewed head
    // at that point. `commitAfterReads: 3` lands a REAL commit — not an
    // uncommitted edit — starting at the FIRST head-read this script's own
    // `checkLiveState()` makes (read #4: up-front liveness=1, drive-status.ts's
    // two=2,3), which is AFTER the up-front check already ran and BEFORE the
    // pre-POST re-check. The commit is fully committed, so `git status`
    // reports nothing and no unconcluded-op marker is present — only
    // comparing local HEAD against the reviewed head catches it.
    const dirty = makeScratchRepo("scratch-announce-local-head-drift");
    const r = await announce(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      false,
      { cwd: dirty.dir, commitAfterReads: 3 },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.posted).toBe(false);
    expect(r.stderr).toContain("local HEAD is");
    expect(r.stderr).toContain("but the reviewed head is");
    expect(r.stderr).toContain(dirty.head);
  });

  it("refuses over a commit that lands INSIDE checkWorktreeClean, between its own HEAD read and its later probes", async () => {
    // Narrower than the mid-run probe above: this one never leaves
    // checkWorktreeClean() at all. The FIRST thing that function does is
    // `git rev-parse HEAD`; a `git` stub answers that ONE call with the
    // reviewed head (so the up-front comparison passes) and, as a side
    // effect of answering it, commits a real change — advancing local HEAD
    // for real, before the function's own operation-marker and status
    // probes run. Every real git call after that (including the function's
    // OWN final HEAD re-check) sees the new head/state for real; nothing
    // else is stubbed.
    const dirty = makeScratchRepo("scratch-announce-intracheck-head-drift");
    const reviewedHead = dirty.head;
    const realGit = realGitForShell();
    const gitBinDir = mkdtempSync(
      join(tmpdir(), "drive-pr-intracheck-git-stub-"),
    );
    const gitStubPath = join(gitBinDir, "git");
    const markerFile = shellPath(join(gitBinDir, "answered-once"));
    writeFakeProgram(
      gitStubPath,
      [
        "#!/usr/bin/env bash",
        `if [ "\${1:-}" = "rev-parse" ] && [ "\${2:-}" = "HEAD" ] && [ ! -f "${markerFile}" ]; then`,
        `  touch "${markerFile}"`,
        `  echo "${reviewedHead}"`,
        '  echo "unreviewed, landed inside checkWorktreeClean" > unreviewed-intracheck.txt',
        `  "${realGit}" add -A >/dev/null 2>&1`,
        `  "${realGit}" commit -qm "unreviewed, landed inside checkWorktreeClean" --no-verify >/dev/null 2>&1`,
        "  exit 0",
        "fi",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
    );
    const r = await announce(
      { threads: [], reviewedSha: reviewedHead, head: reviewedHead },
      false,
      { cwd: dirty.dir, extraBinDir: gitBinDir },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.posted).toBe(false);
    expect(r.stderr).toContain("local HEAD is");
    expect(r.stderr).toContain("but the reviewed head is");
    expect(r.stderr).toContain(reviewedHead);
  });

  it("WITHDRAWS its own announcement when the post-write confirmation read is UNREADABLE", async () => {
    // An unreadable confirmation is not weaker evidence than a confirmed
    // change — it is the same absence of proof that the PR is still open on
    // the reviewed head, so it must be treated identically: withdraw and
    // refuse. The first version of this guard fell open here — a warning to
    // "verify by eye", then straight through the duplicate sweep to exit 0
    // with the comment left standing, which is the exact gap this whole
    // function exists to close, reached through the one read it could not
    // make succeed rather than one it could see change.
    //
    // `prViewUnreadableAfter: 9` (was 7): shares the head-moved probe's shift
    // above — `ci-hold.ts final-ready` now makes two reads per
    // `confirmFinalCi()` call instead of one, and two such calls
    // (`prePostFinalCiRc`, then this window) sit ahead of the POST-WRITE read
    // this test targets. Net +2, verified empirically against this suite.
    const r = await announce({ ...CONVERGED, prViewUnreadableAfter: 9 }, false);
    expect(r.exitCode).toBe(1);
    expect(r.posted).toBe(true);
    expect(r.deleted).toEqual(["9001"]);
    expect(r.stderr).toContain("cannot re-read");
    expect(r.stderr).toContain("withdrawing this announcement");
  });

  it("WITHDRAWS its own announcement when the PR stops being MERGEABLE after the post", async () => {
    // The post-write re-read used to ask for `state,headRefOid` only, and this
    // comment's claim is broader than either: a BASE branch advancing between
    // the pre-POST check and the POST flips the PR to CONFLICTING with the head
    // sitting exactly where it was. A head-only witness confirms happily, and
    // "Safe to merge" stands on a PR that no longer merges.
    // The fix is to re-run the
    // same `check_live_state` the pre-POST gate uses, so both sides of the
    // write ask one question rather than two that can drift.
    //
    // `headMovesAfter: 8` (was 6): same `final-ready` shift as the sibling
    // probes above — one extra read per `confirmFinalCi()` call, two such
    // calls ahead of this window — net +2, verified empirically against
    // this suite. Only the
    // POST-WRITE read sees CONFLICTING, and it sees it at an UNCHANGED head
    // — which is precisely what a state+head check cannot distinguish from
    // success.
    const r = await announce(
      { ...CONVERGED, mergeableMovesTo: "CONFLICTING", headMovesAfter: 8 },
      false,
    );
    expect(r.posted).toBe(true);
    expect(r.deleted).toEqual(["9001"]);
    expect(r.stderr).toContain("mergeable=CONFLICTING");
    expect(r.stderr).toContain("withdrawing this announcement");
    // 4, not 5: the PR is still OPEN and still judgeable — merging the base in
    // and re-running is the fix, so this is the retry class, not PR_NOT_OPEN.
    expect(r.exitCode).toBe(4);
  });

  it("RETRACTS an announcement an interrupted earlier run left for a stale head", async () => {
    // The post-write re-read covers this process; it cannot cover a process
    // that was killed between its POST and that re-read, or one whose DELETE
    // failed. Either leaves "Safe to merge" standing for a head the PR has
    // since moved past — and while the sweep was scoped to the LIVE head it
    // could never see that comment, because it carries a different marker. So
    // every later invocation looked straight past it, forever.
    // A REAL ancestor of the live head — the retraction predicate is now
    // "the PR has demonstrably moved past this commit", which a fabricated SHA
    // cannot satisfy and should not. Resolved in the scratch repo the spawn
    // runs in, where the live head is that repo's HEAD. gitCleanEnv: under a
    // git hook, an inherited GIT_DIR would resolve this against the real
    // repository regardless of cwd.
    const parent = (
      await Bun.$`git rev-parse HEAD~1`
        .cwd(scratchClean.dir)
        .env(gitCleanEnv())
        .text()
    ).trim();
    const r = await announce(CONVERGED, false, {
      staleAnnouncementFor: parent,
    });
    // The stale one is deleted…
    expect(r.deleted).toContain("7");
    expect(r.stderr).toContain("retracting a stale announcement");
    expect(r.stderr).toContain(parent);
    // …and this run still announces the head it actually verified. Retraction
    // of old residue must not suppress the current, legitimate announcement.
    expect(r.posted).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it("picks the lowest announcement id NUMERICALLY, across a digit-width boundary", async () => {
    // The reconciliation is "lowest id wins, everyone else withdraws its own",
    // and ids are numbers. Sorting the RENDERED `<id> <sha>` strings puts "10"
    // before "9", so at a digit-width boundary the newer comment is treated as
    // the lowest and both announcements survive — the duplicate the whole
    // reconciliation exists to settle, reached through its own tie-break.
    //
    // Ours lands at 9, the rival at 10: numerically we are lowest and must
    // KEEP ours; lexicographically the rival is "lowest" and we would withdraw.
    const r = await announce(CONVERGED, false, {
      raceAfterPost: true,
      postedIdBase: "8",
      rivalId: "10",
    });
    expect(r.posted).toBe(true);
    expect(r.deleted).toEqual([]);
    expect(r.stderr).not.toContain("withdrawing this duplicate");
  });

  it("retracts stale residue even when THIS run is nowhere near announcing", async () => {
    // The convergence and CI gates decide whether this run may announce. A
    // stale "Safe to merge" left by an interrupted earlier run is wrong
    // regardless, and gating its cleanup behind those gates left it standing
    // for the whole of the next head's review — every invocation in that
    // window exited at "not CONVERGED" or "CI is pending" before reaching the
    // retraction. That is exactly the window in which a human is most likely
    // to read the comment and act on it.
    //
    // Here the reviewer has not reviewed this head at all, so the run cannot
    // announce; it must still clear the residue on its way out. gitCleanEnv:
    // under a git hook, an inherited GIT_DIR would resolve this against the
    // real repository regardless of cwd.
    const parent = (
      await Bun.$`git rev-parse HEAD~1`
        .cwd(scratchClean.dir)
        .env(gitCleanEnv())
        .text()
    ).trim();
    const r = await announce(
      { ...CONVERGED, checkRuns: [DORMANT_ARM] },
      false,
      { staleAnnouncementFor: parent },
    );
    expect(r.posted).toBe(false);
    expect(r.exitCode).not.toBe(0);
    expect(r.deleted).toContain("7");
    expect(r.stderr).toContain("retracting a stale announcement");
  });

  // REMOVED, deliberately: a probe for "the sweep must run after the cleanup,
  // so it cannot name a comment the cleanup just deleted" used to live here.
  // After the reconciliation moved ahead of the convergence gates, its fixture
  // (`headMovesAfter: 2`) made drive-status.ts return HEAD_MOVED on its own
  // third head read, so `announce-merge-ready.ts` exited before reaching any
  // comment handling at all — and both of its assertions ("not exit 0", "did
  // not say already announced") passed on that early exit, whatever the
  // post-cleanup code did. A probe that passes for the wrong reason is worse
  // than an absent one: it reports coverage nobody has.
  //
  // The property itself is now covered by "does not report 'already announced'
  // once the PR has advanced past that head", which targets the confirmation
  // read directly, and reaching it is exactly what that probe asserts.

  it("never retracts an announcement for a head that is NOT an ancestor of the live one", async () => {
    // The interleaving the previous probe could not reach: the PR advances
    // H1→H2 AFTER this run's up-front read and another driver validly
    // announces H2, all before the retraction loop. `$live_head` still says
    // H1, so an "is this the head I read" test sees H2 as unfamiliar and
    // deletes the correct, current artefact. Nothing can read the head
    // atomically with the DELETE, so no ordering fixes that — only a predicate
    // can, and "has the PR demonstrably moved PAST this commit" is one: a
    // descendant is never an ancestor, however the timing falls.
    //
    // Modelled without any head movement at all, which is the point: the
    // announcement names a commit the live head does not descend from, and
    // that alone must protect it.
    // A real, resolvable commit object that HEAD does not descend from: a
    // parentless commit over HEAD's own tree. `announce-merge-ready.ts` runs
    // drive-status.ts without --no-head-sync, so the fixture head has to stay
    // the local HEAD of the tree it runs in — the unrelated commit has to be
    // the ANNOUNCED one, and it has to be minted in that same scratch repo or
    // the ancestry check cannot resolve it at all. Committer identity is
    // passed explicitly; a bare `commit-tree` fails on a machine with no
    // configured user, which is every CI runner.
    const unrelated = (
      await Bun.$`git commit-tree HEAD^{tree} -m drive-pr-probe`
        .cwd(scratchClean.dir)
        .env({
          ...gitCleanEnv(),
          GIT_AUTHOR_NAME: "drive-pr probe",
          GIT_AUTHOR_EMAIL: "probe@example.invalid",
          GIT_COMMITTER_NAME: "drive-pr probe",
          GIT_COMMITTER_EMAIL: "probe@example.invalid",
        })
        .text()
    ).trim();
    const r = await announce(CONVERGED, false, {
      staleAnnouncementFor: unrelated,
    });
    expect(r.deleted).toEqual([]);
    expect(r.stderr).toContain("is not an ancestor");
    expect(r.stderr).not.toContain("retracting a stale announcement");
  });

  it('does not report "already announced" once the PR has advanced past that head', async () => {
    // The up-front liveness read happens before the retraction and before the
    // sweep, so the PR can advance H1→H2 in between — and this branch then
    // reported the job done on the strength of an H1 announcement, leaving it
    // standing for a head nobody reviewed while nothing existed for H2. Every
    // other exit-0 here is gated on a read taken immediately before it; this
    // one has to be too, or "already announced" is the one success available
    // by being slow.
    //
    // `headMovesAfter: 5` lets this script's up-front read, drive-status.ts's
    // two, the final-CI certificate, and this script's own idempotence-path
    // `check_live_state` recheck
    // all answer truthfully — a `3` would let that recheck see the move
    // instead and refuse there, never reaching the confirmation read this
    // probe targets; the confirmation read inside the branch is the first to
    // see the move.
    //
    // The idempotence-path confirmation is `checkLiveState()` itself now, not a
    // bespoke re-derivation of the same question (the same shape as the
    // CONFLICTING/draft withdrawal path sharing one predicate), so the wording
    // is that function's own "advanced from ... to ..." message rather than a
    // branch-local "does not speak for the live head" — the guarantee under
    // test (refuses, does not post, does not fall through to "already
    // announced") is unchanged.
    const r = await announce(
      { ...CONVERGED, headMovesTo: PREV, headMovesAfter: 5 },
      false,
      { staleAnnouncementFor: CONVERGED.head },
    );
    expect(r.posted).toBe(false);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("advanced from");
    expect(r.stderr).not.toContain("already announced for");
  });

  it("--dry-run deletes NOTHING, even a stale announcement it would otherwise retract", async () => {
    // The cleanup issues real DELETEs, and it runs before the dry-run exit.
    // `--dry-run` promises to show what would be announced and mutate nothing;
    // quietly retracting on the way is the flag's contract broken by the one
    // path a caller uses precisely because they are not ready to mutate.
    const { dir, stateDir } = writeFixture(CONVERGED);
    writeVerifiedSha(stateDir, CONVERGED.head ?? HEAD);
    writeFileSync(join(dir, "stale-announcement"), PREV);
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "announce-merge-ready.ts"), "999", "--dry-run"),
      {
        cwd: scratchClean.dir,
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_ANNOUNCE_OPENER_FIXTURE: OPENER,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    // It still shows what it would post…
    expect(stdout).toContain(OPENER);
    // …and it deleted nothing and posted nothing.
    expect(existsSync(join(dir, "deleted.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "posted.jsonl"))).toBe(false);
  });

  it("a merge AFTER the POST exits 5, not the retry class", async () => {
    // A merge usually leaves the head untouched, so folding it into the
    // moved-head branch exited 4 — the retry/head-moved class — for a PR that
    // will never be judgeable again, inviting a caller to wait for a new head
    // that is not coming. The pre-POST guard answers this case with 5; the
    // post-write guard has to agree, or the same condition means two different
    // things depending only on which side of the write it was noticed.
    //
    // `stateChangesAfter: 9` (was 7): same `final-ready` shift as the sibling
    // probes above — `ci-hold.ts final-ready` now makes two reads per
    // `confirmFinalCi()` call instead of one, and two such calls sit ahead of
    // the POST-WRITE read this test targets. Net +2, verified empirically
    // against this suite.
    const r = await announce(
      { ...CONVERGED, stateChangesTo: "MERGED", stateChangesAfter: 9 },
      false,
    );
    expect(r.exitCode).toBe(5);
    expect(r.posted).toBe(true);
    expect(r.deleted).toEqual(["9001"]);
  });

  it("refuses to announce on a PR that is no longer OPEN", async () => {
    // A merge moves no ref, so the head comparison passes and a head-only
    // pre-post read cannot see it. "Safe to merge" is a statement about a
    // decision that has already been taken.
    //
    // `stateChangesAfter: 5` also lets the final-CI certificate's own two reads
    // (the entry snapshot and its last-moment re-check) answer OPEN, pinning
    // THIS script's own `check_live_state` guard rather than one of those. Both
    // of this script's `check_live_state` calls report the identical wording,
    // so it does not matter which of the two catches it here.
    const r = await announce(
      { ...CONVERGED, stateChangesTo: "MERGED", stateChangesAfter: 5 },
      false,
    );
    expect(r.exitCode).toBe(5);
    expect(r.posted).toBe(false);
    expect(r.stderr).toContain("is MERGED — refusing to act on a finished PR");
  });

  // The pre-post sweep is check-then-act and GitHub has no create-if-absent for
  // a comment, so two drivers on one PR can both pass it and both announce.
  // Ids are monotonic, so "lowest id wins, everyone else withdraws its OWN
  // comment" converges whichever way the two interleave.
  it("WITHDRAWS its own announcement when a rival posted first", async () => {
    const r = await announce(CONVERGED, false, {
      raceAfterPost: true,
      postedIdBase: "9000", // ours lands at 9001, above the rival's id 1
    });
    expect(r.exitCode).toBe(0);
    expect(r.posted).toBe(true);
    expect(r.deleted).toEqual(["9001"]);
    expect(r.stderr).toContain("withdrawing this duplicate");
  });

  it("KEEPS its own announcement when it is the lowest id", async () => {
    // The other half: reconciliation must not delete the survivor. Ours lands
    // at id 1 here — the same id the rival carries — so the comparison sees no
    // strictly-lower announcement and leaves it alone.
    const r = await announce(CONVERGED, false, {
      raceAfterPost: true,
      postedIdBase: "0", // ours lands at 1, the rival's own id
    });
    expect(r.exitCode).toBe(0);
    expect(r.posted).toBe(true);
    expect(r.deleted).toEqual([]);
    expect(r.stderr).not.toContain("withdrawing");
  });

  it("ignores a comment that merely QUOTES the head marker", async () => {
    // The marker is predictable and a PR comment is world-writable, so
    // "contains the marker" is not evidence of an announcement. A collaborator
    // quoting it while discussing this script would otherwise be read as the
    // existing announcement — suppressing a real one — and, carrying a lower
    // id, would win the race reconciliation and make this script delete its own
    // genuine announcement. Only announcement SHAPE counts: opens with the
    // announcement's first line, ends with this head's marker.
    //
    // The quoter here has id 0, BELOW both the rival (1) and ours (1): if it
    // counted, `lowest` would be 0 and the withdrawal would fire.
    const r = await announce(CONVERGED, false, {
      raceAfterPost: true,
      quoter: true,
      postedIdBase: "0", // ours lands at 1
    });
    expect(r.exitCode).toBe(0);
    expect(r.posted).toBe(true);
    expect(r.deleted).toEqual([]);
    expect(r.stderr).not.toContain("withdrawing");
  });

  it("a CONFLICTING PR is refused BEFORE the idempotence sweep", async () => {
    // Review argued the "already announced for $head" short-circuit returns
    // ahead of the last-moment mergeability read, so a base that advanced
    // after an announcement was posted would leave a stale "safe to merge"
    // standing on an unchanged, now-conflicting head.
    //
    // It cannot: the idempotence sweep is downstream of the CONVERGED gate,
    // and drive-status.ts reports PR_CONFLICTING (exit 9) rather than
    // CONVERGED on any conflicting head — the conflict branch is checked
    // before the convergence one. So the script never reaches the sweep at
    // all. This pins that ordering; without it the refusal would come from
    // somewhere further down, or not at all.
    const r = await announce({ ...CONVERGED, mergeable: "CONFLICTING" }, false);
    expect(r.exitCode).toBe(1);
    expect(r.posted).toBe(false);
    expect(r.stderr).toContain("PR_CONFLICTING");
    expect(r.stderr).toContain("not CONVERGED");
    // The sweep never ran, which is the ordering claim itself.
    expect(r.stderr).not.toContain("already announced");
  });

  it("ignores a perfectly-shaped announcement from an UNTRUSTED author", async () => {
    // Shape is a body predicate, and both of its strings are public and fixed,
    // so any commenter can reproduce an exact announcement — deliberately, not
    // by accident. `author_association` is computed server-side from repository
    // permissions and cannot be set by comment content, which is the half shape
    // cannot supply.
    //
    // The forger has id 0, BELOW both the rival (1) and ours (1): counted, it
    // would become `lowest` and make this script delete its own genuine
    // announcement. On the pre-post sweep it would instead report "already
    // announced" and suppress a real one.
    const r = await announce(CONVERGED, false, {
      raceAfterPost: true,
      forger: true,
      postedIdBase: "0", // ours lands at 1
    });
    expect(r.exitCode).toBe(0);
    expect(r.posted).toBe(true);
    expect(r.deleted).toEqual([]);
    expect(r.stderr).not.toContain("withdrawing");
  });
});

describe("summary-findings marker overrides", () => {
  it("reads the SAME sticky and reviewed-SHA markers drive-status.ts is configured with", async () => {
    // The markers are read at module load, so this has to be a subprocess.
    // Hard-coding the defaults here means a configured DRIVE_PR_STICKY_MARKER
    // sends drive-status.ts to a custom sticky while this parser finds no
    // sticky at all — and "no sticky" reads as zero summary findings, so a
    // custom-marker repo converges over every unanchored finding ever posted.
    const src = join(SCRIPTS, "summary-findings.ts");
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `const m = await import(${JSON.stringify(src)});
         console.log(JSON.stringify({
           sticky: m.STICKY_MARKER,
           sha: m.SHA_MARKER,
           parsed: m.reviewedShaFrom('<!-- custom-sha: abc1234 -->'),
         }));`,
      ],
      {
        env: {
          ...process.env,
          DRIVE_PR_STICKY_MARKER: "<!-- other-review -->",
          DRIVE_PR_SHA_MARKER: "custom-sha",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    const got = JSON.parse(out);
    expect(got.sticky).toBe("<!-- other-review -->");
    expect(got.sha).toBe("custom-sha");
    // And the reviewed SHA is actually extracted under the custom name — it
    // scopes the unaccounted-slot keys, so failing to read it degrades every
    // slot to the shared `nohead` scope, where an answer given on one head
    // marks a different finding addressed on the next.
    expect(got.parsed).toBe("abc1234");
  });
});

/**
 * A `gh` that answers pull request #999's base (`develop`) and the repository
 * (`acme/widgets`) a scratch clone's `origin` must fetch, and hands every
 * other call to the harness's own `gh`. A round's base is the pull request's,
 * so a scratch clone without either refuses to plan.
 */
function prBaseGh(): string {
  const dir = mkdtempSync(join(tmpRoot, "pr-base-gh-"));
  writeFakeProgram(
    join(dir, "gh"),
    `#!/bin/sh
case "$*" in
  "pr view 999 --json baseRefName -q .baseRefName") echo develop ;;
  "pr view 999 --json baseRefName,url") echo '{"baseRefName":"develop","url":"https://github.com/acme/widgets/pull/999"}' ;;
  "repo view --json owner,name") echo '{"owner":{"login":"acme"},"name":"widgets"}' ;;
  *) exec "${binDir}/gh" "$@" ;;
esac
`,
  );
  return dir;
}

/** Point a scratch clone's `origin` at the repository `prBaseGh` answers. */
function addOrigin(repo: string): void {
  Bun.spawnSync(
    ["git", "remote", "add", "origin", "https://github.com/acme/widgets.git"],
    { cwd: repo, env: gitCleanEnv(), stdout: "ignore", stderr: "ignore" },
  );
}

describe("round-delta.ts", () => {
  // The helpers under test run git in this process. Inherited routing
  // variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE from a hook or a parent
  // git process) override `-C dir` and would point them at the real checkout,
  // so each call runs with those variables dropped and the environment
  // restored afterwards.
  async function inScrubbedEnv<T>(
    extra: Record<string, string>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const saved = { ...process.env };
    try {
      for (const k of Object.keys(process.env))
        if (k.startsWith("GIT_") || k.startsWith("DRIVE_PR_"))
          delete process.env[k];
      Object.assign(process.env, extra);
      return await fn();
    } finally {
      for (const k of Object.keys(process.env))
        if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  }

  // Git quotes a pathname containing a literal `"` or `\` regardless of
  // `core.quotePath` — that setting only
  // controls the SEPARATE non-ASCII-escaping behavior. A `\n`-split of
  // quoted `--name-only`/`ls-files` output would keep the surrounding quotes
  // (and backslash-escape any embedded `"`), which then never matches
  // `finish-round.ts`'s `touched.has(t.path)` comparison against GitHub's
  // own unescaped path — silently failing the untriaged-thread guard OPEN
  // for exactly the files whose names make this matter. `-z` NUL-delimits
  // every entry with no quoting at all, so this reproduces the reviewer's own
  // repro script directly against the real functions.
  it.skipIf(NO_QUOTE_NAMES)(
    "changedFilesSinceExcludingMerges resolves a filename containing a literal double-quote unescaped",
    async () => {
      const dir = mkdtempSync(join(tmpRoot, "round-delta-quote-"));
      const env = gitCleanEnv();
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", ...args], {
          cwd: dir,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
      git("init", "-q", "-b", "main");
      git("config", "user.email", "probe@example.invalid");
      git("config", "user.name", "drive-pr probe");
      git("config", "commit.gpgsign", "false");
      git("config", "core.autocrlf", "false");
      git("config", "core.hooksPath", "/dev/null");
      writeFileSync(join(dir, "seed.ts"), "seed\n");
      git("add", "-A");
      git("commit", "-qm", "seed", "--no-verify");
      const since = git("rev-parse", "HEAD").stdout.toString().trim();
      // `changedFilesSinceExcludingMerges` excludes everything reachable from
      // `origin/develop` — give it one, pointed at the same seed commit, so
      // the quoted-path commit below is the only thing "this round" touched.
      git("update-ref", "refs/remotes/origin/develop", since);
      const quotedName = 'a"b.ts';
      writeFileSync(join(dir, quotedName), "quoted\n");
      git("add", "-A");
      git("commit", "-qm", "quoted path", "--no-verify");

      addOrigin(dir);
      const result = await inScrubbedEnv(
        { PATH: `${prBaseGh()}${delimiter}${process.env.PATH}` },
        () => changedFilesSinceExcludingMerges(dir, "999", since, 30),
      );
      expect(result).not.toBeNull();
      expect(result).toContain(quotedName);
    },
  );

  it.skipIf(NO_QUOTE_NAMES)(
    "changedFilesSince resolves a filename containing a literal double-quote unescaped",
    async () => {
      const dir = mkdtempSync(join(tmpRoot, "round-delta-quote-diff-"));
      const env = gitCleanEnv();
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", ...args], {
          cwd: dir,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
      git("init", "-q", "-b", "main");
      git("config", "user.email", "probe@example.invalid");
      git("config", "user.name", "drive-pr probe");
      git("config", "commit.gpgsign", "false");
      git("config", "core.autocrlf", "false");
      git("config", "core.hooksPath", "/dev/null");
      writeFileSync(join(dir, "seed.ts"), "seed\n");
      git("add", "-A");
      git("commit", "-qm", "seed", "--no-verify");
      const since = git("rev-parse", "HEAD").stdout.toString().trim();
      const quotedName = 'a"b.ts';
      writeFileSync(join(dir, quotedName), "quoted\n");
      git("add", "-A");
      git("commit", "-qm", "quoted path", "--no-verify");

      const result = await inScrubbedEnv({}, () =>
        changedFilesSince(dir, since, 30),
      );
      expect(result).not.toBeNull();
      expect(result).toContain(quotedName);
    },
  );
});

describe("round-plan.ts", () => {
  async function roundPlan(args: string[], stateDir: string, repo: string) {
    addOrigin(repo);
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "round-plan.ts"), "999", ...args),
      {
        cwd: repo,
        env: {
          ...gitCleanEnv(),
          PATH: `${prBaseGh()}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_STATE_DIR: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  it("defaults to the CUMULATIVE plan even with a verified SHA recorded", async () => {
    // drive-pr `SKILL.md` § 5's validation plan requires re-resolving the
    // complete change after each review fix, not once per PR. A delta plan
    // derived from round N's own diff cannot contain the check that catches an
    // interaction with a file round 1 changed — and the cumulative tree is what
    // gets pushed. So the presence of a verified SHA must not silently narrow
    // the plan; only an explicit --delta may.
    const stateDir = mkdtempSync(join(tmpRoot, "rp-"));
    const { dir: repo, head } = makeScratchRepo("rp-cumulative");
    const base = Bun.spawnSync(
      ["git", "update-ref", "refs/remotes/origin/develop", "HEAD~1"],
      { cwd: repo, env: gitCleanEnv(), stdout: "pipe", stderr: "pipe" },
    );
    if (base.exitCode !== 0) throw new Error(base.stderr.toString());
    // Keep the resolver deterministic and independent of the live checkout's
    // pending merge, catalog, and uncommitted files.
    mkdirSync(join(repo, "tools", "change-areas"), { recursive: true });
    writeFileSync(
      join(repo, "tools", "change-areas", "resolve.ts"),
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({
          seedAreas: [],
          validation: {
            localChecks: [],
            verificationChecks: [],
            testbox: { required: false },
          },
          reviewSkills: [],
        }),
      )});`,
    );
    writeVerifiedSha(stateDir, head);

    const dflt = await roundPlan([], stateDir, repo);
    if (dflt.exitCode !== 0) throw new Error(dflt.stderr);
    expect(dflt.stdout).toContain("round-plan (cumulative");

    const delta = await roundPlan(["--delta"], stateDir, repo);
    if (delta.exitCode !== 0) throw new Error(delta.stderr);
    expect(delta.stdout).toContain("round-plan (delta");
    // And an opt-in delta says what it traded away, so the choice is visible in
    // the round's own transcript rather than only in this file. Asserted here
    // because the delta base is HEAD, so the file list is empty on a clean
    // checkout and non-empty on a dirty one — and the caveat must survive BOTH.
    // An empty delta is where it matters most: "nothing to validate this round"
    // is the most convincing possible way to read a scoping choice as an
    // all-clear. (This is why the assertion failed only in CI first time round.)
    expect(delta.stdout).toContain("DELTA plan");
  });

  // ── Testbox decay ──────────────────────────────────────────────
  //
  // The scenario these pin is one measured on a live drive: a cumulative plan
  // holding `testbox.required: true` on the strength of round-1 `profile: full`
  // files, while the pre-push hook skipped the mandatory heavy phase on the
  // very same commit because its own (push-range) scope saw nothing
  // full-profile. Both were right; an operator following both got opposite
  // instructions. The plan now answers once and prints the divergence.
  //
  // Every probe runs against a DEDICATED SCRATCH REPOSITORY with a stubbed
  // resolver, never against this checkout. An earlier design fabricated the
  // base in the real repo with `git commit-tree -p HEAD` over a throwaway
  // index, and it was wrong twice over. It hashed the developer's whole
  // worktree into the repository's object store (in a Conductor worktree, the
  // main clone's) on every commit, since lefthook runs this suite on all of
  // them. And the base it built was a DESCENDANT of HEAD — a state the driver
  // cannot produce, because `set-verified` records HEAD itself, so a recorded
  // SHA is always HEAD or an ancestor. Those probes only passed because
  // `cat-file -e` asks whether an object exists rather than whether it is
  // behind HEAD; the ancestry guard they now pin is exactly that distinction,
  // and it is what exposed the fabrication as impossible.
  //
  // A scratch repo makes the history explicit instead: C0 (also the stand-in
  // `origin/develop`) and C1, so "verified is an ancestor" and "verified is
  // HEAD" are both reachable honestly, and the outcome does not depend on what
  // the developer happens to have modified.
  describe("Testbox decay against the last green-verified SHA", () => {
    let repo: string;
    /** C0 — the merge-base, doubling as `origin/develop`. */
    let c0: string;
    /** C1 — HEAD, adding one file on top of C0. */
    let c1: string;

    const ADDED_REL = "tools/change-areas/probe-added.txt";

    // An explicit identity, not the ambient one: `git commit` and
    // `git commit-tree` write real commit objects and refuse without a
    // committer. A CI runner has no `user.email` configured and cannot
    // auto-detect one from `runner@ip-…(none)`, so probes relying on the
    // ambient identity failed there (measured on the Testbox) while passing on
    // any developer machine. Passed as env, never `git config`.
    const IDENTITY = {
      GIT_AUTHOR_NAME: "drive-pr probe",
      GIT_AUTHOR_EMAIL: "probe@example.invalid",
      GIT_COMMITTER_NAME: "drive-pr probe",
      GIT_COMMITTER_EMAIL: "probe@example.invalid",
    };

    const git = (args: string[], env: Record<string, string> = {}) => {
      const out = Bun.spawnSync(["git", ...args], {
        cwd: repo,
        // gitCleanEnv() strips every GIT_* pointer (see its doc comment), so a
        // git hook's exported GIT_DIR cannot redirect these at the real
        // repository — which is also why `cwd` alone is not enough.
        env: { ...gitCleanEnv(), ...IDENTITY, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      if (out.exitCode !== 0) {
        throw new Error(
          `git ${args.join(" ")} failed: ${out.stderr.toString()}`,
        );
      }
      return out.stdout.toString().trim();
    };

    beforeAll(() => {
      repo = mkdtempSync(join(tmpRoot, "rp-repo-"));
      git(["init", "-q", "-b", "main"]);
      git(["config", "commit.gpgsign", "false"]);
      git(["config", "core.autocrlf", "false"]);
      git(["config", "core.hooksPath", "/dev/null"]);
      writeFileSync(join(repo, "seed.txt"), "seed\n");
      git(["add", "-A"]);
      git(["commit", "-qm", "C0", "--no-verify"]);
      c0 = git(["rev-parse", "HEAD"]);
      // round-plan.ts resolves its cumulative base as
      // `git merge-base origin/develop HEAD`, so the scratch repo needs that
      // ref to exist. A plain ref update is enough — no remote is contacted.
      git(["update-ref", "refs/remotes/origin/develop", c0]);
      addOrigin(repo);

      mkdirSync(join(repo, "tools", "change-areas"), { recursive: true });
      writeFileSync(join(repo, ADDED_REL), "added in C1\n");
      git(["add", "-A"]);
      git(["commit", "-qm", "C1", "--no-verify"]);
      c1 = git(["rev-parse", "HEAD"]);
      // The stubbed resolver below is written INTO this repo, at the path
      // round-plan.ts spawns. Left visible to git it would be an untracked
      // file in the very diff round-plan resolves — making every "nothing has
      // changed since the verified SHA" probe see a change, and decay probes
      // fail for a reason that has nothing to do with decay. `info/exclude` is
      // the repo-local ignore that `--exclude-standard` honours and that no
      // committed `.gitignore` has to carry.
      writeFileSync(
        join(repo, ".git", "info", "exclude"),
        "tools/change-areas/resolve.ts\n",
      );
    });

    /**
     * A stand-in for `tools/change-areas/resolve.ts`, written INTO the scratch
     * repo at the path round-plan.ts resolves. The first call answers as the
     * real resolver would for a `profile: full` plan; the second — the delta
     * read — answers `delta`.
     *
     * Stubbing the resolver is what lets these probes assert a fixed outcome:
     * the real one would answer from `catalog.yaml`, so every probe would
     * depend on which paths happen to be `profile: full` today. The counter
     * lives in a file because each call is a separate process.
     *
     * It stubs the SCRIPT, not the interpreter. The earlier version shimmed a
     * `bun` on PATH and keyed on argv[1] — which silently stopped intercepting
     * anything the moment round-plan.ts started spawning the resolver under
     * `tsArgv` (process.execPath + an absolute path) instead of a hardcoded
     * `bun`, i.e. the moment the cross-platform fix these probes should have
     * been indifferent to landed. Stubbing the file keeps the probes about the
     * decay logic rather than about how the resolver happens to be launched.
     */
    const resolverShim = (delta?: { body?: string; exit?: number }) => {
      const dir = mkdtempSync(join(tmpRoot, "rp-shim-"));
      const second =
        delta === undefined
          ? `console.error('unexpected second resolve'); process.exit(1);`
          : delta.exit
            ? `console.error('resolver exploded'); process.exit(1);`
            : `process.stdout.write(${JSON.stringify(`${delta.body}\n`)}); process.exit(0);`;
      const plan = JSON.stringify(
        `{"seedAreas":["catalog-self"],"validation":{"localChecks":["pnpm check-types"],"verificationChecks":[],"testbox":{"required":true,"command":"echo box","reason":"area-opt-in","requiredBy":[{"area":"catalog-self","files":["${ADDED_REL}"]}]}},"reviewSkills":[]}\n`,
      );
      mkdirSync(join(repo, "tools", "change-areas"), { recursive: true });
      writeFileSync(
        join(repo, "tools", "change-areas", "resolve.ts"),
        `import { readFileSync, writeFileSync } from 'node:fs';
const countFile = ${JSON.stringify(join(dir, "count"))};
let n = 0;
try {
  n = Number.parseInt(readFileSync(countFile, 'utf8').trim(), 10) || 0;
} catch {}
writeFileSync(countFile, String(n + 1));
if (n === 0) {
  process.stdout.write(${plan});
  process.exit(0);
}
${second}
`,
      );
      return dir;
    };

    /** A delta plan the resolver would emit for a file in a Testbox-opted-in area. */
    const DELTA_FULL =
      '{"seedAreas":["catalog-self"],"validation":{"localChecks":[],"verificationChecks":[],"testbox":{"required":true,"command":"echo box","reason":"area-opt-in","requiredBy":[]}},"reviewSkills":[]}';

    const planIn = async (
      stateDir: string,
      shimDir: string,
      args: string[] = ["--json"],
    ) => {
      const proc = Bun.spawn(
        scriptArgv(join(SCRIPTS, "round-plan.ts"), "999", ...args),
        {
          cwd: repo,
          env: {
            ...gitCleanEnv(),
            ...IDENTITY,
            PATH: `${shimDir}${delimiter}${prBaseGh()}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_STATE_DIR: stateDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    };

    const setVerified = async (stateDir: string, sha: string) => {
      writeVerifiedSha(stateDir, sha);
    };

    it("fails closed with no verified SHA — and says WHICH files hold the requirement", async () => {
      const stateDir = mkdtempSync(join(tmpRoot, "rp-noverified-"));
      const { stdout } = await planIn(stateDir, resolverShim());
      const plan = JSON.parse(stdout);

      expect(plan.testboxDecision.planRequired).toBe(true);
      expect(plan.testboxDecision.required).toBe(true);
      expect(plan.testboxDecision.decayed).toBe(false);
      // Never evaluated — there is no base to evaluate it against.
      expect(plan.testboxDecision.incrementalRequired).toBe(null);
      expect(plan.testboxDecision.verifiedSha).toBe(null);
      expect(plan.testboxDecision.note).toContain("fail-closed");
      // The floor this issue asked for: when the box IS required, the plan
      // names the evidence. The rule's name alone (`reason`) was true and
      // useless on twelve consecutive rounds of one measured drive.
      expect(
        plan.testboxDecision.requiredBy.flatMap(
          (entry: { files: string[] }) => entry.files,
        ),
      ).toContain(ADDED_REL);
    });

    it("fails closed when the recorded verified SHA is not a commit in this clone", async () => {
      const stateDir = mkdtempSync(join(tmpRoot, "rp-badsha-"));
      const bogus = "f".repeat(40);
      await setVerified(stateDir, bogus);

      const { stdout } = await planIn(stateDir, resolverShim());
      const plan = JSON.parse(stdout);

      expect(plan.testboxDecision.required).toBe(true);
      expect(plan.testboxDecision.decayed).toBe(false);
      expect(plan.testboxDecision.incrementalRequired).toBe(null);
      // Cleared, not echoed: nothing downstream should read a SHA this clone
      // cannot resolve as if it were a real verification point.
      expect(plan.testboxDecision.verifiedSha).toBe(null);
      expect(plan.testboxDecision.note).toContain(bogus.slice(0, 12));
    });

    // A corrupted state file can carry a SYMBOLIC ref (e.g. `HEAD`) instead of
    // a 40-character SHA and still pass `isUsableState`'s bare `typeof ===
    // 'string'` check —
    // `set-verified`'s own CLI validation refuses this shape outright, so the
    // corruption is modeled the same way the TRIAGE_CHECK_FAILED fixture
    // does: seed a well-formed state via the CLI, then hand-edit the one
    // field. Both `cat-file -e HEAD^{commit}` and `merge-base --is-ancestor
    // HEAD HEAD` resolve successfully — `HEAD` moves WITH the tree being
    // validated against it — so a missing format check here would silently
    // accept a base that answers "nothing changed" no matter what this
    // round's commits actually touched.
    it("fails closed when the recorded verified SHA is a symbolic ref, not a SHA", async () => {
      const stateDir = mkdtempSync(join(tmpRoot, "rp-symbolicref-"));
      await setVerified(stateDir, "f".repeat(40));
      const statePath = join(stateDir, "drive-pr-999.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.verifiedSha = "HEAD";
      writeFileSync(statePath, JSON.stringify(state));

      const { stdout } = await planIn(stateDir, resolverShim());
      const plan = JSON.parse(stdout);

      expect(plan.testboxDecision.required).toBe(true);
      expect(plan.testboxDecision.decayed).toBe(false);
      expect(plan.testboxDecision.incrementalRequired).toBe(null);
      expect(plan.testboxDecision.verifiedSha).toBe(null);
      expect(plan.testboxDecision.note).toContain(
        "not a 40-character commit SHA",
      );
    });

    // Existing is not ancestral. `cat-file -e` answers "is this object here",
    // which a rebased or force-pushed SHA still satisfies while sitting on a
    // history HEAD is not on — and the delta is then taken against an unrelated
    // tree, whose answer says nothing about this one.
    it("refuses to decay against a verified SHA that is not an ancestor of HEAD", async () => {
      const stateDir = mkdtempSync(join(tmpRoot, "rp-offbranch-"));
      // A parentless commit carrying HEAD's own tree: a real, resolvable
      // object on a history of its own — the shape a force-pushed base leaves
      // behind. Its tree matches HEAD exactly, so a missing ancestry check
      // would compute an empty delta and decay.
      const orphan = git([
        "commit-tree",
        `${c1}^{tree}`,
        "-m",
        "off-branch probe",
      ]);
      await setVerified(stateDir, orphan);

      const { stdout } = await planIn(stateDir, resolverShim());
      const plan = JSON.parse(stdout);

      expect(plan.testboxDecision.decayed).toBe(false);
      expect(plan.testboxDecision.required).toBe(true);
      expect(plan.testboxDecision.incrementalRequired).toBe(null);
      expect(plan.testboxDecision.verifiedSha).toBe(null);
      expect(plan.testboxDecision.note).toContain("not an ancestor of HEAD");
      expect(plan.testboxDecision.note).toContain("fail-closed");
    });

    it("decays a cumulative requirement held up only by files unchanged since the verified SHA", async () => {
      const stateDir = mkdtempSync(join(tmpRoot, "rp-decay-"));
      // HEAD itself — what `set-verified` records at the end of a round. The
      // cumulative diff C0..C1 still contains the `profile: full` file, so the
      // plan asks for a box; nothing has changed since C1, so the delta is
      // empty and the requirement is stale rather than owed.
      await setVerified(stateDir, c1);

      const { stdout } = await planIn(stateDir, resolverShim());
      const plan = JSON.parse(stdout);

      // The cumulative plan still says yes — that answer is not wrong, just
      // stale.
      expect(plan.testboxDecision.planRequired).toBe(true);
      // Nothing has changed since a tree whose gates passed green, so the box
      // would re-run a suite that already passed on exactly this content.
      expect(plan.testboxDecision.incrementalRequired).toBe(false);
      expect(plan.testboxDecision.decayed).toBe(true);
      expect(plan.testboxDecision.required).toBe(false);
      expect(plan.testboxDecision.verifiedSha).toBe(c1);
      // `validation` stays exactly as the resolver emitted it, so the payload
      // carries two answers. It must say IN THE PAYLOAD which one to act on —
      // a consumer reading `validation.testbox.required` would still warm a box.
      expect(plan.testboxDecision.note).toContain(
        "act on testboxDecision.required",
      );
      // The cheap cumulative checks are NOT decayed with it — the whole point
      // of the split is that "is the tree valid" and "does this round warrant a
      // box" are different questions with different scopes.
      expect(plan.validation.localChecks).toContain("pnpm check-types");
      expect(plan.validation.testbox.required).toBe(true);

      // …and the human-readable form states the divergence rather than leaving
      // it to be discovered, naming both the stale files and the base.
      const text = await planIn(stateDir, resolverShim(), []);
      expect(text.stdout).toContain("Testbox: NOT required this round");
      expect(text.stdout).toContain(ADDED_REL);
      expect(text.stdout).toContain(c1.slice(0, 12));
      expect(text.stdout).toContain("pre-push hook");
    });

    it("does NOT decay when a full-profile file changed since the verified SHA", async () => {
      const stateDir = mkdtempSync(join(tmpRoot, "rp-nodecay-"));
      // C0 — a genuine ancestor, and one that predates the `profile: full`
      // file, so it is in the delta as well as the cumulative diff and the
      // requirement is live rather than stale.
      await setVerified(stateDir, c0);

      const { stdout } = await planIn(
        stateDir,
        resolverShim({ body: DELTA_FULL }),
      );
      const plan = JSON.parse(stdout);

      expect(plan.testboxDecision.planRequired).toBe(true);
      expect(plan.testboxDecision.incrementalRequired).toBe(true);
      expect(plan.testboxDecision.decayed).toBe(false);
      expect(plan.testboxDecision.required).toBe(true);
    });

    it.skipIf(
      skipsOnWindows(
        "git-bash",
        "the configured command runs through cmd.exe, which reports a missing program as a shell that could not be started, not as a failed command",
      ),
    )(
      "names the configured plan command when its program is missing",
      async () => {
        // The plan command runs through the shell, which reports a missing
        // program as exit 127; the message names the configuration field the
        // operator has to look at. The stub resolver is written but
        // unreachable — a PATH with no `bun` on it is the whole probe.
        const stateDir = mkdtempSync(join(tmpRoot, "rp-nobun-"));
        const dir = resolverShim({ body: DELTA_FULL });
        // Launched by ABSOLUTE runtime path, not through the `#!/usr/bin/env bun`
        // shebang: the shebang needs bun on PATH too, so it would fail at 127
        // before round-plan.ts ran a line, and the probe would pass for the wrong
        // reason. The script runs; only the resolver's `bun` is missing.
        const proc = Bun.spawn(
          [process.execPath, join(SCRIPTS, "round-plan.ts"), "999", "--json"],
          {
            cwd: repo,
            env: {
              ...gitCleanEnv(),
              ...IDENTITY,
              // `binDir` carries the gh/git stubs this harness needs; what it does
              // NOT carry is bun. The system directories supply the shell (and, on
              // Windows, the real git and sh, which live apart from any bun).
              PATH: [
                dir,
                prBaseGh(),
                binDir,
                // Windows keeps git and sh in Git for Windows' own directories.
                ...byPlatform("Windows keeps git and sh apart", {
                  windows: [Bun.which("git"), Bun.which("sh")].map((p) =>
                    dirname(p as string),
                  ),
                  posix: ["/usr/bin", "/bin"],
                }),
              ].join(delimiter),
              DRIVE_PR_STATE_DIR: stateDir,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("drive.validation_plan_command failed");
      },
    );

    // The decay argument is built entirely on `validation.testbox.required`, so
    // the read has to be as fail-closed as the argument claims to be. A bare
    // `jq -r` on a field the resolver stopped emitting exits 0 with the text
    // `null` — neither `true` nor `false` — and the requirement evaporates
    // silently. That is the one failure mode this block must never have.
    it('STOPS rather than reading a non-boolean testbox.required as "no box needed"', async () => {
      const stateDir = mkdtempSync(join(tmpRoot, "rp-badcontract-"));
      const dir = mkdtempSync(join(tmpRoot, "rp-shim-bad-"));
      writeFileSync(
        join(repo, "tools", "change-areas", "resolve.ts"),
        `process.stdout.write(
  '{"seedAreas":[],"validation":{"localChecks":[],"verificationChecks":[],"testbox":{}},"reviewSkills":[]}\\n',
);
process.exit(0);
`,
      );

      const { stdout, stderr, exitCode } = await planIn(stateDir, dir);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("boolean validation.testbox.required");
      // And emphatically NOT a plan that a caller could act on: a printed
      // "Testbox: not required" is the fail-open this pins shut.
      expect(stdout).not.toContain("not required");
    });

    // Both delta-side branches are NON-fatal by design — an unusable delta is
    // the ambiguous case the block resolves by keeping the cumulative answer.
    // That makes them the dangerous ones: a regression here does not exit 1, it
    // decays the requirement and prints "do not warm one", which is the exact
    // fail-open the whole block argues against.
    for (const probe of [
      {
        label: "returns a non-boolean testbox.required",
        delta: {
          body: '{"seedAreas":[],"validation":{"localChecks":[],"verificationChecks":[],"testbox":{}},"reviewSkills":[]}',
        },
        note: "did not emit a boolean testbox requirement",
      },
      {
        label: "fails outright",
        delta: { exit: 1 },
        note: "the delta resolution failed",
      },
    ]) {
      it(`keeps the cumulative answer when the DELTA resolution ${probe.label}`, async () => {
        const stateDir = mkdtempSync(join(tmpRoot, "rp-deltafail-"));
        // C0: an ancestor with a non-empty delta, so the decay is refused on
        // the DELTA's merits rather than on the ancestry guard above.
        await setVerified(stateDir, c0);

        const { stdout, exitCode } = await planIn(
          stateDir,
          resolverShim(probe.delta),
        );
        expect(exitCode).toBe(0);
        const plan = JSON.parse(stdout);

        expect(plan.testboxDecision.planRequired).toBe(true);
        expect(plan.testboxDecision.incrementalRequired).toBe(null);
        expect(plan.testboxDecision.decayed).toBe(false);
        expect(plan.testboxDecision.required).toBe(true);
        expect(plan.testboxDecision.note).toContain(probe.note);
        expect(plan.testboxDecision.note).toContain("fail-closed");
      });
    }

    /**
     * A `git` that fails the file-listing diff for ONE revision and defers
     * every other invocation to the real binary, so nothing but the step under
     * test is disturbed. Scoping it to a revision is what lets the delta probe
     * reach its branch at all: a shim that failed every `--no-renames` diff
     * would trip the cumulative listing first and exit before the delta ran.
     */
    const gitShimFailingDiffFor = (rev: string) => {
      const dir = mkdtempSync(join(tmpRoot, "rp-shim-git-"));
      const real = realGitForShell();
      writeFakeProgram(
        join(dir, "git"),
        `#!/usr/bin/env bash
diffish=0
for a in "$@"; do [ "$a" = "--no-renames" ] && diffish=1; done
if [ "$diffish" = "1" ]; then
  for a in "$@"; do
    if [ "$a" = "${rev}" ]; then
      echo "fatal: bad object (probe)" >&2
      exit 128
    fi
  done
fi
exec "${real}" "$@"
`,
      );
      return dir;
    };

    // The resolver shim rides along: without it the real `resolve.ts` runs in a
    // scratch repo that has no such file, the plan dies at "the change-area
    // resolver failed", and a probe asserting a non-zero exit would pass for
    // entirely the wrong reason.
    const planWithGitShim = async (stateDir: string, gitDir: string) => {
      const proc = Bun.spawn(
        scriptArgv(join(SCRIPTS, "round-plan.ts"), "999", "--json"),
        {
          cwd: repo,
          env: {
            ...gitCleanEnv(),
            ...IDENTITY,
            PATH: `${gitDir}${delimiter}${resolverShim({ body: DELTA_FULL })}${delimiter}${prBaseGh()}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_STATE_DIR: stateDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    };

    // Both file lists are built the same way and carry the same fail-open:
    // `{ git diff; git ls-files; } | sort -u` reports only `sort`'s status, so a
    // failing `git diff` exits 0 and its missing output reads as "nothing
    // changed". On the cumulative side that prints "no files changed — nothing
    // to validate"; on the delta side it decays the Testbox requirement.
    it("refuses to emit a plan when the cumulative file list cannot be computed", async () => {
      const stateDir = mkdtempSync(join(tmpRoot, "rp-difffail-"));
      const { stdout, stderr, exitCode } = await planWithGitShim(
        stateDir,
        gitShimFailingDiffFor(c0),
      );

      expect(exitCode).toBe(1);
      expect(stderr).toContain("cannot list the files changed since");
      // Never the empty-plan branch, whose wording an operator would read as
      // an all-clear.
      expect(stdout).not.toContain("nothing to validate");
    });

    it("keeps the cumulative answer when the DELTA file list cannot be computed", async () => {
      const stateDir = mkdtempSync(join(tmpRoot, "rp-deltadifffail-"));
      // Verified at C1 so the delta diff names a DIFFERENT revision than the
      // cumulative one (whose base is C0) — the cumulative listing therefore
      // succeeds and the failure lands squarely on the delta.
      await setVerified(stateDir, c1);

      const { stdout, exitCode } = await planWithGitShim(
        stateDir,
        gitShimFailingDiffFor(c1),
      );

      expect(exitCode).toBe(0);
      const plan = JSON.parse(stdout);
      // Without the check this is the worst case in the whole block: an empty
      // delta, `incrementalRequired: false`, and a decayed "do not warm one".
      expect(plan.testboxDecision.incrementalRequired).toBe(null);
      expect(plan.testboxDecision.decayed).toBe(false);
      expect(plan.testboxDecision.required).toBe(true);
      expect(plan.testboxDecision.note).toContain(
        "delta file list could not be computed",
      );
      expect(plan.testboxDecision.note).toContain("fail-closed");
    });
  });

  // The empty branch is a hand-written stub of the resolver's shape rather than
  // the resolver's own output, so it is the one place the JSON contract can
  // drift without any type ever complaining. A consumer that iterates
  // `requiredBy` unconditionally works on every non-empty plan and crashes on
  // the empty one — a shape bug that only ever fires on the quietest round.
  it("emits the SAME testbox shape on an empty plan as on a resolved one", async () => {
    const stateDir = mkdtempSync(join(tmpRoot, "rp-empty-"));
    // A clean scratch repo: nothing changed since its own HEAD, so the file
    // list is empty by construction rather than by hoping this worktree is
    // clean (it is not, mid-round).
    const proc = Bun.spawn(
      scriptArgv(
        join(SCRIPTS, "round-plan.ts"),
        "999",
        "--since",
        scratchClean.head,
        "--json",
      ),
      {
        cwd: scratchClean.dir,
        // gitCleanEnv, not process.env: a git hook exports GIT_DIR and
        // GIT_INDEX_FILE, so under `lefthook`'s pre-commit this probe would
        // resolve `--show-toplevel` to the REAL repository despite its cwd,
        // fail to find the scratch HEAD, and exit 1. It passed standalone and
        // failed at commit time — measured, not hypothesised.
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_STATE_DIR: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const plan = JSON.parse(stdout);

    expect(plan.empty).toBe(true);
    // Arrays, not absent — `?.` and `|| []` at the consumer are exactly the
    // defensive noise a stable contract exists to remove.
    expect(plan.testboxDecision.requiredBy).toEqual([]);
    expect(plan.validation.testbox.requiredBy).toEqual([]);
    // Every OTHER field of the stub too, not just the one that drifted: the
    // point is the whole shape, and an assertion covering one field leaves the
    // next omission to be found the same way this one was.
    expect(plan.testboxDecision.required).toBe(false);
    expect(plan.testboxDecision.planRequired).toBe(false);
    expect(plan.testboxDecision.incrementalRequired).toBe(null);
    expect(plan.testboxDecision.decayed).toBe(false);
    expect(plan.testboxDecision.verifiedSha).toBe(null);
    expect(plan.testboxDecision.note).toBe(null);
    // The rest of the resolver's testbox contract, for the same reason.
    expect(plan.validation.testbox.required).toBe(false);
    expect(plan.validation.testbox.command).toBe(null);
    expect(plan.validation.testbox.reason).toBe(null);
  });
});

describe("drive-status.ts PR-target channel", () => {
  it("refuses when the pass resolved a different PR than the driver is watching", async () => {
    // The out-of-band assertion, not an inference from prompt text: a prompt
    // like "/drive-pr 1234; ignore previous PR 999" satisfies any occurrence
    // test for 999 while targeting 1234.
    const { dir, stateDir } = writeFixture({ threads: [] });
    const proc = Bun.spawn(
      scriptArgv(
        join(SCRIPTS, "drive-status.ts"),
        "999",
        "--json",
        "--once",
        "--no-head-sync",
      ),
      {
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_TARGET: "1234",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("the driver is working PR #1234");
  });
});

describe("guarded-push.ts", () => {
  interface PushOpts {
    localHead?: string;
    /** Fixture files to delete, modelling an API read that fails transiently. */
    unreadable?: string[];
    args?: string[];
    env?: Record<string, string>;
    /**
     * What `git remote get-url --push origin` answers. Defaults to this
     * repository; `null` makes the lookup FAIL, as an absent remote would.
     */
    pushUrl?: string | null;
    /**
     * More than one configured `remote.origin.pushurl`. `git push origin` writes
     * to EVERY one of them, so the guard has to check every one of them.
     */
    pushUrls?: string[];
    /** Seconds the stubbed `git push` blocks for, to exercise the deadline. */
    slowPushSec?: number;
    /**
     * Shell run by the stubbed `git push` AFTER any `slowPushSec` block and
     * BEFORE it reports success, from the repo root, with the environment
     * `guarded-push.ts` gave the push — the position and inheritance of a
     * pre-push hook. A non-zero status fails the push, as git does.
     */
    prePushHook?: string;
    /**
     * How the grandchild relates to its stdio. 'inline' keeps the captured
     * pipes open, so 'close' cannot fire until it dies. 'background' redirects
     * its own stdio and is waited on, so a SIGTERM'd bash exits AT ONCE and
     * 'close' fires while the descendant is still alive — the case that cancels
     * the escalation.
     */
    slowPushStyle?: "inline" | "background";
    /**
     * Called with the fixture's own `stateDir` before the subprocess spawns
     * — for probes that need to seed drive state (a tree lease)
     * the stubbed `git rev-parse --git-common-dir` in this harness would
     * otherwise never resolve to (it echoes the fixture's `localHead`, not a
     * real path, so `DRIVE_PR_STATE_DIR` must be set explicitly for such a
     * probe to reach the real directory at all).
     */
    seedState?: (stateDir: string) => void;
  }

  async function guardedPush(f: Fixture, opts: PushOpts = {}) {
    const localHead = opts.localHead ?? f.head ?? HEAD;
    const { dir, stateDir } = writeFixture(f);
    opts.seedState?.(stateDir);
    for (const name of opts.unreadable ?? []) {
      rmSync(join(dir, name), { force: true });
    }
    // `git` is stubbed alongside `gh` so the probe never touches a real repo.
    // It must answer `rev-parse HEAD` truthfully: guarded-push.ts compares that
    // SHA against the PR head afterwards to prove the PR actually advanced. It
    // must also answer `remote get-url --push origin`, which is how the script
    // learns where the push would ACTUALLY land — `gh repo view` answers a
    // different question and can disagree.
    const pushUrl =
      opts.pushUrl === undefined
        ? "git@github.com:example-org/example-repo.git"
        : opts.pushUrl;
    const pushUrls = opts.pushUrls ?? (pushUrl === null ? null : [pushUrl]);
    const gitStub = join(dir, "bin");
    mkdirSync(gitStub, { recursive: true });
    const p = join(gitStub, "git");
    // Exactly the root `ACTOR` was derived from, in git's own spelling.
    const toplevel = shellPath(await worktreeRoot());
    const hookFile = join(dir, "pre-push-hook.sh");
    if (opts.prePushHook) writeFileSync(hookFile, opts.prePushHook);
    writeFakeProgram(
      p,
      [
        "#!/usr/bin/env bash",
        'case "$1" in',
        '  rev-parse) case "$*" in "rev-parse HEAD"|"rev-parse --git-dir"|"rev-parse --git-common-dir"|"rev-parse --show-toplevel") ;; *) echo "git rev-parse: unknown argument: $*" >&2; exit 2 ;; esac ;;',
        '  remote) [ "$*" = "remote get-url --push --all origin" ] || { echo "git remote: unknown argument: $*" >&2; exit 2; } ;;',
        `  push) ${GIT_PUSH_FLAG_GUARD} ;;`,
        '  *) echo "unexpected fake git command: $*" >&2; exit 2 ;;',
        "esac",
        // `--show-toplevel` specifically, BEFORE the generic `rev-parse`
        // catch-all below: `resolveActor()` (`worktreeRoot()`) calls exactly
        // this to derive the actor id a seeded tree lease is
        // keyed by. Answering it with the fixture's own `localHead` instead
        // of a real path — what the generic branch does for every other
        // `rev-parse` subcommand — would derive a DIFFERENT actor than the
        // one this suite's own `ACTOR` constant resolved, so a probe that
        // seeds a lease under `ACTOR` would look for it under a path this
        // process can never compute, and read as absent unconditionally.
        `if [ "\${1:-}" = "rev-parse" ] && [ "\${2:-}" = "--show-toplevel" ]; then echo "${toplevel}"; exit 0; fi`,
        `if [ "\${1:-}" = "rev-parse" ]; then echo "${localHead}"; exit 0; fi`,
        'if [ "${1:-}" = "remote" ]; then',
        pushUrls === null
          ? "  echo \"error: No such remote 'origin'\" >&2; exit 128"
          : `  printf '%s\\n' ${pushUrls.map((u) => `"${u}"`).join(" ")}; exit 0`,
        "fi",
        // The GRANDCHILD writes its own marker, in one `sh -c`. Splitting it
        // into `sleep N` followed by a separate write makes the probe vacuous:
        // the write is bash's command, so killing bash alone stops it too, and
        // an absent marker proves nothing about the sleep. Here bash dies and
        // the orphaned `sh` still writes — unless the signal reached the whole
        // group. `sh` inherits bash's group, so that is exactly the difference
        // being measured.
        ...(opts.slowPushSec
          ? opts.slowPushStyle === "background"
            ? [
                // `trap "" TERM` is what makes this probe about the
                // ESCALATION rather than about the first signal: the group
                // SIGTERM reaches this grandchild too, so without the trap it
                // dies there and the SIGKILL path is never exercised (this
                // probe passed against the unfixed code until the trap was
                // added). Only an untrappable SIGKILL can stop it now.
                `sh -c 'trap "" TERM; sleep ${opts.slowPushSec}; : > "${join(dir, "survived")}"' >/dev/null 2>&1 &`,
                "wait",
              ]
            : [
                `sh -c 'sleep ${opts.slowPushSec}; : > "${join(dir, "survived")}"'`,
              ]
          : []),
        ...(opts.prePushHook
          ? [
              `(cd "${REPO_ROOT}" && sh "${hookFile}") || { echo "error: failed to push some refs" >&2; exit 1; }`,
            ]
          : []),
        'echo "PUSHED $*" >&2',
        'echo "   abc..def  HEAD -> main"',
      ].join("\n"),
    );
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "guarded-push.ts"), ...(opts.args ?? ["999"])),
      {
        env: {
          ...process.env,
          PATH: `${gitStub}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          // Keep the post-push verification poll short in tests; production
          // defaults to 10 × 6s to ride out replication lag.
          DRIVE_PR_PUSH_VERIFY_TRIES: "2",
          DRIVE_PR_PUSH_VERIFY_INTERVAL: "1",
          // ALWAYS, not only when a probe asks to seed drive state: the git
          // stub above answers ANY `rev-parse` (including `--git-common-dir`)
          // with `localHead`, so without this override `resolveFenceContext`
          // resolves a garbage "state dir" — harmless for the old read-only
          // tree fence (a nonexistent path reads as "no lease", i.e. pass), but
          // `assertTreeMutationAllowed` now ACQUIRES a lock there too: creating
          // a lock file under a directory that does not exist is not "no
          // lease", it is a real failure the lock's own retry loop cannot
          // distinguish from contention, and it burns the full
          // `DRIVE_PR_LOCK_TIMEOUT` (30s) before every unseeded guarded-push
          // probe in this suite. Both vars, never one alone — an override
          // without its identity token fails closed, which would make every
          // probe here measure that refusal instead of whatever the probe
          // actually tests.
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(stateDir),
          ...(opts.env ?? {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stderr, exitCode, survivorMarker: join(dir, "survived") };
  }

  it("pushes while the PR is open", async () => {
    const r = await guardedPush({ threads: [] });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("PUSHED");
  });

  it("--expect-head refuses BEFORE pushing when local HEAD moved since the caller’s own preflight read", async () => {
    // The caller (finish-round.ts) reads HEAD once, then invokes this script
    // as a NEW subprocess that resolves its OWN localSha independently. A
    // commit landing in the shared worktree in that gap would otherwise be
    // pushed even though nothing validated it — this is what closes it: the
    // caller passes the SHA it already validated, and a mismatch here refuses
    // rather than silently pushing whatever HEAD has become.
    const r = await guardedPush(
      { threads: [] },
      { localHead: HEAD, args: ["999", "--expect-head", PREV] },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).not.toContain("PUSHED");
    expect(r.stderr).toContain("local HEAD");
    expect(r.stderr).toContain("preflight");
  });

  it("--expect-head allows the push when local HEAD still matches the caller’s preflight read", async () => {
    const r = await guardedPush(
      { threads: [] },
      { localHead: HEAD, args: ["999", "--expect-head", HEAD] },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("PUSHED");
  });

  it("refuses an EMPTY --expect-head rather than silently disabling the check", async () => {
    // `--expect-head ''` is an EXPLICIT empty-string argument, not an omitted
    // flag — the parser's own `take()` only checks a next argv element
    // exists, not that it is usable, so this used to set `expectHead = ''`
    // and the mismatch check below (`expectHead !== ''`) then read as "no
    // check requested", the opposite of what passing the flag at all means.
    const r = await guardedPush(
      { threads: [] },
      { localHead: HEAD, args: ["999", "--expect-head", ""] },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).not.toContain("PUSHED");
    expect(r.stderr).toContain("--expect-head");
    expect(r.stderr).toContain("not a full 40-character git SHA");
  });

  it("refuses to push while a DIFFERENT live session holds this tree", async () => {
    // Until this fix, guarded-push.ts called into NO session fence at all —
    // an orphaned pass (its own session dead, the tree already taken over by
    // a replacement session working a different PR) could push straight
    // through, cross-shipping this pass's uncommitted work onto the other
    // session's PR. Seeded directly (rather than via drive-state.ts) so the
    // probe is exactly what the fence itself reads, independent of the
    // claim path that normally writes it.
    const foreign = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const r = await guardedPush(
        { threads: [] },
        {
          seedState: (stateDir) => {
            const path = treeLeasePathFor(stateDir, ACTOR);
            const now = new Date().toISOString();
            writeFileSync(
              path,
              `${JSON.stringify(
                {
                  holder: "session",
                  pid: foreign.pid,
                  host: "",
                  platform: process.platform,
                  actor: ACTOR,
                  worktree: "",
                  startedAt: now,
                  lastSeen: now,
                  command: "bump-round",
                  generation: "g1",
                  sessionStarted: "",
                  pr: "777",
                  revision: "r1",
                },
                null,
                2,
              )}\n`,
            );
          },
          // No DRIVE_PR_SESSION/CLAUDE_PID matching `foreign` — this process
          // must read as a DIFFERENT, foreign session.
          env: { DRIVE_PR_SESSION: "", CLAUDE_PID: "" },
        },
      );
      expect(r.exitCode).toBe(11);
      // Nothing was pushed — the fence ran BEFORE `git push`, not after.
      expect(r.stderr).not.toContain("PUSHED");
      expect(r.stderr).toContain(`pid ${foreign.pid}`);
      expect(r.stderr).toContain("PR #777");
    } finally {
      try {
        foreign.kill();
      } catch {
        // Already gone — the probe under test may have outlived it.
      }
    }
  });

  it("pushes when the tree lease belongs to a session that is gone", async () => {
    // The self-recovery half of the same fence: an ENDED drive is not a
    // rival, so a dead session's tree lease must not block a legitimate
    // push. A definitively-gone pid: a child spawned only to be waited on —
    // any literal would be a guess about the machine running the suite.
    const deadProc = Bun.spawn(["true"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await deadProc.exited;
    const dead = deadProc.pid;
    const r = await guardedPush(
      { threads: [] },
      {
        seedState: (stateDir) => {
          const path = treeLeasePathFor(stateDir, ACTOR);
          const now = new Date().toISOString();
          writeFileSync(
            path,
            `${JSON.stringify(
              {
                holder: "session",
                pid: dead,
                host: "",
                platform: process.platform,
                actor: ACTOR,
                worktree: "",
                startedAt: now,
                lastSeen: now,
                command: "bump-round",
                generation: "g1",
                sessionStarted: "",
                pr: "777",
                revision: "r1",
              },
              null,
              2,
            )}\n`,
          );
        },
        env: { DRIVE_PR_SESSION: "", CLAUDE_PID: "" },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("PUSHED");
  });

  it("assertTreeMutationAllowed HOLDS the tree lock, not just checks it", async () => {
    // Before this fix, the fence read the lease and returned void — the
    // underlying `treeLeaseLock` was never taken at all, so a replacement
    // session's takeover could land in the exact window between the check
    // and `git push` completing.
    // Proven directly at the lock level, independent of `guarded-push.ts`'s
    // own subprocess plumbing: a second acquirer of the SAME tree-lease path
    // — via the identical `createLock(path, ..., 'tree')` call
    // `treeLeaseLock` itself makes — must stay BLOCKED for as long as the
    // returned lock is held, not free to proceed the instant the check
    // finished.
    const d = mkdtempSync(join(tmpdir(), "drive-pr-tree-lock-held-"));
    const path = treeLeasePathFor(d, ACTOR);
    const session: Session = {
      pid: process.pid,
      host: hostname(),
      source: "DRIVE_PR_SESSION",
      sessionStarted: "",
    };
    // No tree lease seeded — the fence's `held === null` path passes
    // immediately, so the lock is the only thing left to prove.
    const lock = await assertTreeMutationAllowed(
      {
        stateDir: d,
        actor: ACTOR,
        session,
        fromOverride: false,
        legacyStateDirForFallback: d,
      },
      "999",
      "test",
    );
    let released = false;
    try {
      const rival = createLock(path, "drive-state.ts (tree lease)", "tree");
      let rivalAcquired = false;
      const rivalPromise = rival
        .acquire(5)
        .then(() => {
          rivalAcquired = true;
        })
        .finally(() => {
          rival.release();
          rival.dispose();
        });
      await new Promise((res) => setTimeout(res, 300));
      // Still held 300ms later — the rival must not have gotten in while
      // this lock was live, which is the whole property under test.
      expect(rivalAcquired).toBe(false);
      lock.release();
      lock.dispose();
      released = true;
      await rivalPromise;
      expect(rivalAcquired).toBe(true);
    } finally {
      if (!released) {
        lock.release();
        lock.dispose();
      }
    }
  });

  it("refuses to push onto a branch whose PR merged mid-round", async () => {
    // drive.ts's pre-pass liveness check cannot cover the minutes of triage,
    // fixing and gating that precede this moment.
    const r = await guardedPush({ threads: [], prState: "MERGED" });
    expect(r.exitCode).toBe(5);
    expect(r.stderr).not.toContain("PUSHED");
    expect(r.stderr).toContain("orphaned");
  });

  it("refuses a FORK PR rather than pushing at origin", async () => {
    // origin is the wrong remote for a fork head. Pushing anyway either fails
    // or writes to an unrelated same-named branch in the base repo — which the
    // post-push check only notices after the irreversible write.
    const r = await guardedPush({ threads: [], headRepoOwner: "someone-else" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).not.toContain("PUSHED");
    expect(r.stderr).toContain("fork PR");
  });

  it("pushes an explicit refspec at the PR’s own head branch, naming the RESOLVED SHA rather than the literal HEAD token", async () => {
    // A bare `git push` obeys the worktree's upstream, push.default and any
    // configured refspecs, so it can update a different existing branch while
    // the liveness check inspected the intended PR. Naming the target removes
    // the ambiguity rather than trying to detect it afterwards.
    //
    // The source side names the SHA this process itself resolved, not the
    // literal `HEAD` token: a literal `HEAD:refs/heads/…` refspec would
    // re-resolve HEAD at the moment `git push` actually runs — after every
    // fence/lock check above has already spent real time — so a commit landing
    // in this shared worktree during that window would be pushed even though
    // nothing validated it. The resolved SHA names an exact, already-existing
    // commit object regardless of what HEAD does afterward.
    const r = await guardedPush({ threads: [] });
    expect(r.stderr).toContain(`origin ${HEAD}:refs/heads/`);
    expect(r.stderr).not.toContain("origin HEAD:refs/heads/");
  });

  it("fails when the PR did not advance to the SHA that was pushed", async () => {
    // Survives the remaining routes to a wrong ref — a fork head repository, a
    // protected-branch rewrite, a racing force-push.
    const r = await guardedPush({ threads: [] }, { localHead: PREV });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("still reports");
  });

  it("--dry-run succeeds without waiting for a head that cannot move", async () => {
    // A dry run updates NOTHING, so the post-push confirmation above — which
    // waits for the PR to report the SHA we pushed — can only ever exhaust its
    // budget and report a push that "may not be on the pull request". That made
    // the one allowlisted option whose entire purpose is a rehearsal a
    // guaranteed exit 1. `localHead: PREV`
    // is the same divergence the probe above uses, so this fails exactly the
    // way the bug did if the skip is ever removed.
    const r = await guardedPush(
      { threads: [] },
      { localHead: PREV, args: ["999", "--", "--dry-run"] },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("PUSHED");
    expect(r.stderr).toContain("was NOT updated");
    expect(r.stderr).not.toContain("still reports");
  });

  it("kills a push that outlives its deadline rather than parking forever", async () => {
    // The only `git` call in this skill that talks to a remote, hence the only
    // one that can be accepted and never complete — mode 13, the failure
    // lib/proc.ts deadlines `gh` against.
    // The elapsed time IS the assertion. The stub's `sleep` survives the
    // SIGTERM aimed at its bash parent and keeps the inherited pipes open, so
    // 'close' does not fire and a driver that waited for it settled only when
    // the grandchild finished — the deadline reported, and bounded nothing.
    // Asserting only the message would pass either way.
    //
    // The stub sleeps far longer than the bound below rather than just past
    // it: the fixed path settles at 1s + the 2s SIGKILL escalation, so a
    // 10s ceiling against a 20s stub leaves both directions unambiguous on a
    // loaded CI runner instead of turning a slow machine into a flake.
    const started = Date.now();
    const r = await guardedPush(
      { threads: [] },
      { slowPushSec: 20, env: { DRIVE_PR_PUSH_TIMEOUT: "1" } },
    );
    const elapsed = Date.now() - started;
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("exceeded");
    expect(r.stderr).toContain("was killed");
    expect(r.stderr).not.toContain("still reports");
    expect({ boundedBeforeTheChildFinished: elapsed < 10_000 }).toEqual({
      boundedBeforeTheChildFinished: true,
    });
  });

  it.skipIf(NO_TREE_KILL)(
    "the deadline kills the process TREE, not just the child it signalled",
    async () => {
      // Returning promptly is not the same as having stopped the work. `git
      // push` runs the pre-push hook, and that hook runs the build and test
      // suites — a deadline that reports "killed" while those keep running
      // leaves them consuming the machine and producing side effects after the
      // driver has moved on.
      //
      // The stub's `sleep` is a genuine grandchild, and it writes the marker
      // only if it lives to finish. Waiting past its full duration before
      // looking is what makes the absence of the marker mean "killed" rather
      // than "not written yet". The kill grace is shortened to 500ms, so the
      // tree is gone by ~1.5s, well before the 3s sleep would finish.
      const r = await guardedPush(
        { threads: [] },
        {
          slowPushSec: 3,
          env: {
            DRIVE_PR_PUSH_TIMEOUT: "1",
            DRIVE_PR_KILL_ESCALATE_MS: "500",
          },
        },
      );
      expect(r.exitCode).toBe(1);
      await new Promise((res) => setTimeout(res, 3500));
      expect({ grandchildSurvived: existsSync(r.survivorMarker) }).toEqual({
        grandchildSurvived: false,
      });
    },
  );

  it.skipIf(NO_TREE_KILL)(
    "escalates to SIGKILL even when the child exits before the grace elapses",
    async () => {
      // The tree kill above is delivered by a two-second escalation timer, and
      // `settle` clears that timer. A child that exits promptly on SIGTERM while
      // a descendant survives WITHOUT holding the captured streams therefore
      // fires 'close' first and cancels the only SIGKILL the group was going to
      // get — the wrapper reports 124 while the descendant runs on, which is the
      // exact leak the group kill exists to close.
      //
      // 'background' is what makes the child exit early: the grandchild's stdio
      // goes to /dev/null, so nothing but bash holds the pipes. The grace is
      // shortened to 500ms — still ample for bash to exit on the SIGTERM
      // first — and the 3s sleep still outlasts the kill.
      const r = await guardedPush(
        { threads: [] },
        {
          slowPushSec: 3,
          slowPushStyle: "background",
          env: {
            DRIVE_PR_PUSH_TIMEOUT: "1",
            DRIVE_PR_KILL_ESCALATE_MS: "500",
          },
        },
      );
      expect(r.exitCode).toBe(1);
      await new Promise((res) => setTimeout(res, 3500));
      expect({ grandchildSurvived: existsSync(r.survivorMarker) }).toEqual({
        grandchildSurvived: false,
      });
    },
  );

  it("refuses a DRIVE_PR_PUSH_TIMEOUT of 0 rather than pushing unbounded", async () => {
    // Same refusal GH_CALL_TIMEOUT carries, and for the same reason: `0`
    // disables a deadline rather than firing immediately, so honouring it is
    // honouring a request for the unbounded call this bound exists to prevent.
    const r = await guardedPush(
      { threads: [] },
      { env: { DRIVE_PR_PUSH_TIMEOUT: "0" } },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).not.toContain("PUSHED");
    expect(r.stderr).toContain("DRIVE_PR_PUSH_TIMEOUT");
  });

  it("refuses when origin’s PUSH URL cannot be read, rather than pushing anyway", async () => {
    // The fork check needs both identities. Defaulting the unreadable one to
    // empty and skipping the comparison turns a transient failure into
    // permission to push — reaching the irreversible wrong-repository write
    // this guard exists to prevent, by the one path nobody is watching.
    const r = await guardedPush(
      { threads: [], headRepoOwner: "someone-else" },
      { pushUrl: null },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain("PUSHED");
    expect(r.stderr).toContain("no push URL");
  });

  it("compares the head repo against ORIGIN, not against `gh repo view`", async () => {
    // `gh` resolves a repository through $GH_REPO, `gh repo set-default` and its
    // own remote ordering, so it can name a repository that is not where `git
    // push origin` writes. Validating the head repo against the gh-derived one
    // passes here while the push lands the PR's branch name in an unrelated
    // repository — and the post-push head check notices only after the
    // irreversible write. Everything gh reports agrees with the PR; only
    // `origin` disagrees.
    const r = await guardedPush(
      { threads: [] },
      { pushUrl: "git@github.com:someone-else/project.git" },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).not.toContain("PUSHED");
    expect(r.stderr).toContain("someone-else/project");
  });

  it("validates EVERY configured push URL, not just the first", async () => {
    // `remote.origin.pushurl` is multi-valued and `git push origin` writes to
    // all of them. Checking only the first leaves the second repository
    // advanced irreversibly by a push this guard called safe.
    const r = await guardedPush(
      { threads: [] },
      {
        pushUrls: [
          "git@github.com:example-org/example-repo.git",
          "git@github.com:someone-else/mirror.git",
        ],
      },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).not.toContain("PUSHED");
    expect(r.stderr).toContain("someone-else/mirror");
  });

  it("pushes when every configured push URL is the PR’s head repository", async () => {
    const r = await guardedPush(
      { threads: [] },
      {
        pushUrls: [
          "git@github.com:example-org/example-repo.git",
          "https://github.com/example-org/example-repo",
        ],
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("PUSHED");
  });

  it("ALLOWLISTS forwarded options instead of denying known-bad ones", async () => {
    // A successful guarded push is what the driver treats as proof a fix landed
    // AND passed the mandatory pre-push gates, onto exactly the PR's branch.
    // Two classes break that, and a denylist cannot cover either:
    //
    //   hook bypass — git accepts unambiguous ABBREVIATIONS, so `--no-veri` is
    //                 `--no-verify`, and every prefix would need enumerating;
    //   ref-set     — `--tags` / `--follow-tags` write refs the explicit branch
    //                 refspec never names, so unrelated refs move irreversibly
    //                 while the script reports only that the branch did.
    for (const bad of [
      "--no-verify",
      "--no-veri",
      "--no-ver",
      "--tags",
      "--follow-tags",
      "--mirror",
      "--delete",
      "--receive-pack=evil",
    ]) {
      const r = await guardedPush(
        { threads: [] },
        { args: ["999", "--", bad] },
      );
      expect({ bad, exit: r.exitCode }).toEqual({ bad, exit: 2 });
      expect(r.stderr).not.toContain("PUSHED");
      expect(r.stderr).toContain(`refusing to forward '${bad}'`);
    }
  });

  it("still forwards the options a review-fix push genuinely needs", async () => {
    for (const ok of [
      "--force-with-lease",
      "--force-with-lease=main:abc",
      "--atomic",
      "-q",
    ]) {
      const r = await guardedPush({ threads: [] }, { args: ["999", "--", ok] });
      expect({ ok, exit: r.exitCode }).toEqual({ ok, exit: 0 });
      expect(r.stderr).toContain(ok);
    }
  });

  it("accepts an ssh-config host ALIAS for the same owner/name", async () => {
    // `git@github-example:example-org/example-repo.git` is an ordinary ~/.ssh/config
    // alias, and this repository's own developer clones use one. Comparing
    // hosts would refuse every real push on those machines — a guard that
    // blocks the correct case is worse than the exotic case it would catch.
    const r = await guardedPush(
      { threads: [] },
      { pushUrl: "git@github-example:example-org/example-repo.git" },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("PUSHED");
  });

  it("refuses when the PR state cannot be read — exit 1, not a terminal exit 5", async () => {
    // `read ... <<<"$(gh …)"` cannot fail on the query: read sees an empty
    // here-string, assigns empty fields and returns 0. An auth blip would then
    // fall through to the state check and report PR_NOT_OPEN, which the driver
    // treats as terminal — the drive stops claiming the PR merged.
    const r = await guardedPush(
      { threads: [] },
      { unreadable: ["pr-view.json"] },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown state");
    expect(r.stderr).not.toContain("PUSHED");
  });

  it("refuses an explicit PR that contradicts $DRIVE_PR_TARGET", async () => {
    // Under a drive for #1234, `guarded-push.ts 999` would otherwise check
    // #999's liveness and push the local HEAD onto #999's head branch — every
    // guard satisfied, and the wrong pull request advanced irreversibly.
    const r = await guardedPush(
      { threads: [] },
      { env: { DRIVE_PR_TARGET: "1234" } },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).not.toContain("PUSHED");
    expect(r.stderr).toContain("drive target is #1234");
  });

  it("pushes when the explicit PR AGREES with $DRIVE_PR_TARGET", async () => {
    const r = await guardedPush(
      { threads: [] },
      { env: { DRIVE_PR_TARGET: "999" } },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("PUSHED");
  });

  it("pushes when the explicit PR and $DRIVE_PR_TARGET name the same PR in different numeric forms", async () => {
    // `DRIVE_PR_TARGET=0999` and the explicit positional `999` identify
    // the SAME PR, but a raw string comparison before canonicalization
    // would refuse them as a mismatch.
    const r = await guardedPush(
      { threads: [] },
      { args: ["999"], env: { DRIVE_PR_TARGET: "0999" } },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("PUSHED");
  });

  // The end-to-end counterpart of the mailbox.test.ts unit tests: those
  // exercise `isPushHeld` directly, but nothing wired `DRIVE_PR_MAILBOX_DIR`
  // into a real `guarded-push.ts` invocation and confirmed the exit-17 refusal
  // (and the subsequent resume) actually fires through the script's own env
  // resolution — deleting the `isPushHeld(...)` call from `guarded-push.ts`
  // left every OTHER test in this describe block green.
  describe("mailbox 'hold-push' directive", () => {
    const seededMailboxDirs: string[] = [];
    function seededMailboxDir(): string {
      const d = mkdtempSync(join(tmpdir(), "drive-pr-mailbox-guarded-push-"));
      seededMailboxDirs.push(d);
      return d;
    }
    afterEach(() => {
      for (const d of seededMailboxDirs.splice(0)) {
        rmSync(d, { recursive: true, force: true });
      }
    });

    it("refuses the push (exit 17) while an active hold-push directive is live, and pushes nothing", async () => {
      const mailboxDir = seededMailboxDir();
      await appendDirective(mailboxDir, "999", "orchestrator", "hold-push");
      const r = await guardedPush(
        { threads: [] },
        { env: { DRIVE_PR_MAILBOX_DIR: mailboxDir } },
      );
      expect(r.exitCode).toBe(17);
      expect(r.stderr).toContain("hold-push");
      expect(r.stderr).not.toContain("PUSHED");
    });

    it("pushes normally once a matching resume directive clears the hold", async () => {
      const mailboxDir = seededMailboxDir();
      await appendDirective(mailboxDir, "999", "orchestrator", "hold-push");
      await appendDirective(mailboxDir, "999", "orchestrator", "resume", {
        target: "hold-push",
      });
      const r = await guardedPush(
        { threads: [] },
        { env: { DRIVE_PR_MAILBOX_DIR: mailboxDir } },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("PUSHED");
    });

    it("pushes normally against an absent mailbox — no directive was ever sent", async () => {
      const mailboxDir = seededMailboxDir();
      const r = await guardedPush(
        { threads: [] },
        { env: { DRIVE_PR_MAILBOX_DIR: mailboxDir } },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("PUSHED");
    });

    // The documented recheck hook entry, so this block also pins the wiring
    // end to end: guarded-push.ts exports the arming environment, the entry's
    // shell gate reads it, and the script reads the mailbox it was pointed at.
    // A rename of any variable in any one of the three turns these probes red.
    const lefthookRecheckRun = recheckHookEntry;

    function sendHoldPush(mailboxDir: string) {
      return Bun.spawn(
        [
          "bun",
          join(SCRIPTS, "mailbox.ts"),
          "send",
          "999",
          "--kind",
          "directive",
          "--from",
          "concurrent-sender",
          "--command",
          "hold-push",
        ],
        {
          env: { ...process.env, DRIVE_PR_MAILBOX_DIR: mailboxDir },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
    }

    it("a hold sent DURING the pre-push hook window aborts that push (exit 17) instead of being overtaken by it", async () => {
      // Originally a hold sent after `guarded-push.ts`'s own check could never
      // affect the push already underway: the check ran once, and the pre-push
      // chain (production: up to an hour) ran after it. An earlier fix held the
      // mailbox lock across the push, which made the SENDER block instead — the
      // hold could not land at all until the push was over. Now the send lands
      // at once, and the hook chain's last step, the recheck, aborts the push
      // before it transfers anything.
      //
      // Deterministic, not timed: the stubbed hook chain announces it has
      // started (so the push provably cleared its own EARLY check — a hold
      // sent before that would be refused by the early check and pass this
      // test without the recheck existing at all), then blocks on a release
      // file, then runs the recheck as lefthook would. The hold is sent
      // strictly inside that window.
      const mailboxDir = seededMailboxDir();
      const syncDir = seededMailboxDir();
      const started = join(syncDir, "hook-started");
      const release = join(syncDir, "hook-release");
      const pushPromise = guardedPush(
        { threads: [] },
        {
          env: { DRIVE_PR_MAILBOX_DIR: mailboxDir },
          prePushHook: [
            `: > "${started}"`,
            `until [ -e "${release}" ]; do sleep 0.1; done`,
            lefthookRecheckRun(),
          ].join("\n"),
        },
      );
      const deadline = Date.now() + 15_000;
      while (!existsSync(started)) {
        if (Date.now() > deadline) {
          writeFileSync(release, "");
          await pushPromise.catch(() => undefined);
          throw new Error("hook never started");
        }
        await Bun.sleep(50);
      }

      // Whatever happens below, release the stubbed hook and settle the push
      // child so a failed assertion cannot leave it running.
      try {
        const send = sendHoldPush(mailboxDir);
        // The sender must land WHILE the hook is still blocked. Were it made to
        // wait on the push (a lock held across it), this would sit until the
        // lock's own 300s bound, since the hook only proceeds once released.
        const sendOutcome = await Promise.race([
          send.exited,
          Bun.sleep(10_000).then(() => "blocked" as const),
        ]);
        if (sendOutcome === "blocked") {
          send.kill();
          throw new Error(
            "mailbox.ts send blocked while the push was in flight",
          );
        }
        const sendStderr = await new Response(send.stderr).text();
        if (sendOutcome !== 0) throw new Error(`send failed: ${sendStderr}`);
      } catch (e) {
        writeFileSync(release, "");
        await pushPromise.catch(() => undefined);
        throw e;
      }
      writeFileSync(release, "");

      const r = await pushPromise;
      expect(r.exitCode).toBe(17);
      // Text only the LATE path emits — the early check says "Nothing was
      // pushed", never this.
      expect(r.stderr).toContain("push-hold-recheck:");
      expect(r.stderr).not.toContain("PUSHED");
    }, 40_000);

    it("lets the same slow push complete when no hold arrives during the hook window", async () => {
      // The control for the probe above: identical harness and timing, no
      // send. Without it, a recheck that aborts EVERY armed push would pass
      // the probe above.
      const mailboxDir = seededMailboxDir();
      const r = await guardedPush(
        { threads: [] },
        {
          env: { DRIVE_PR_MAILBOX_DIR: mailboxDir },
          slowPushSec: 2,
          prePushHook: lefthookRecheckRun(),
        },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("PUSHED");
    }, 20_000);

    it("does not arm the recheck under --dry-run (nothing is pushed, so nothing needs holding)", async () => {
      const mailboxDir = seededMailboxDir();
      // A hold that WOULD abort an armed push. A dry run skips the hold
      // checks entirely, so it must reach the stub's success line.
      await appendDirective(mailboxDir, "999", "orchestrator", "hold-push");
      const r = await guardedPush(
        { threads: [] },
        {
          args: ["999", "--", "--dry-run"],
          env: { DRIVE_PR_MAILBOX_DIR: mailboxDir },
          prePushHook: lefthookRecheckRun(),
        },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("PUSHED");
    });

    it("strips arming the CALLER already exported from a --dry-run push", async () => {
      const mailboxDir = seededMailboxDir();
      await appendDirective(mailboxDir, "999", "orchestrator", "hold-push");
      const r = await guardedPush(
        { threads: [] },
        {
          args: ["999", "--", "--dry-run"],
          env: {
            DRIVE_PR_MAILBOX_DIR: mailboxDir,
            DRIVE_PR_HOLD_RECHECK_PR: "999",
          },
          prePushHook: lefthookRecheckRun(),
        },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("PUSHED");
    });

    it("reports a failed gate as exit 1 even when a hold becomes active after the gate failed", async () => {
      // The hold lands while the gate is failing, but the recheck never ran
      // (the gate exited first), so nothing was aborted BY the hold: the
      // cause must not be inferred from mailbox state read afterwards.
      const mailboxDir = seededMailboxDir();
      const r = await guardedPush(
        { threads: [] },
        {
          env: { DRIVE_PR_MAILBOX_DIR: mailboxDir },
          prePushHook: `bun ${join(SCRIPTS, "mailbox.ts")} send 999 --kind directive --from late-sender --command hold-push >/dev/null; echo "gate: tests failed" >&2; exit 1`,
        },
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("tests failed");
    });

    it("does not let a failed gate forge the unmarked-abort sentinel (exit 1, not 17)", async () => {
      // A gate that prints the sentinel text without this push's nonce — the
      // fixed pre-nonce string, and a guessed nonce — is not the recheck.
      const mailboxDir = seededMailboxDir();
      const r = await guardedPush(
        { threads: [] },
        {
          env: { DRIVE_PR_MAILBOX_DIR: mailboxDir },
          prePushHook:
            'echo "push-hold-recheck: hold-abort-unmarked" >&2; echo "push-hold-recheck: hold-abort-unmarked guessed" >&2; exit 1',
        },
      );
      expect(r.exitCode).toBe(1);
    });

    it("reports a plain failed gate as exit 1, not a hold, when no hold is active", async () => {
      // The exit-17 mapping re-reads the hold after a failed push; it must
      // not relabel every failed pre-push gate as a hold.
      const mailboxDir = seededMailboxDir();
      const r = await guardedPush(
        { threads: [] },
        {
          env: { DRIVE_PR_MAILBOX_DIR: mailboxDir },
          prePushHook: 'echo "gate: tests failed" >&2; exit 1',
        },
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("tests failed");
      expect(r.stderr).not.toContain("hold-push");
    });
  });
});
