import { writeFileSync } from "node:fs";

import { join, delimiter } from "node:path";

import {
  SCRIPTS,
  type Fixture,
  binDir,
  scratchClean,
  gitCleanEnv,
  writeFixture,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

export function createFindingsResolveHeldFixtures() {
  // `resolve-thread.ts`'s mutation is unconditional — no notion of which push
  // justifies a resolve. This wrapper is what SKILL.md § 6 calls instead for a
  // held thread; these probes need BOTH a drive-state.ts state dir (to seed
  // `hold`/`bump-round`) and a gh/git fixture (to satisfy the --pushed-sha
  // checks) — a combination neither the `drive-state.ts durability` probes
  // (state only) nor the `answer-summary-finding.ts` probes (gh/git only, no
  // state) exercise on their own.

  /**
   * The state these probes stand `resolve-held-thread.ts` up against — the
   * earlier steps of the SAME pass (§ 1's `bump-round`, § 3's `hold`, § 6's
   * `set-verified`), not another driver's work.
   *
   * So it runs in the working tree the probe then resolves from. Inheriting
   * the suite's own cwd — the real repository — while `resolveHeld` runs in a
   * scratch repo would make the seed and the action two different ACTORS, and
   * PR-wide admission would refuse the action with exit 13 under the seed's
   * live lease. The gate is right: one tree drives one PR, and a probe that
   * straddles two models a state production cannot reach.
   *
   * `gitCleanEnv`, and a handoff dir under the per-test state dir, for the two
   * reasons `resolveHeld` already documents: a git hook exports `GIT_DIR`, and
   * an unset `$DRIVE_PR_HANDOFF_DIR` writes `.context/` into whichever scratch
   * repo the cwd names — `scratchClean` is SHARED, so that dirties it for
   * every later probe's clean-tree check.
   */
  async function seed(
    stateDir: string,
    args: string[],
    stdin?: string,
    cwd: string = scratchClean.dir,
    /**
     * Seed at ladder tier 3 — no session identity. Only for the probe that
     * deliberately seeds from a DIFFERENT tree than it resolves from: that
     * state is reachable by TAKEOVER (the seeding tree stops, another is
     * admitted and works the batch), and a takeover means the predecessor is
     * precisely NOT still holding the PR.
     *
     * Tier 3 leaves a `worktree`-held lease like any other
     * holder, so that "stops" has to be PERFORMED — `seedDone` below is where
     * — rather than being implied by the absence of an artefact. A pid-less
     * holder has no process whose exit could stand for it.
     */
    sessionless = false,
  ) {
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "drive-state.ts"), ...args),
      {
        cwd,
        env: {
          ...gitCleanEnv(),
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_HANDOFF_DIR: join(stateDir, "handoff"),
          ...(sessionless ? { DRIVE_PR_SESSION: "", CLAUDE_PID: "" } : {}),
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
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`seed failed: ${args.join(" ")}\n${stderr}`);
    }
  }

  /**
   * The seeding tree stops driving, so the resolving tree may be admitted.
   *
   * The takeover premise `seed`'s `sessionless` flag describes, made explicit
   *. It drops the lease and nothing else — the holds it seeded are
   * the whole point and stay exactly where they are, which is what makes them
   * a promise the NEXT tree inherits rather than state it wrote itself.
   */
  async function seedDone(stateDir: string, cwd: string) {
    await seed(stateDir, ["clear-lease", "999"], undefined, cwd, true);
  }

  async function readState(stateDir: string, args: string[]) {
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "drive-state.ts"), ...args),
      {
        env: { ...process.env, DRIVE_PR_STATE_DIR: stateDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`readState failed: ${args.join(" ")}`);
    }
    return stdout.trim();
  }

  async function resolveHeld(
    stateDir: string,
    args: string[],
    opts: {
      head?: string;
      cwd?: string;
      resolveThreadFails?: boolean;
      threads?: Fixture["threads"];
      /** Content-bearing fixture flag files — name → content, written into
       * the fixture dir before spawning. Used by the stub's opt-in branches
       * (e.g. `rehold-key-after-first-noderead`, `reopen-on-second-noderead`). */
      fixtureFiles?: Record<string, string>;
    } = {},
  ) {
    const { dir } = writeFixture({
      ...(opts.head ? { head: opts.head } : {}),
      ...(opts.threads ? { threads: opts.threads } : {}),
    });
    if (opts.resolveThreadFails) {
      writeFileSync(join(dir, "resolve-thread-fails"), "");
    }
    for (const [name, content] of Object.entries(opts.fixtureFiles ?? {})) {
      writeFileSync(join(dir, name), content);
    }
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "resolve-held-thread.ts"), ...args, "999"),
      {
        cwd: opts.cwd,
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          // claim-held mutates state, so — like every other
          // state-mutating probe in this file — it regenerates a handoff file
          // via `git rev-parse --show-toplevel`. Left unset, that resolves to
          // whichever scratch repo `cwd` points at (scratchClean/scratchOther
          // are SHARED across tests), writing an untracked `.context/` into
          // it that then fails every LATER test's dirty-tree check in that
          // same repo. Point it at the fixture's own scratch dir instead.
          DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
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
    const resolved = await Bun.file(join(dir, "resolved-threads.jsonl"))
      .text()
      .catch(() => "");
    return { stdout: stdout.trim(), stderr, exitCode, resolved };
  }

  /**
   * A thread fixture whose latest comment is a real trusted `**accepted**`
   * reply —
   * NOT the bare synthetic single "finding" comment `{ id, bot: true }`
   * alone produces, which is no longer sufficient once `resolve-held-
   * thread.ts` re-verifies the latest comment's own outcome, not merely its
   * url. Pair with `ACCEPTED_COMMENT_URL` as the `hold --comment-url`.
   */
  function acceptedReplyThread(
    id: string,
  ): NonNullable<Fixture["threads"]>[number] {
    return {
      id,
      bot: true,
      comments: [
        { authorAssociation: "NONE", body: "a finding" },
        {
          author: "example-user-2",
          authorAssociation: "OWNER",
          body: "**accepted** — fixed.",
        },
      ],
    };
  }

  const ACCEPTED_COMMENT_URL = "https://example.invalid/PRRT_a/comment-1";
  return {
    seed,
    seedDone,
    readState,
    resolveHeld,
    acceptedReplyThread,
    ACCEPTED_COMMENT_URL,
  };
}
