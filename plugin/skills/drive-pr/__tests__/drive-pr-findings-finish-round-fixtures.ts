/**
 * drive-pr suite: answer-summary-finding.ts, assert-post-allowed.ts, resolve-held-thread.ts, finish-round.ts and list-unresolved-threads.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { expect } from "bun:test";

import { mkdirSync } from "node:fs";

import { join, delimiter } from "node:path";

import { stateDirIdentityToken } from "../scripts/lib/state/lease";

import {
  SCRIPTS,
  GIT_PUSH_FLAG_GUARD,
  type Fixture,
  binDir,
  gitCleanEnv,
  makeScratchRepo,
  writeFixture,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

export function createFindingsFinishRoundFixtures() {
  const finishSequence = { value: 0 };

  /**
   * A `git` on PATH that RECORDS a `push` instead of performing one, and
   * delegates every other subcommand to the real binary.
   *
   * The alternative — the fully-stubbed `git` the `guarded-push.ts` block uses
   * — cannot serve these probes: they need `rev-parse HEAD`, `status
   * --porcelain` and the git-dir marker probe to answer TRUTHFULLY about a
   * real scratch repository, because "did it refuse before pushing" is a claim
   * about those answers. Intercepting only `push` keeps every one of them real
   * while leaving the one irreversible act observable as a file.
   */
  function recordingGit(dir: string, pushLog: string): string {
    const real = Bun.which("git");
    if (real === null) throw new Error("no real git on PATH");
    const bin = join(dir, "gitbin");
    mkdirSync(bin, { recursive: true });
    const p = join(bin, "git");
    writeFakeProgram(
      p,
      [
        "#!/usr/bin/env bash",
        'if [ "${1:-}" = "push" ]; then',
        `  ${GIT_PUSH_FLAG_GUARD}`,
        `  printf '%s\\n' "$*" >> ${JSON.stringify(pushLog)}`,
        '  echo "   abc..def  HEAD -> main"',
        "  exit 0",
        "fi",
        `exec ${JSON.stringify(real)} "$@"`,
        "",
      ].join("\n"),
    );
    return bin;
  }

  /**
   * A scratch repo with an `origin` whose owner/name match the fixture PR's
   * head repository — `guarded-push.ts` compares those before it pushes, and a
   * repo with no remote at all would be refused for a reason none of these
   * probes is about.
   */
  function scratchWithOrigin(): { dir: string; head: string } {
    const r = makeScratchRepo(`finish-round-${++finishSequence.value}`);
    Bun.spawnSync(
      [
        "git",
        "remote",
        "add",
        "origin",
        "git@github.com:example-org/example-repo.git",
      ],
      { cwd: r.dir, env: gitCleanEnv(), stdout: "pipe", stderr: "pipe" },
    );
    // `refs/remotes/origin/develop`, pointing at `makeScratchRepo`'s FIRST
    // commit (HEAD~1) — every real worktree has this fetched, and the
    // untriaged-thread guard's `roundBase` falls back to
    // `git merge-base origin/develop HEAD` whenever no verified SHA is
    // recorded, which is the common case for these probes (none of them call
    // `set-verified` before reaching the guard unless a test explicitly
    // does). Without this ref that fallback fails outright in a scratch repo
    // that never fetched anything, and the guard would refuse EVERY probe
    // below with TRIAGE_CHECK_FAILED — including the ones that have nothing
    // to do with triage — rather than only the ones it exists to catch.
    const headParentRes = Bun.spawnSync(["git", "rev-parse", "HEAD~1"], {
      cwd: r.dir,
      env: gitCleanEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const headParent = headParentRes.stdout.toString().trim();
    // Assert both setup calls actually succeeded — a failed `rev-parse` would
    // silently hand `update-ref` an empty ref name, and a failed `update-ref`
    // would leave `origin/develop` unset, both producing a repo shape the
    // probes below assert against for the wrong reason.
    expect(headParentRes.exitCode).toBe(0);
    expect(headParent).not.toBe("");
    const updateRefRes = Bun.spawnSync(
      ["git", "update-ref", "refs/remotes/origin/develop", headParent],
      { cwd: r.dir, env: gitCleanEnv(), stdout: "pipe", stderr: "pipe" },
    );
    expect(updateRefRes.exitCode).toBe(0);
    return r;
  }

  function stateEnv(stateDir: string, fixtureDir: string) {
    return {
      ...gitCleanEnv(),
      DRIVE_PR_STATE_DIR: stateDir,
      // Required beside the override — an unaccompanied
      // `$DRIVE_PR_STATE_DIR` reads as a superseded driver and refuses.
      DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(stateDir),
      // An unset handoff dir writes `.context/` into whichever repo `cwd`
      // names, which then fails that repo's OWN clean-tree check on the very
      // next probe (`resolve-held-thread.ts`'s harness documents the same
      // trap).
      DRIVE_PR_HANDOFF_DIR: join(fixtureDir, "handoff"),
      // The identical trap, for the mailbox: `guarded-push.ts`'s hold-push
      // check takes the inbox lock, which creates `.context/drive-mailbox/` in
      // whichever repo `resolveMailboxDir()` resolves to when this env var
      // is unset — the scratch repo `cwd` here. That directory is untracked
      // in the scratch repo (unlike the real worktree, which gitignores
      // `.context/`), so it fails `resolve-held-thread.ts`'s and
      // `answer-summary-finding.ts`'s own dirty-tree check on the drain
      // that runs right after the push, the same way an unset
      // `DRIVE_PR_HANDOFF_DIR` used to.
      DRIVE_PR_MAILBOX_DIR: join(fixtureDir, "mailbox"),
      // set-ci-hold is test-only fixture seeding —
      // harmless to set unconditionally here since no other command reads
      // this variable.
      DRIVE_PR_ALLOW_TEST_CI_HOLD_SEED: "1",
    };
  }

  /** Run one `drive-state.ts` command against a probe's state, and require it. */
  async function seed(
    stateDir: string,
    fixtureDir: string,
    cwd: string,
    args: string[],
    stdin?: string,
  ): Promise<string> {
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "drive-state.ts"), ...args),
      {
        cwd,
        env: {
          ...stateEnv(stateDir, fixtureDir),
          PATH: process.env.PATH ?? "",
        },
        stdin: stdin !== undefined ? "pipe" : undefined,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (stdin !== undefined) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`seed failed: ${args.join(" ")}\n${stderr}`);
    }
    return stdout.trim();
  }

  interface FinishOpts {
    fixture?: Fixture;
    /** The tree the round is finished from. Defaults to a fresh scratch repo. */
    repo?: { dir: string; head: string };
    /** Reuse an EXISTING state dir instead of the fixture's fresh one. */
    stateDir?: string;
    /**
     * Reuse an EXISTING fixture dir, so a re-run sees the GitHub side an
     * earlier run left (labels, timeline, posted comments) rather than a
     * fresh PR that never carried them.
     */
    fixtureDir?: string;
    /** Runs against the state dir in force, from the probe's own tree. */
    seedState?: (ctx: {
      stateDir: string;
      fixtureDir: string;
      cwd: string;
    }) => Promise<void>;
    args?: string[];
  }

  async function finishRound(opts: FinishOpts = {}) {
    const repo = opts.repo ?? scratchWithOrigin();
    const { dir, stateDir: fresh } =
      opts.fixtureDir === undefined
        ? writeFixture({
            threads: [{ id: "PRRT_live", path: "a.ts", bot: true }],
            ...(opts.fixture ?? {}),
            head: repo.head,
          })
        : { dir: opts.fixtureDir, stateDir: undefined };
    const stateDir = opts.stateDir ?? fresh;
    if (stateDir === undefined)
      throw new Error("a reused fixture dir needs its state dir too");
    const pushLog = join(dir, "pushed.log");
    const gitBin = recordingGit(dir, pushLog);
    await opts.seedState?.({ stateDir, fixtureDir: dir, cwd: repo.dir });
    const proc = Bun.spawn(
      scriptArgv(
        join(SCRIPTS, "finish-round.ts"),
        "999",
        "--json",
        ...(opts.args ?? []),
      ),
      {
        cwd: repo.dir,
        env: {
          ...stateEnv(stateDir, dir),
          PATH: `${gitBin}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
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
    const read = async (name: string) =>
      await Bun.file(join(dir, name))
        .text()
        .catch(() => "");
    let report: Record<string, unknown> = {};
    try {
      report = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
    } catch {
      report = {};
    }
    return {
      exitCode,
      stdout,
      stderr,
      report,
      pushed: await read("pushed.log"),
      posted: await read("posted.jsonl"),
      resolved: await read("resolved-threads.jsonl"),
      stateDir,
      fixtureDir: dir,
      repo,
    };
  }
  return {
    finishSequence,
    recordingGit,
    scratchWithOrigin,
    stateEnv,
    seed,
    finishRound,
  };
}
