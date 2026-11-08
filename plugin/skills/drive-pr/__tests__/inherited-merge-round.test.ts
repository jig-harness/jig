/**
 * drive-pr suite: a round that inherits a partial base merge, driven step by
 * step. A pull request conflicts with its base; an earlier pass merged the
 * base in, resolved the conflict and stopped before committing, leaving an
 * edit of its own beside it. Each step refuses that state correctly on its
 * own, so this follows the round's steps in order from it: the push refuses
 * the uncommitted tree, the validation plan plans the open merge (it is what
 * lets the pass validate before it commits), the pass concludes the merge
 * with a commit, and the push then lands the base merged with the work.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { createFindingsFinishRoundFixtures } from "./drive-pr-findings-finish-round-fixtures.ts";
import {
  SCRIPTS,
  gitCleanEnv,
  tmpRoot,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

useDrivePrSuite();

describe("a round that inherits an open merge of its base", () => {
  const { scratchWithOrigin, finishRound } =
    createFindingsFinishRoundFixtures();

  function git(dir: string, ...args: string[]): { code: number; out: string } {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env: gitCleanEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: r.exitCode,
      out: `${r.stdout.toString()}${r.stderr.toString()}`.trim(),
    };
  }

  function mustGit(dir: string, ...args: string[]): string {
    const r = git(dir, ...args);
    expect(`git ${args.join(" ")} → ${r.code}: ${r.out}`).toStartWith(
      `git ${args.join(" ")} → 0:`,
    );
    return r.out;
  }

  /** A pull request that has conflicted since it opened: no required check ever ran. */
  const conflicting = {
    fixture: { threads: [], mergeable: "CONFLICTING" },
    seedState: async ({ fixtureDir }: { fixtureDir: string }) => {
      writeFileSync(join(fixtureDir, "push-resolves-conflict"), "");
      writeFileSync(join(fixtureDir, "timeline.json"), "[]");
      const runsPath = join(fixtureDir, "check-runs.json");
      const runs = JSON.parse(readFileSync(runsPath, "utf8")) as {
        check_runs: Array<{ name: string }>;
      };
      runs.check_runs = runs.check_runs.filter(
        (run) =>
          !["code-quality-and-build", "tests", "Schema gate"].includes(
            run.name,
          ),
      );
      writeFileSync(runsPath, JSON.stringify(runs));
    },
  };

  /** `round-plan.ts --json` for pull request 999, whose base is `develop`. */
  async function roundPlan(dir: string) {
    const bin = mkdtempSync(join(tmpRoot, "inherited-merge-gh-"));
    writeFakeProgram(
      join(bin, "gh"),
      `#!/bin/sh
case "$*" in
  "pr view 999 --json baseRefName,url") echo '{"baseRefName":"develop","url":"https://github.com/example-org/example-repo/pull/999"}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`,
    );
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "round-plan.ts"), "999", "--json"),
      {
        cwd: dir,
        env: {
          ...gitCleanEnv(),
          PATH: `${bin}${delimiter}${process.env.PATH}`,
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

  it("ends with the base merged and the work committed and pushed", async () => {
    const repo = scratchWithOrigin();
    const { dir } = repo;
    // The suite's plan command, stubbed in the scratch repository and kept
    // out of its diff.
    mkdirSync(join(dir, "tools", "change-areas"), { recursive: true });
    writeFileSync(
      join(dir, "tools", "change-areas", "resolve.ts"),
      `await Bun.stdin.text();
process.stdout.write(JSON.stringify({ validation: { localChecks: ["make check"], verificationChecks: [], testbox: { required: false } }, reviewSkills: [] }));
`,
    );
    writeFileSync(join(dir, ".git", "info", "exclude"), "tools/\n");
    // The base moves on: a conflicting edit of the change's file, and a file
    // of its own.
    mustGit(dir, "checkout", "-q", "-b", "base-tip", "origin/develop");
    writeFileSync(join(dir, "seed.txt"), "the base's edit\n");
    writeFileSync(join(dir, "base-only.txt"), "the base's own file\n");
    mustGit(dir, "add", "-A");
    mustGit(dir, "commit", "-q", "-m", "base moves on");
    mustGit(dir, "update-ref", "refs/remotes/origin/develop", "HEAD");
    mustGit(dir, "checkout", "-q", "main");
    mustGit(dir, "branch", "-q", "-D", "base-tip");
    const baseTip = mustGit(dir, "rev-parse", "origin/develop");

    // What an earlier pass left: the merge open, its conflict resolved but
    // not committed, and an edit of its own beside it.
    expect(git(dir, "merge", "origin/develop").code).not.toBe(0);
    writeFileSync(
      join(dir, "seed.txt"),
      "the change's edit, over the base's\n",
    );
    mustGit(dir, "add", "seed.txt");
    writeFileSync(join(dir, "own.txt"), "the earlier pass's own edit\n");

    // The push refuses the tree as it is: nothing is committed.
    const refused = await finishRound({ repo, ...conflicting });
    expectSpawnExit(refused, 3);
    expect(refused.report.state).toBe("REFUSED_UNCLEAN");
    expect(refused.pushed).toBe("");

    // The validation plan plans the open merge as its commit will hold it:
    // the change's files, not the base's own.
    const plan = await roundPlan(dir);
    expectSpawnExit(plan, 0);
    const planned = JSON.parse(plan.stdout) as {
      files: string[];
      base: string;
    };
    expect(planned.base).toBe(baseTip);
    expect(planned.files).toEqual(["own.txt", "seed.txt"]);

    // Validated, the pass concludes the merge with the work in it.
    mustGit(dir, "add", "-A");
    mustGit(dir, "commit", "-q", "--no-edit");
    const head = mustGit(dir, "rev-parse", "HEAD");

    const pushed = await finishRound({ repo: { dir, head }, ...conflicting });
    expectSpawnExit(pushed, 0);
    expect(pushed.pushed).not.toBe("");
    expect(git(dir, "merge-base", "--is-ancestor", baseTip, "HEAD").code).toBe(
      0,
    );
    expect(mustGit(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD").code).not.toBe(
      0,
    );
  }, 120_000);
});
