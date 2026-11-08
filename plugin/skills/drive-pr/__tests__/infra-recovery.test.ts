/**
 * The converged head's infrastructure recovery, with the forge and the tree
 * replaced: when every failing check failed on the infrastructure it re-runs
 * them, moves the head once a run cannot be re-run or its re-runs are spent,
 * and stops `CI_INFRA_PERSISTED` past both bounds; anything else is left to
 * the repair path. `moveHead` merges the base when the branch is behind it,
 * commits an empty commit otherwise, and pushes only a head that moved.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  everyFailureInfrastructure,
  type Exec,
  wholeOr,
  type FailingChecks,
  type InfraDeps,
  moveHead,
  RERUN_COMMIT_MESSAGE,
  type RerunAnswer,
  recoverInfrastructureFailure,
} from "../scripts/lib/driver/infra-recovery.ts";
import type { DriveRoundContext } from "../scripts/lib/driver/round-context.ts";
import { CI_INFRA_PERSISTED_EXIT } from "../scripts/lib/driver/settings.ts";

const DOWNLOAD_504 = readFileSync(
  join(
    import.meta.dir,
    "../../../shared/__tests__/fixtures/ci-infra/tool-download-504.log",
  ),
  "utf8",
);

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);

const FAILING: FailingChecks = {
  checkRunNames: ["Analyze (python)", "Analyze (actions)"],
  statusNames: [],
  runs: [
    {
      id: 41,
      createdAt: "2026-11-08T10:11:00Z",
      jobNames: ["Analyze (python)", "Analyze (actions)"],
    },
  ],
};

/** The fields of the round context this step reads and writes. */
function contextOf(over: { reruns?: number; moves?: number } = {}) {
  const context = {
    pr: "999",
    dryRun: false,
    agent: ["pass"],
    ciRepairs: 0,
    ciRepairBudget: 2,
    mailboxCheckpoint: async () => "clear" as const,
    ciInfra: {
      head: HEAD,
      reruns: over.reruns ?? 0,
      moves: over.moves ?? 0,
      rerunBudget: 2,
      moveBudget: 2,
    },
  };
  return context as unknown as DriveRoundContext & typeof context;
}

/** Deps that record what was asked, answering re-runs with `answer`. */
function depsOf(
  opts: {
    logs?: string[] | null;
    answer?: RerunAnswer;
    rerunnable?: number[];
  } = {},
) {
  const calls: string[] = [];
  const deps: InfraDeps = {
    readLogs: async () =>
      opts.logs === undefined ? [DOWNLOAD_504] : opts.logs,
    rerunnable: async (_pr, runs) => opts.rerunnable ?? runs.map((r) => r.id),
    rerun: async (run) => {
      calls.push(`rerun ${run}`);
      return {
        answer: opts.answer ?? "rerun",
        detail:
          opts.answer === "refused"
            ? "This workflow run cannot be retried"
            : "",
      };
    },
    moveHead: async (pr, head) => {
      calls.push(`move ${pr} ${head}`);
      return "continue";
    },
    sleep: async () => {
      // The waits between re-reads have nothing to wait for here.
    },
  };
  return { deps, calls };
}

describe("recoverInfrastructureFailure", () => {
  it("re-runs the failed jobs and spends no repair pass", async () => {
    const context = contextOf();
    const { deps, calls } = depsOf();
    expect(
      await recoverInfrastructureFailure(context, HEAD, FAILING, deps),
    ).toBe("continue");
    expect(calls).toEqual(["rerun 41"]);
    expect(context.ciInfra.reruns).toBe(1);
    expect(context.ciRepairs).toBe(0);
  });

  it("moves the head when the forge refuses the re-run", async () => {
    const context = contextOf();
    const { deps, calls } = depsOf({ answer: "refused" });
    expect(
      await recoverInfrastructureFailure(context, HEAD, FAILING, deps),
    ).toBe("continue");
    expect(calls).toEqual(["rerun 41", `move 999 ${HEAD}`]);
    expect(context.ciInfra.moves).toBe(1);
    expect(context.ciRepairs).toBe(0);
  });

  it("moves the head, without asking, for a run created under the CI hold", async () => {
    const context = contextOf();
    const { deps, calls } = depsOf({ rerunnable: [] });
    await recoverInfrastructureFailure(context, HEAD, FAILING, deps);
    expect(calls).toEqual([`move 999 ${HEAD}`]);
  });

  it("moves the head once the re-runs on this head are spent", async () => {
    const context = contextOf({ reruns: 2 });
    const { deps, calls } = depsOf();
    await recoverInfrastructureFailure(context, HEAD, FAILING, deps);
    expect(calls).toEqual([`move 999 ${HEAD}`]);
  });

  it("starts a moved head's re-runs afresh", async () => {
    const context = contextOf({ reruns: 2, moves: 1 });
    const { deps, calls } = depsOf();
    await recoverInfrastructureFailure(context, MOVED, FAILING, deps);
    expect(calls).toEqual(["rerun 41"]);
    expect(context.ciInfra).toMatchObject({ head: MOVED, reruns: 1, moves: 1 });
  });

  it("counts a re-run that could not be asked for, and does not move the head", async () => {
    const context = contextOf();
    const { deps, calls } = depsOf({ answer: "failed" });
    expect(
      await recoverInfrastructureFailure(context, HEAD, FAILING, deps),
    ).toBe("continue");
    expect(calls).toEqual(["rerun 41"]);
    expect(context.ciInfra.reruns).toBe(1);
  });

  it("stops CI_INFRA_PERSISTED once the re-runs and head moves are spent", async () => {
    const context = contextOf({ reruns: 2, moves: 2 });
    const { deps, calls } = depsOf();
    expect(
      await recoverInfrastructureFailure(context, HEAD, FAILING, deps),
    ).toBe(CI_INFRA_PERSISTED_EXIT);
    expect(calls).toEqual([]);
    expect(context.ciRepairs).toBe(0);
  });

  it("leaves a failure it cannot read as the infrastructure's to the repair path", async () => {
    const cases: Array<[FailingChecks, string[] | null]> = [
      [FAILING, null],
      [FAILING, ["test\tRun tests\t2026-11-08T10:12:19.0Z FAIL a.test.ts"]],
      [{ ...FAILING, statusNames: ["legacy-ci"] }, [DOWNLOAD_504]],
      [{ ...FAILING, statusNames: null }, [DOWNLOAD_504]],
      [
        {
          ...FAILING,
          checkRunNames: [...(FAILING.checkRunNames ?? []), "lint"],
        },
        [DOWNLOAD_504],
      ],
      [{ ...FAILING, runs: [] }, [DOWNLOAD_504]],
    ];
    for (const [failing, logs] of cases) {
      const context = contextOf();
      const { deps, calls } = depsOf({ logs });
      expect(
        await recoverInfrastructureFailure(context, HEAD, failing, deps),
      ).toBeNull();
      expect(calls).toEqual([]);
      expect(context.ciInfra.reruns).toBe(0);
    }
  });
});

describe("everyFailureInfrastructure", () => {
  it("does not overwrite a code failure with a same-named infrastructure job", () => {
    const failing = {
      ...FAILING,
      checkRunNames: ["test", "test"],
      runs: [
        { id: 1, createdAt: "", jobNames: ["test"] },
        { id: 2, createdAt: "", jobNames: ["test"] },
      ],
    };
    expect(
      everyFailureInfrastructure(failing, [
        "test\tRun tests\tFAIL src/a.test.ts",
        "test\tSet up job\tThe runner has received a shutdown signal.",
      ]).infrastructure,
    ).toBe(false);
  });

  it("rejects unplaced negative evidence beside named infrastructure jobs", () => {
    expect(
      everyFailureInfrastructure(FAILING, [
        DOWNLOAD_504 + "\nFAIL src/a.test.ts",
      ]).infrastructure,
    ).toBe(false);
  });

  it("does not cover a non-workflow check through another check's name", () => {
    expect(
      everyFailureInfrastructure(
        {
          ...FAILING,
          checkRunNames: [...(FAILING.checkRunNames ?? []), "Analyze (python)"],
        },
        [DOWNLOAD_504],
      ).infrastructure,
    ).toBe(false);
  });

  it("bounds numeric retry inputs", () => {
    for (const raw of ["9".repeat(400), "9007199254740992", "101", "-1", "no"])
      expect(wholeOr(raw, 2)).toBe(2);
    expect(wholeOr("0", 2)).toBe(0);
    expect(wholeOr("100", 2)).toBe(100);
  });

  it("names the check no failed-run log covers", () => {
    const r = everyFailureInfrastructure(
      { ...FAILING, checkRunNames: ["lint"] },
      [DOWNLOAD_504],
    );
    expect(r).toEqual({
      infrastructure: false,
      why: "a failing check has no unique workflow-run coverage",
    });
  });
});

/** An `Exec` answering by the command's first words, recording each call. */
function execOf(answers: Record<string, { code: number; stdout?: string }>) {
  const calls: string[] = [];
  const exec: Exec = async (argv) => {
    const call = argv
      .map((a) => a.replace(/^.*\/(base-sync|guarded-push)\.ts$/u, "$1"))
      .filter((a) => !a.startsWith("-") || a.startsWith("--"))
      .join(" ");
    calls.push(call);
    const key = Object.keys(answers).find((k) => call.includes(k));
    const answer = key === undefined ? { code: 1 } : answers[key];
    return {
      code: answer?.code ?? 1,
      stdout: answer?.stdout ?? "",
      stderr: "",
    };
  };
  return { exec, calls };
}

describe("moveHead", () => {
  it("commits an empty commit when the branch is not behind its base, and pushes it", async () => {
    const commits: string[] = [];
    const { exec, calls } = execOf({
      "base-sync": { code: 0, stdout: '{"action":"none","reason":"in-sync"}' },
      "rev-parse": { code: 0, stdout: `${MOVED}\n` },
      "guarded-push": { code: 0 },
    });
    const r = await moveHead("999", HEAD, exec, async (pr) => {
      commits.push(pr);
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(r).toBe("continue");
    expect(commits).toEqual(["999"]);
    expect(calls.at(-1)).toContain(`guarded-push 999 --expect-head ${MOVED}`);
  });

  it("hands a base merge to the next validated round, with no empty commit", async () => {
    const commits: string[] = [];
    const { exec, calls } = execOf({
      "base-sync": { code: 0, stdout: '{"action":"merged","reason":"merged"}' },
      "rev-parse": { code: 0, stdout: `${MOVED}\n` },
      "guarded-push": { code: 0 },
    });
    expect(
      await moveHead("999", HEAD, exec, async (pr) => {
        commits.push(pr);
        return { code: 0, stdout: "", stderr: "" };
      }),
    ).toBe("continue");
    expect(commits).toEqual([]);
    expect(calls.some((c) => c.includes("base-sync 999 --force --json"))).toBe(
      true,
    );
  });

  it("never pushes a head that did not move", async () => {
    const { exec, calls } = execOf({
      "base-sync": { code: 0, stdout: '{"action":"none","reason":"in-sync"}' },
      "rev-parse": { code: 0, stdout: `${HEAD}\n` },
    });
    expect(
      await moveHead("999", HEAD, exec, async () => ({
        code: 0,
        stdout: "",
        stderr: "",
      })),
    ).toBe(1);
    expect(calls.some((c) => c.includes("guarded-push"))).toBe(false);
  });

  it("reports a closed pull request as 5, and a refused commit as 1", async () => {
    const closed = execOf({ "base-sync": { code: 5 } });
    expect(await moveHead("999", HEAD, closed.exec)).toBe(5);
    const refused = execOf({
      "base-sync": { code: 0, stdout: '{"action":"none","reason":"in-sync"}' },
    });
    expect(
      await moveHead("999", HEAD, refused.exec, async () => ({
        code: 1,
        stdout: "",
        stderr: "the tree holds tracked changes",
      })),
    ).toBe(1);
  });

  it("propagates base-sync refusals without committing or pushing", async () => {
    for (const code of [1, 2, 3, 11]) {
      const { exec, calls } = execOf({ "base-sync": { code } });
      let committed = false;
      expect(
        await moveHead("999", HEAD, exec, async () => {
          committed = true;
          return { code: 0, stdout: "", stderr: "" };
        }),
      ).toBe(code);
      expect(committed).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  it("rejects malformed or undecided base-sync reports", async () => {
    for (const stdout of [
      "not json",
      "{}",
      '{"action":"none","reason":"fetch-failed"}',
    ]) {
      const { exec, calls } = execOf({ "base-sync": { code: 0, stdout } });
      let committed = false;
      expect(
        await moveHead("999", HEAD, exec, async () => {
          committed = true;
          return { code: 0, stdout: "", stderr: "" };
        }),
      ).toBe(1);
      expect(committed).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  it("leaves a base merge for the next validated round before any push", async () => {
    const { exec, calls } = execOf({
      "base-sync": { code: 0, stdout: '{"action":"merged","reason":"merged"}' },
    });
    expect(await moveHead("999", HEAD, exec)).toBe("continue");
    expect(calls).toHaveLength(1);
  });

  it("names the empty commit for what it does", () => {
    expect(RERUN_COMMIT_MESSAGE).toBe(
      "ci: re-run checks after an infrastructure failure",
    );
  });
});
