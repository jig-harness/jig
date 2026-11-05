/**
 * drive-pr suite: answer-summary-finding.ts, assert-post-allowed.ts, resolve-held-thread.ts, finish-round.ts and list-unresolved-threads.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import {
  expectSpawnExit,
  expectSpawnExited,
} from "../../../../lib/test-helpers/expect-spawn-exit.ts";

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
} from "node:fs";

import { hostname, tmpdir } from "node:os";

import { join } from "node:path";

import { dbPathFor } from "../scripts/lib/state/db";

import { leaseRef, leaseRefsFor } from "../scripts/lib/state/lease";

import { SCRIPTS, gitCleanEnv, useDrivePrSuite } from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { putLease, removeLease } from "./state-rows.ts";

import { createFindingsPostFenceFixtures } from "./drive-pr-findings-post-fence-fixtures.ts";

useDrivePrSuite();
describe("assert-post-allowed.ts (the external-mutation fence)", () => {
  const findingsPostFenceFixtures = createFindingsPostFenceFixtures();
  const { stateDirFor, seedRawPrLease, seedLease, fence } =
    findingsPostFenceFixtures;

  it("--pr narrows to that drive: a live lease on ANOTHER PR does not refuse", async () => {
    // The narrowing exists so a caller who knows its PR is not refused by a
    // lease that has nothing to do with it. Without it, `answer-summary-
    // finding.ts` posting to #999 would be blocked by a leftover live lease on
    // some other PR in the same tree.
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const d = stateDirFor("other-pr");
      seedRawPrLease(d, "888", holder.pid);
      expect((await fence(d, ["--pr", "999"])).exitCode).toBe(0);
      // Same state, same holder — only the scope differs. Both halves are
      // asserted together so a fence that had stopped reading leases entirely
      // cannot pass the first half alone.
      expect((await fence(d, ["--pr", "888"])).exitCode).toBe(11);
      // And with no PR named it is the tree, not a drive, that is checked.
      expect((await fence(d, [])).exitCode).toBe(11);
    } finally {
      holder.kill();
    }
  });

  it("canonicalizes --pr before matching, so a leading zero still finds the live lease", async () => {
    // `isDigits` accepts "0999" — GitHub's numeric issue route treats it
    // identically to "999" — but a strict `===` against the lease row's own
    // canonical PR would not match, silently narrowing this
    // caller to zero candidates and authorizing the POST past a live lease
    // that should have refused it.
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const d = stateDirFor("leading-zero");
      seedLease(d, "999", holder.pid);
      expect((await fence(d, ["--pr", "0999"])).exitCode).toBe(11);
      expect((await fence(d, ["--pr", "00999"])).exitCode).toBe(11);
    } finally {
      holder.kill();
    }
  });

  it("with --pr, checks the lease PR-WIDE — a live lease from a DIFFERENT tree still refuses", async () => {
    // The actor-wide search below is blind to every OTHER tree's leases by
    // construction: a driver can legitimately move to a different worktree
    // (this tree's died, a successor started fresh elsewhere), and a pass
    // left running in the OLD tree — which holds no lease of its own here —
    // must still see that successor's live lease to refuse correctly.
    // Without the PR-wide search, `leaseRefsForActor` finds zero candidates
    // under THIS tree's own (nonexistent) lease and wrongly allows the post.
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const d = stateDirFor("pr-wide-foreign-tree");
      // A raw lease under a FOREIGN actor — never this test's own tree — is
      // the only way to exercise the cross-tree case without spawning a
      // second real worktree.
      putLease(leaseRef(d, "999", "wt-0000000000000face"), {
        pid: holder.pid,
        host: hostname(),
        worktree: "/tmp/some-other-worktree",
        command: "hold",
      });
      const r = await fence(d, ["--pr", "999"]);
      expect(r.exitCode).toBe(11);
      expect(r.stderr).toContain("DIFFERENT working tree");
      expect(r.stderr).toContain("/tmp/some-other-worktree");
      // With no PR named, the search stays actor-wide (no network round-trip
      // to spend discovering one) and does not see the foreign lease.
      expect((await fence(d, [])).exitCode).toBe(0);
    } finally {
      holder.kill();
    }
  });

  it("canonicalizes --pr with BigInt, not Number — no precision loss above 2^53", async () => {
    // `String(Number(pr))` is LOSSY past `Number.MAX_SAFE_INTEGER`
    // (9007199254740992): the next integer up, "9007199254740993", silently
    // rounds DOWN to "9007199254740992" under a float round-trip. A lossy
    // canonicalization would then search for the WRONG (rounded) PR, find no
    // lease under it, and allow the post past the real, live one.
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const d = stateDirFor("pr-bigint");
      const huge = "9007199254740993"; // Number.MAX_SAFE_INTEGER + 1
      seedLease(d, huge, holder.pid);
      const r = await fence(d, ["--pr", huge]);
      expect(r.exitCode).toBe(11);
      expect(r.stderr).toContain(`PR #${huge}`);
    } finally {
      holder.kill();
    }
  });

  it("defaults the PR to $DRIVE_PR_TARGET, which only a drive.ts pass has set", async () => {
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const d = stateDirFor("target");
      seedRawPrLease(d, "888", holder.pid);
      expect((await fence(d, [], { DRIVE_PR_TARGET: "999" })).exitCode).toBe(0);
      expect((await fence(d, [], { DRIVE_PR_TARGET: "888" })).exitCode).toBe(
        11,
      );
      // An explicit --pr wins over the environment: the flag is what a caller
      // that KNOWS its PR passes, and silently preferring the ambient value
      // would answer a different question than the one asked.
      expect(
        (await fence(d, ["--pr", "999"], { DRIVE_PR_TARGET: "888" })).exitCode,
      ).toBe(0);
    } finally {
      holder.kill();
    }
  });

  it("refuses a malformed --pr rather than widening to the whole tree", async () => {
    // Downgrading to the actor-wide check would answer a broader question than
    // the caller asked, and could report a refusal about a drive they never
    // named.
    const d = stateDirFor("bad-pr");
    const r = await fence(d, ["--pr", "nine-nine-nine"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--pr must be a number");
    expect((await fence(d, ["--what"])).exitCode).toBe(2);
    expect((await fence(d, ["--nope"])).exitCode).toBe(2);
  });

  it("allows when the state dir holds no lease at all", async () => {
    expect((await fence(stateDirFor("empty"), [])).exitCode).toBe(0);
  });

  it("fails CLOSED when the drive's database cannot be opened", async () => {
    // A gate that cannot read its input fails closed. A database path that
    // is a DIRECTORY cannot be opened at all — neither "no leases" nor "a
    // lease" — and the only safe reading of an unreadable answer, in front
    // of a mutation with no undo, is "do not post". Spawned here rather than
    // through `fence()`, which reads the identity from the database itself:
    // none can be read from a database that will not open, so the one a
    // driver would have exported is passed as it is.
    const d = stateDirFor("db-unopenable");
    mkdirSync(dbPathFor(d));
    for (const args of [["--pr", "999"], []]) {
      const r = Bun.spawnSync(
        scriptArgv(join(SCRIPTS, "assert-post-allowed.ts"), ...args),
        {
          env: {
            ...gitCleanEnv(),
            DRIVE_PR_STATE_DIR: d,
            DRIVE_PR_STATE_DIR_IDENTITY: "an-instance-this-drive-opened",
            DRIVE_PR_SESSION: String(process.pid),
            DRIVE_PR_SESSION_STARTED: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expectSpawnExit(r, 1, args.join(" ") || "(no PR)");
      expect(r.stderr.toString()).toContain("cannot be opened");
    }
  });

  it("still allows when the enumerated lease is genuinely GONE", async () => {
    // A `clear-lease` or `reset` that removed the lease means nobody is
    // driving, which is the documented revoked-without-successor residual:
    // a lease that is not there is not a refusal.
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const d = stateDirFor("vanished");
      seedLease(d, "999", holder.pid);
      expect((await fence(d, ["--pr", "999"])).exitCode).toBe(11);
      for (const ref of leaseRefsFor(d, "999")) removeLease(ref);
      // "Genuinely gone" has to mean gone on BOTH axes: `seedLease` claims a
      // TREE lease too, which the removed per-PR lease alone does not touch,
      // and the tree fence does not narrow by `--pr` — so without this, a
      // still-alive `holder` would leave the tree lease live and this
      // assertion would refuse for a reason unrelated to what it tests.
      // Awaited, not just signalled: a `pidAlive` check on a
      // killed-but-not-yet-reaped process can still see it as running.
      holder.kill();
      await holder.exited;
      expect((await fence(d, ["--pr", "999"])).exitCode).toBe(0);
    } finally {
      holder.kill();
    }
  });

  it("fails CLOSED when the git probe fails for an OPERATIONAL reason", async () => {
    // With `git` off $PATH the probe fails, and reading that failure as "no
    // drive state" would exit 0 having checked no lease at all.
    //
    // No $DRIVE_PR_STATE_DIR: the override short-circuits the probe, so
    // setting it would test nothing. cwd is this repo, which IS a repository —
    // the only thing broken is git's reachability.
    // Spawned through the ABSOLUTE runtime, not the shebang: `#!/usr/bin/env
    // bun` needs $PATH to find bun too, so an emptied $PATH would kill the
    // script before it ever probed git — a probe that asserts nothing about
    // the fence.
    const broken = Bun.spawn(
      [
        process.execPath,
        join(SCRIPTS, "assert-post-allowed.ts"),
        "--pr",
        "999",
      ],
      {
        env: {
          ...gitCleanEnv(),
          PATH: "/nonexistent",
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_STATE_DIR: "",
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [stderr, code] = await Promise.all([
      new Response(broken.stderr).text(),
      broken.exited,
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("exited 127");

    // And the case it must NOT swallow with it: genuinely outside a
    // repository still posts, because no drive state can exist there. Run
    // from a temp dir with a working git, so the ONLY difference from the
    // probe above is which failure git produced.
    const outside = mkdtempSync(join(tmpdir(), "fence-outside-repo-"));
    const ok = Bun.spawn(
      scriptArgv(join(SCRIPTS, "assert-post-allowed.ts"), "--pr", "999"),
      {
        cwd: outside,
        env: {
          ...gitCleanEnv(),
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_STATE_DIR: "",
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    await expectSpawnExited(ok, 0);
  });

  it("refuses when the `.git` marker EXISTS but the filesystem cannot resolve it", async () => {
    // The filesystem census that decides whether a repository is in play
    // must not trust `existsSync`, which reports `false` for confirmed
    // absence and for indeterminate failure alike. A drive writes a live
    // lease and the marker THEN becomes a broken symlink (or an ancestor
    // becomes unsearchable); a walk on `existsSync` runs to the root,
    // concludes no repository is in play, and the POST is authorised without
    // the still-live lease ever being read.
    //
    // A broken symlink is the uid-independent half of that pair — an EACCES
    // fixture asserts nothing when the suite runs as root, which CI may.
    // `existsSync` follows the link and reports false; `lstat` succeeds,
    // because the marker entry plainly exists.
    //
    // Every OTHER clause of the fence's fail-closed conjunction is satisfied so
    // that `repositoryIsInPlay` is the sole decider: $DRIVE_PR_STATE_DIR is
    // empty so the override cannot short-circuit the probe, git is on $PATH and
    // runs cleanly, and it exits 128 "not a git repository" — measured — so
    // `stateDir` is empty and `timedOut` is false.
    const lost = mkdtempSync(join(tmpdir(), "fence-marker-lost-"));
    symlinkSync("/nonexistent/gitdir-target", join(lost, ".git"));

    // The entry exists, and `existsSync` still says it does not: the exact
    // discrepancy a fence on `existsSync` would resolve in favour of posting.
    expect(existsSync(join(lost, ".git"))).toBe(false);
    expect(() => lstatSync(join(lost, ".git"))).not.toThrow();

    const refused = Bun.spawn(
      scriptArgv(join(SCRIPTS, "assert-post-allowed.ts"), "--pr", "999"),
      {
        cwd: lost,
        env: {
          ...gitCleanEnv(),
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_STATE_DIR: "",
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [stderr, code] = await Promise.all([
      new Response(refused.stderr).text(),
      refused.exited,
    ]);
    expect(code).not.toBe(0);
    // Specifically the "this IS a repository, so the lease is unknown" refusal,
    // so a regression that merely refused for an unrelated reason cannot pass.
    expect(stderr).toContain("this IS a repository");
  });

  it('refuses a git fatal that is NOT "no repository", inside a repository', async () => {
    // Exit 128 is git's GENERIC fatal status — dubious ownership, permissions,
    // corruption — so reading it as "no repository, therefore no lease" is the
    // same fail-open as reading a missing binary that way, one step narrower.
    // The reachable failure: a drive writes a live lease, the
    // repository THEN becomes unreadable, and the lease is still sitting there.
    //
    // An invalid `GIT_DIR` produces a 128 that is emphatically not "there is no
    // repository here" — cwd is this repo throughout.
    const broken = Bun.spawn(
      [
        process.execPath,
        join(SCRIPTS, "assert-post-allowed.ts"),
        "--pr",
        "999",
      ],
      {
        env: {
          ...gitCleanEnv(),
          GIT_DIR: "/nonexistent/definitely-not-a.git",
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_STATE_DIR: "",
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [stderr, code] = await Promise.all([
      new Response(broken.stderr).text(),
      broken.exited,
    ]);
    expect(code).not.toBe(0);
    // Specifically the 128 path, so a regression that merely refused for some
    // other reason cannot pass this.
    expect(stderr).toContain("exited 128");
    expect(stderr).toContain("IS a repository");
  });
});
