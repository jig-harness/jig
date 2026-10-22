/**
 * drive-pr suite: answer-summary-finding.ts, assert-post-allowed.ts, resolve-held-thread.ts, finish-round.ts and list-unresolved-threads.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { expectSpawnExited } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";

import { hostname, tmpdir } from "node:os";

import { join } from "node:path";

import { ExitError } from "../scripts/lib/cli";

import {
  assertRemoteMutationAllowed,
  leasePathFor,
} from "../scripts/lib/state/lease";

import { SCRIPTS, gitCleanEnv, useDrivePrSuite } from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { byPlatform } from "../../../../lib/test-helpers/windows-skip.ts";

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
    // identically to "999" — but a strict `===` against the lease filename's
    // own canonical PR segment would not match, silently narrowing this
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
    // Without the PR-wide search, `leaseFilesForActor` finds zero candidates
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
      const foreignPath = leasePathFor(d, "999", "wt-0000000000000face");
      writeFileSync(
        foreignPath,
        JSON.stringify({
          holder: "session",
          pid: holder.pid,
          host: hostname(),
          platform: process.platform,
          actor: "wt-0000000000000face",
          worktree: "/tmp/some-other-worktree",
          startedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          command: "hold",
          generation: "f".repeat(32),
          // Required — this fixture is about the CROSS-TREE
          // search, so it must parse cleanly and reach the holder-naming
          // refusal (11) rather than stopping at the unreadable one (1).
          sessionStarted: "",
        }),
      );
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
    // rounds DOWN to "9007199254740992" under a float round-trip. The old
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

  it("fails CLOSED when the inherited $DRIVE_PR_STATE_DIR has vanished", async () => {
    // Distinct from the "no lease at all" case above: there the fence
    // resolved a directory that legitimately may never have been created (no
    // drive has ever run here). An INHERITED override is a different claim —
    // `drive.ts` exports it only after establishing its own state, so the
    // directory necessarily existed a moment ago. If it is gone now (a
    // renamed git common dir, a moved worktree), that is an anomaly this
    // fence must not read as "no lease", or a pass whose inherited path went
    // stale mid-drive posts unfenced.
    const gone = join(mkdtempSync(join(tmpdir(), "fence-vanished-")), "state");
    // Deliberately never created — `mkdtempSync` made the PARENT, `state`
    // itself does not exist, which is the "existed, then moved away" shape an
    // override implies without this test paying for an actual rename.
    const r = await fence(gone, []);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("could not be read");
  });

  it("fails CLOSED when the inherited $DRIVE_PR_STATE_DIR is a dangling symlink", async () => {
    // A path-based `stat` alone would pass this — it follows the link and
    // fails only when actually asked to enumerate — but this fence now
    // enumerates the override directory as its OWN existence check
    // (`readdirSync` directly, no separate `stat` first): a dangling symlink
    // makes that same call fail with `ENOENT` on the real target, exactly
    // like the wholly-vanished case above.
    const parent = mkdtempSync(join(tmpdir(), "fence-symlink-"));
    const link = join(parent, "state-link");
    symlinkSync(join(parent, "state-target-does-not-exist"), link);
    const r = await fence(link, []);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      byPlatform(
        "native Windows reports ENOTDIR for enumeration through a dangling directory link",
        {
          windows: "ENOTDIR",
          posix: "could not be read",
        },
      ),
    );
  });

  it("fails CLOSED when the lease set cannot be enumerated", async () => {
    // A gate that cannot read its input fails closed. A state dir that is
    // a FILE makes `readdirSync` fail with ENOTDIR — neither "no leases" nor
    // "a lease" — and the only safe reading of an unreadable answer, in front
    // of a mutation with no undo, is "do not post".
    //
    // Asserted for the --pr path SPECIFICALLY, because that is the one a
    // direct `leasePathFor` read would have failed open on: `existsSync` of a
    // path under a file answers false, which is indistinguishable from a tree
    // that has never been driven.
    const notADir = join(mkdtempSync(join(tmpdir(), "fence-notadir-")), "f");
    writeFileSync(notADir, "not a directory\n");
    expect((await fence(notADir, ["--pr", "999"])).exitCode).not.toBe(0);
    expect((await fence(notADir, [])).exitCode).not.toBe(0);
  });

  it("fails CLOSED on a lease file it can enumerate but cannot READ", async () => {
    // The class one level below the probe above, and the half that was still
    // open: fencing the DIRECTORY while an unreadable FILE inside it read as
    // "no lease" and permitted the post.
    // `readLease` collapses absent and unreadable to the same `null`, which is
    // the right ruling for CLAIMING and the wrong one here.
    //
    // Both corruptions are exercised, because they take different paths in:
    // unparseable bytes fail the shape check, an unreadable mode fails the
    // open. Each is asserted separately so one regressing names itself.
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      for (const [label, corrupt] of [
        ["malformed JSON", (f: string) => writeFileSync(f, "{ not json")],
        ["a partial record", (f: string) => writeFileSync(f, '{"pid":123}')],
        // A DIRECTORY at the lease path, not `chmod 000`: mode bits are
        // ignored by root, so that fixture asserted the wrong branch (exit
        // 11, a valid live lease) on a root runner. `EISDIR` on the open is
        // uid-independent.
        [
          "a directory in its place",
          (f: string) => {
            rmSync(f);
            mkdirSync(f);
          },
        ],
      ] as const) {
        const d = stateDirFor(`unreadable-${label.replace(/\s+/g, "-")}`);
        seedLease(d, "999", holder.pid);
        const file = join(
          d,
          readdirSync(d).filter((f) =>
            /^pr-drive-lease-999-wt-[0-9a-f]{16}\.json$/.test(f),
          )[0] ?? "",
        );
        // The probe is only meaningful if the UNCORRUPTED lease refuses —
        // otherwise a fence that had stopped reading leases entirely would
        // pass the corrupted case for the wrong reason.
        expect({
          label,
          code: (await fence(d, ["--pr", "999"])).exitCode,
        }).toEqual({ label, code: 11 });
        corrupt(file);
        const r = await fence(d, ["--pr", "999"]);
        expect({ label, code: r.exitCode }).toEqual({ label, code: 1 });
        expect(r.stderr).toContain("could not be read");
      }
    } finally {
      holder.kill();
    }
  });

  it("still allows when the enumerated lease file is genuinely GONE", async () => {
    // The other side of the same read, and the reason it is not simply "any
    // null refuses": a `clear-lease` or `reset` landing between the
    // enumeration and the read means nobody is driving, which is the
    // documented revoked-without-successor residual, not an unreadable file.
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const d = stateDirFor("vanished");
      seedLease(d, "999", holder.pid);
      const file = join(
        d,
        readdirSync(d).filter((f) =>
          /^pr-drive-lease-999-wt-[0-9a-f]{16}\.json$/.test(f),
        )[0] ?? "",
      );
      expect((await fence(d, ["--pr", "999"])).exitCode).toBe(11);
      rmSync(file);
      // "Genuinely gone" now has to mean gone on BOTH axes: `seedLease` claims
      // a TREE lease too, which the removed per-PR file alone does
      // not touch, and the tree fence does not narrow by `--pr` — so without
      // this, a still-alive `holder` would leave the tree lease live and this
      // assertion would refuse for a reason unrelated to what it tests
      //. Awaited, not just signalled: a
      // `pidAlive` check on a killed-but-not-yet-reaped process can still see
      // it as running.
      holder.kill();
      await holder.exited;
      expect((await fence(d, ["--pr", "999"])).exitCode).toBe(0);
    } finally {
      holder.kill();
    }
  });

  it("fails CLOSED when the git probe fails for an OPERATIONAL reason", async () => {
    // Reproduced: with `git` off $PATH the probe failed, the failure was read
    // as "no drive state", and the fence exited 0 having checked no lease at
    // all.
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
    // The filesystem census that replaced the exit-128 check retained the same
    // temporal hole one step further in: `existsSync`
    // reports `false` for confirmed absence and for indeterminate failure
    // alike. A drive writes a live lease and the marker THEN becomes a broken
    // symlink (or an ancestor becomes unsearchable); the walk runs to the root,
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
    // discrepancy the fence used to resolve in favour of posting.
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

  describe("state-directory identity", () => {
    // `resolveFenceContext`'s override path freezes the NAME LIST from one
    // `readdirSync`, but `assertRemoteMutationAllowed` still has to OPEN each
    // candidate afterwards to learn who holds it — a genuine second
    // filesystem touch. Renaming the state directory away and creating an
    // EMPTY one at the same pathname raises no `ENOENT` anywhere that second
    // read could see: the enumerated name simply is not there anymore, and
    // `readLeaseForFence` reports `absent` for a lease that is still live in
    // the directory that moved.
    //
    // These probes call `assertRemoteMutationAllowed` directly, in-process,
    // with a hand-built `ctx` — the same shape `resolveFenceContext`'s
    // override branch returns — rather than spawning `assert-post-allowed.ts`
    // and racing it: the enumeration and the per-candidate read happen inside
    // ONE function call with no `await` between them, so a subprocess-level
    // race would depend on scheduling this suite cannot control. Calling the
    // real, exported function directly and performing the rename-and-recreate
    // between building `ctx` and invoking it reproduces the exact race
    // deterministically, on the real production code — matching lock.test.ts's
    // own convention of planting the directory state a race would have left
    // rather than trying to win one live.
    function foreignLeaseJson(actor: string): string {
      return JSON.stringify({
        holder: "session",
        pid: process.pid,
        host: hostname(),
        platform: process.platform,
        actor,
        worktree: "/some/other/tree",
        startedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        command: "hold",
        generation: "a".repeat(32),
        sessionStarted: "",
      });
    }

    it("fails CLOSED when the state directory is renamed away and replaced empty before a candidate lease is read", async () => {
      const parent = mkdtempSync(join(tmpdir(), "fence-rename-race-"));
      const stateDir = join(parent, "state");
      mkdirSync(stateDir);
      const foreignActor = "wt-0000000000000dea1";
      // This lease is genuinely LIVE: pid is this test's own process, which
      // is alive throughout, and `lastSeen` is fresh. If the fix silently
      // read the swap as "absent", this lease would still be live in the
      // directory that moved.
      writeFileSync(
        leasePathFor(stateDir, "999", foreignActor),
        foreignLeaseJson(foreignActor),
      );

      // What `resolveFenceContext`'s override branch would have captured:
      // the enumeration, and this directory's identity in the same breath.
      const overrideEntries = readdirSync(stateDir);
      // `statSync(..., { bigint: true })`, matching production: the identity
      // FOLLOWS symlinks and is BigInt-valued (since 64-bit dev/ino round
      // when read as numbers). Hand-building it from
      // `lstatSync`'s numeric fields would compare a rounded, link-scoped
      // identity against a followed BigInt one and never agree.
      const before = statSync(stateDir, { bigint: true });

      // The race: move the directory away — the live lease is still inside
      // it — and recreate an empty one at the exact same pathname. Neither
      // step raises ENOENT anywhere.
      const moved = `${stateDir}.moved-away`;
      renameSync(stateDir, moved);
      mkdirSync(stateDir);
      expect(
        existsSync(join(moved, `pr-drive-lease-999-${foreignActor}.json`)),
      ).toBe(true);
      expect(
        existsSync(join(stateDir, `pr-drive-lease-999-${foreignActor}.json`)),
      ).toBe(false);

      let threw: unknown;
      try {
        await assertRemoteMutationAllowed(
          {
            stateDir,
            actor: "wt-0000000000000m1ne",
            session: {
              pid: process.pid,
              host: hostname(),
              source: "CLAUDE_PID",
              sessionStarted: "",
            },
            fromOverride: true,
            overrideEntries,
            stateDirIdentity: { dev: before.dev, ino: before.ino },
          },
          "999",
          "test-fence",
        );
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(ExitError);
      expect((threw as ExitError).code).toBe(1);
      expect((threw as Error).message).toBe("exit 1");
    });

    it("fails CLOSED on the same swap even when NO candidate lease file matched (the final re-check)", async () => {
      // Zero matching candidates means the per-candidate `absent` re-check
      // above never runs at all — the loop body never executes — so the ONLY
      // thing standing between a swapped directory and a silent "allowed" is
      // the identity re-check `assertRemoteMutationAllowed` performs
      // immediately before it returns.
      const parent = mkdtempSync(join(tmpdir(), "fence-rename-race-empty-"));
      const stateDir = join(parent, "state");
      mkdirSync(stateDir);
      // Present, but matches no PR/actor prefix at all.
      writeFileSync(join(stateDir, "unrelated-file.json"), "{}");

      const overrideEntries = readdirSync(stateDir);
      // `statSync(..., { bigint: true })`, matching production: the identity
      // FOLLOWS symlinks and is BigInt-valued (since 64-bit dev/ino round
      // when read as numbers). Hand-building it from
      // `lstatSync`'s numeric fields would compare a rounded, link-scoped
      // identity against a followed BigInt one and never agree.
      const before = statSync(stateDir, { bigint: true });

      const moved = `${stateDir}.moved-away`;
      renameSync(stateDir, moved);
      mkdirSync(stateDir);

      let threw: unknown;
      try {
        await assertRemoteMutationAllowed(
          {
            stateDir,
            actor: "wt-0000000000000m1ne",
            session: {
              pid: process.pid,
              host: hostname(),
              source: "CLAUDE_PID",
              sessionStarted: "",
            },
            fromOverride: true,
            overrideEntries,
            stateDirIdentity: { dev: before.dev, ino: before.ino },
          },
          "999",
          "test-fence",
        );
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(ExitError);
      expect((threw as ExitError).code).toBe(1);
    });

    it("does NOT refuse when the directory is untouched (no false positive from the identity check)", async () => {
      // The regression guard: an ordinary, race-free call — same shape as
      // above but with no rename in between — must still allow, matching
      // every OTHER passing test in this describe block that exercises the
      // override path via the real `assert-post-allowed.ts` binary.
      const parent = mkdtempSync(join(tmpdir(), "fence-no-race-"));
      const stateDir = join(parent, "state");
      mkdirSync(stateDir);
      const overrideEntries = readdirSync(stateDir);
      // `statSync(..., { bigint: true })`, matching production: the identity
      // FOLLOWS symlinks and is BigInt-valued (since 64-bit dev/ino round
      // when read as numbers). Hand-building it from
      // `lstatSync`'s numeric fields would compare a rounded, link-scoped
      // identity against a followed BigInt one and never agree.
      const before = statSync(stateDir, { bigint: true });

      // Awaited directly, not wrapped in `expect(() => ...).not.toThrow()` —
      // that matcher only ever tests a SYNCHRONOUS call and would pass
      // vacuously against a rejected promise now that this function is
      // async: a thrown `ExitError` inside the promise never
      // reaches the synchronous try/catch `toThrow()` builds internally, so
      // it would report "did not throw" regardless of the outcome. Letting
      // the rejection propagate out of this `it(..., async () => { ... })`
      // is what actually fails the test if this call refuses.
      //
      // The returned lock is captured and released — a formerly-void call
      // now resolves to a still-HELD `PathLock`, and discarding
      // it here would leave both the lock directory and `createLock`'s
      // process/signal listeners live for the rest of this test run.
      const lock = await assertRemoteMutationAllowed(
        {
          stateDir,
          actor: "wt-0000000000000m1ne",
          session: {
            pid: process.pid,
            host: hostname(),
            source: "CLAUDE_PID",
            sessionStarted: "",
          },
          fromOverride: true,
          overrideEntries,
          stateDirIdentity: { dev: before.dev, ino: before.ino },
        },
        "999",
        "test-fence",
      );
      lock?.release();
      lock?.dispose();
    });
  });
});
