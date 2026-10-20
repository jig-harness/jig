/**
 * drive-pr suite: drive-status.ts: terminal states, drafts, conflicts and the measured false-convergence modes.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join, delimiter } from "node:path";

import { inspect } from "../scripts/drive";

import {
  SCRIPTS,
  tmpRoot,
  binDir,
  scratchClean,
  scratchOther,
  gitCleanEnv,
  makeScratchRepo,
  writeFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

useDrivePrSuite();

describe("inspect — an unreadable directory is not a confirmed empty claim set", () => {
  // `claimWasTakenOver([], ...)` is deliberately `true` (the "vanished claim
  // set" case just above) — a genuine, successfully-read empty directory
  // really is a takeover signal. The bug this covers is upstream of that
  // decision: `inspect()` used to fold a `readdirSync` failure (a transient
  // permission/I/O/filesystem error) into the identical `claimNames: []`
  // shape, so its caller could not tell "confirmed empty" from "could not
  // read it" and called `claimWasTakenOver` on the ambiguous result either
  // way — reading a transient read failure as proof of takeover and
  // aborting a live drive for it.
  //
  // `process.getuid`-gated: on a container that runs tests as root, `chmod
  // 000` does not block root's own `readdirSync`, so the directory would read
  // successfully and the fixture would not exercise the failure path at all.
  const canDropOwnPermissions =
    typeof process.getuid === "function" && process.getuid() !== 0;

  it.skipIf(!canDropOwnPermissions)(
    "reports unreadable, with an empty claim set, when readdirSync itself throws",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "drive-pr-inspect-unreadable-"));
      try {
        chmodSync(dir, 0o000);
        const occupant = inspect(dir);
        expect(occupant.unreadable).toBe(true);
        expect(occupant.claimNames).toEqual([]);
        expect(occupant.claim).toBeNull();
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );

  it("reports NOT unreadable for a confirmed, successfully-read empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-pr-inspect-empty-"));
    const occupant = inspect(dir);
    expect(occupant.unreadable).toBe(false);
    expect(occupant.claimNames).toEqual([]);
  });
});

describe("drive-status.ts measures local HEAD in the tree being driven", () => {
  /**
   * A gate with NO `--head`, so the measurement path itself is what runs —
   * `probeIn` always supplies one, which is exactly the path these probes must
   * not take. `cwd` and the anchor env var are the two variables.
   */
  async function measureFrom(
    cwd: string,
    env: Record<string, string> = {},
    extraArgs: string[] = [],
  ): Promise<{ local: string; localSource: string; stderr: string }> {
    const { dir, stateDir } = writeFixture({ threads: [] });
    const proc = Bun.spawn(
      scriptArgv(
        join(SCRIPTS, "drive-status.ts"),
        "999",
        "--json",
        "--once",
        ...extraArgs,
      ),
      {
        cwd,
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          ...env,
          // A driver names its tree in git's own spelling (symlinks and 8.3
          // short names resolved), which is what the script compares it to.
          ...(env.DRIVE_PR_WORKTREE === undefined
            ? {}
            : {
                DRIVE_PR_WORKTREE: realpathSync.native(env.DRIVE_PR_WORKTREE),
              }),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const json = out.trim() ? JSON.parse(out) : {};
    const head = (json.head ?? {}) as Record<string, unknown>;
    return {
      local: String(head.local ?? ""),
      localSource: String(head.localSource ?? ""),
      stderr,
    };
  }

  it("refuses to measure from inside a git DIRECTORY, rather than reporting the main worktree’s head", async () => {
    // The measured wedge: a pass's shell cwd persists across tool calls, and
    // the state dir it legitimately reads — driver log, durable state — IS the
    // git common dir. One `cd` there and `git rev-parse HEAD` answers for the
    // MAIN worktree (`develop` in a Conductor checkout), so the gate reported
    // HEAD_LAG against a head that could never arrive: the pass did nothing,
    // round after round, while the driver counted each one.
    const r = await measureFrom(join(scratchClean.dir, ".git"));
    // Unreadable beats wrong: `unavailable` disarms the head-sync guard and
    // produces no stall fingerprint, where a confident wrong SHA wedges it.
    expect(r.localSource).toBe("unavailable");
    expect(r.local).toBe("");
    expect(r.stderr).toContain("outside a working tree");
  });

  it("measures in $DRIVE_PR_WORKTREE when the driver named one, whatever the cwd", async () => {
    // The anchor drive.ts exports. Same poisoned cwd as above; the difference
    // is that the driver said which tree it drives, so the reading is that
    // tree's head rather than a refusal.
    const r = await measureFrom(join(scratchClean.dir, ".git"), {
      DRIVE_PR_WORKTREE: scratchClean.dir,
    });
    expect(r.localSource).toBe("git");
    expect(r.local).toBe(scratchClean.head);
  });

  it("still measures the cwd’s own head when it IS a worktree and no anchor is set", async () => {
    // The ordinary interactive case must not be collateral: no anchor, a cwd
    // that is a real working tree, and the reading is that tree's head.
    const r = await measureFrom(scratchClean.dir);
    expect(r.localSource).toBe("git");
    expect(r.local).toBe(scratchClean.head);
  });

  it("reports --no-head-sync as `disabled`, distinct from a measurement that FAILED", async () => {
    // The two empty-`local` shapes are not interchangeable, and only this
    // publishes the opt-out one. A caller declining to COMPARE the local head
    // is not a caller asserting no local commit happened — so `disabled` must
    // reach the report as its own value, where `roundFingerprint` refuses it
    // alongside `unavailable` (asserted there directly) and the drive falls
    // through to --max-rounds instead of stopping on sameness it never
    // witnessed.
    //
    // From a REAL worktree, so the reading is `disabled` because the flag said
    // so and not because the measurement had nowhere to run — the probe above
    // shows this same cwd measures `git` without the flag, which is what makes
    // this one non-vacuous. It replaces the end-to-end half of a `drive.ts`
    // stall probe that spent ~12.9s establishing the same fact through three
    // full rounds.
    const r = await measureFrom(scratchClean.dir, {}, ["--no-head-sync"]);
    expect(r.localSource).toBe("disabled");
    expect(r.local).toBe("");
  });

  /**
   * A "main" repo plus a LINKED worktree off it — the real relationship a
   * Conductor checkout has to its origin repo (`git worktree add`), not two
   * independent `git init`s. The env-leak mismeasurement needs this exact
   * shape: the linked worktree's gitdir lives under the main repo's
   * `.git/worktrees/<name>`, and a git-hook env leak (`GIT_DIR`+
   * `GIT_WORK_TREE`, lefthook exports both) points at a tree of that shape —
   * a normal, non-bare worktree that `--is-inside-git-dir` answers `false`
   * for, same as the tree being driven. `linked` gets its own extra commit so
   * its head provably differs from `main`'s and from any sibling linked
   * worktree's — a probe that can't tell the trees apart by SHA can't prove
   * which one a mismeasurement actually read.
   */
  function makeMainPlusLinkedWorktree(name: string): {
    mainDir: string;
    mainHead: string;
    linkedDir: string;
    linkedHead: string;
  } {
    const mainRepo = makeScratchRepo(`${name}-main`);
    const linkedDir = join(tmpRoot, `${name}-linked`);
    const env = gitCleanEnv();
    const git = (cwd: string, ...args: string[]) =>
      Bun.spawnSync(["git", ...args], {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
    git(
      mainRepo.dir,
      "worktree",
      "add",
      "-q",
      "-b",
      `${name}-branch`,
      linkedDir,
    );
    writeFileSync(join(linkedDir, "linked.txt"), `${name}\n`);
    git(linkedDir, "add", "-A");
    git(linkedDir, "commit", "-qm", `linked ${name}`, "--no-verify");
    const linkedHead = git(linkedDir, "rev-parse", "HEAD")
      .stdout.toString()
      .trim();
    return {
      mainDir: mainRepo.dir,
      mainHead: mainRepo.head,
      linkedDir,
      linkedHead,
    };
  }

  /** The linked worktree's OWN gitdir — `.git/worktrees/<name>` — not the shared common one. */
  function absoluteGitDir(dir: string): string {
    return Bun.spawnSync(["git", "rev-parse", "--absolute-git-dir"], {
      cwd: dir,
      env: gitCleanEnv(),
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
  }

  it("acceptance: a leaked GIT_DIR/GIT_WORK_TREE pointed at the MAIN worktree never reports its SHA as trustworthy — the sanitized read recovers the LINKED worktree's own HEAD instead", async () => {
    const { mainDir, mainHead, linkedDir, linkedHead } =
      makeMainPlusLinkedWorktree("wt-main");
    expect(linkedHead).not.toBe(mainHead);
    // The driver names the LINKED worktree as the tree to drive; the leak used
    // to make every git call in this process answer for the MAIN worktree
    // instead. Stripping GIT_DIR/GIT_WORK_TREE (and the rest of
    // GIT_LOCATION_VARS) from the measurement calls' own env neutralizes the
    // leak at the source, so the read correctly falls back to ordinary
    // cwd-based discovery from `linkedDir` rather than merely detecting the
    // poisoning and refusing (the toplevel-identity check alone cannot catch a
    // GIT_DIR-only leak, since without GIT_WORK_TREE git treats cwd itself as
    // the worktree root).
    const r = await measureFrom(linkedDir, {
      DRIVE_PR_WORKTREE: linkedDir,
      GIT_DIR: absoluteGitDir(mainDir),
      GIT_WORK_TREE: mainDir,
    });
    expect(r.localSource).toBe("git");
    expect(r.local).toBe(linkedHead);
    expect(r.local).not.toBe(mainHead);
  });

  it("acceptance: a leaked GIT_DIR/GIT_WORK_TREE pointed at a SIBLING linked worktree never reports its SHA as trustworthy — the sanitized read recovers the driven worktree's own HEAD instead", async () => {
    const { mainDir, linkedDir, linkedHead } =
      makeMainPlusLinkedWorktree("wt-sib-a");
    const siblingDir = join(tmpRoot, "wt-sib-b");
    const env = gitCleanEnv();
    Bun.spawnSync(
      ["git", "worktree", "add", "-q", "-b", "wt-sib-b-branch", siblingDir],
      { cwd: mainDir, env, stdout: "pipe", stderr: "pipe" },
    );
    writeFileSync(join(siblingDir, "sibling.txt"), "sibling\n");
    Bun.spawnSync(["git", "add", "-A"], {
      cwd: siblingDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    Bun.spawnSync(["git", "commit", "-qm", "sibling commit", "--no-verify"], {
      cwd: siblingDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const siblingHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: siblingDir,
      env,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    expect(siblingHead).not.toBe(linkedHead);

    const r = await measureFrom(linkedDir, {
      DRIVE_PR_WORKTREE: linkedDir,
      GIT_DIR: absoluteGitDir(siblingDir),
      GIT_WORK_TREE: siblingDir,
    });
    expect(r.localSource).toBe("git");
    expect(r.local).toBe(linkedHead);
    expect(r.local).not.toBe(siblingHead);
  });

  it("acceptance: a leaked GIT_DIR/GIT_WORK_TREE pointed at an UNRELATED checkout never reports its SHA as trustworthy — the sanitized read recovers the driven checkout's own HEAD instead", async () => {
    // scratchClean and scratchOther share no history at all — the third
    // acceptance shape, distinct from a main checkout or a sibling linked
    // worktree of the SAME repo.
    const r = await measureFrom(scratchClean.dir, {
      DRIVE_PR_WORKTREE: scratchClean.dir,
      GIT_DIR: join(scratchOther.dir, ".git"),
      GIT_WORK_TREE: scratchOther.dir,
    });
    expect(r.localSource).toBe("git");
    expect(r.local).toBe(scratchClean.head);
    expect(r.local).not.toBe(scratchOther.head);
  });

  it("acceptance: a GIT_DIR-only leak, with NO GIT_WORK_TREE, never reports the foreign SHA as trustworthy", async () => {
    // The shape the toplevel-identity check alone cannot catch: without
    // GIT_WORK_TREE, git treats the CURRENT DIRECTORY as the worktree root,
    // so `--show-toplevel` resolves to `linkedDir` (matching the anchor)
    // even while GIT_DIR points `rev-parse HEAD` at the MAIN worktree's
    // history — the old mismatch-only guard would have accepted `mainHead`
    // as trustworthy here. Sanitizing GIT_DIR out of the measurement calls'
    // own env closes it: HEAD is read via ordinary cwd-based discovery from
    // `linkedDir` instead.
    const { mainDir, mainHead, linkedDir, linkedHead } =
      makeMainPlusLinkedWorktree("wt-gitdir-only");
    expect(linkedHead).not.toBe(mainHead);
    const r = await measureFrom(linkedDir, {
      DRIVE_PR_WORKTREE: linkedDir,
      GIT_DIR: absoluteGitDir(mainDir),
    });
    expect(r.localSource).toBe("git");
    expect(r.local).toBe(linkedHead);
    expect(r.local).not.toBe(mainHead);
  });

  /** A `git` stub that hangs on ONE subcommand and delegates every other call
   * to the real binary — same shape as the `announce-merge-ready.ts` timeout
   * probes above, applied here to the measurement calls this describe
   * block owns.
   *
   * The hang is far longer than the bound the probes assert: on Windows a
   * deadlined call settles only after the verified tree stop (grace, then
   * native process snapshots), several seconds per call, so the bound must
   * sit well clear of that cost and still well under the hang it rules out. */
  const HANG_SEC = 120;
  const BOUND_MS = 45_000;
  const PROBE_TIMEOUT_MS = 60_000;
  function makeHangingGitStub(hangsOn: string[]): string {
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("no git on PATH to wrap for this probe");
    const dir = mkdtempSync(join(tmpdir(), "drive-pr-git-hang-stub-"));
    const stubPath = join(dir, "git");
    const cond = hangsOn
      .map((arg, i) => `[ "\${${i + 1}:-}" = "${arg}" ]`)
      .join(" && ");
    writeFakeProgram(
      stubPath,
      [
        "#!/usr/bin/env bash",
        `if ${cond}; then`,
        `  sleep ${HANG_SEC}`,
        "  exit 0",
        "fi",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
    );
    return dir;
  }

  it(
    "the local-HEAD `rev-parse HEAD` read refuses on a TIMEOUT rather than hanging",
    async () => {
      // Neither of this describe block's two `git()` calls carried a deadline —
      // `git()` is undeadlined by default on the premise that a local call
      // cannot hang the way a network one can, but a stalled FUSE/NFS mount or
      // a held filesystem lock defeats that premise, and this read feeds a
      // fail-closed guard that must not block forever waiting to fail closed.
      const gitStubDir = makeHangingGitStub(["rev-parse", "HEAD"]);
      const started = Date.now();
      const r = await measureFrom(scratchClean.dir, {
        DRIVE_PR_WORKTREE: scratchClean.dir,
        GIT_CALL_TIMEOUT: "1",
        PATH: `${gitStubDir}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
      });
      const elapsed = Date.now() - started;
      expect(r.localSource).toBe("unavailable");
      expect(r.local).toBe("");
      expect({ boundedWellUnderTheHang: elapsed < BOUND_MS }).toEqual({
        boundedWellUnderTheHang: true,
      });
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    "the local-HEAD `rev-parse --show-toplevel` identity check refuses on a TIMEOUT rather than hanging",
    async () => {
      const gitStubDir = makeHangingGitStub(["rev-parse", "--show-toplevel"]);
      const started = Date.now();
      const r = await measureFrom(scratchClean.dir, {
        DRIVE_PR_WORKTREE: scratchClean.dir,
        GIT_CALL_TIMEOUT: "1",
        PATH: `${gitStubDir}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
      });
      const elapsed = Date.now() - started;
      // `rev-parse HEAD` still succeeds (real git, real SHA) before the
      // identity check's own `--show-toplevel` call hangs — so this pins the
      // SECOND call's deadline specifically, distinct from the probe above.
      expect(r.localSource).toBe("unavailable");
      expect(r.local).toBe("");
      expect({ boundedWellUnderTheHang: elapsed < BOUND_MS }).toEqual({
        boundedWellUnderTheHang: true,
      });
    },
    PROBE_TIMEOUT_MS,
  );
});
