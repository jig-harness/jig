import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { emptyReport } from "../scripts/lib/status/evaluate.ts";
import {
  WaitingEvaluationCache,
  waitingChecksMaxAgeMs,
} from "../scripts/lib/status/waiting-cache.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

const HEAD = "a".repeat(40);
const ctx = {
  pr: "123",
  owner: "example-org",
  repo: "example-repo",
  localHead: HEAD,
  helperTimeoutSec: 10,
};

function fixture() {
  let now = 0;
  let enabled = true;
  let signals: { head: string; pullBody: string; unchanged: boolean } | null = {
    head: HEAD,
    pullBody: "open pull",
    unchanged: false,
  };
  let state = "AWAITING_REVIEWER";
  let reviewerStatus = "in_progress";
  let code = 4;
  let reads = 0;
  let evalDelay = 0;
  const order: string[] = [];
  const cache = new WaitingEvaluationCache(300_000, {
    enabled: () => enabled,
    now: () => now,
    signals: async () => {
      order.push("signals");
      return signals;
    },
  });
  const report = emptyReport();
  const fresh = async () => {
    reads += 1;
    now += evalDelay;
    order.push("authoritative");
    Object.assign(report, emptyReport(), {
      apiHead: HEAD,
      state,
      reviewerStatus,
      reason: `read ${reads}`,
    });
    return code;
  };
  return {
    report,
    order,
    poll: (context = ctx) => cache.evaluate(context, report, fresh),
    reads: () => reads,
    delay: (value: number) => {
      evalDelay = value;
    },
    unchanged: () => {
      signals = { head: HEAD, pullBody: "open pull", unchanged: true };
    },
    signals: (value: typeof signals) => {
      signals = value;
    },
    time: (value: number) => {
      now = value;
    },
    enabled: (value: boolean) => {
      enabled = value;
    },
    state: (value: string, result: number, status = reviewerStatus) => {
      state = value;
      code = result;
      reviewerStatus = status;
    },
  };
}

describe("waiting evaluation cache", () => {
  it("ages the reused report from when its evidence was read, and never arms an expired one", async () => {
    const f = fixture();
    f.delay(200_000);
    await f.poll();
    f.unchanged();
    f.delay(0);
    f.time(299_999);
    await f.poll();
    expect(f.reads()).toBe(1);
    f.time(300_000);
    await f.poll();
    expect(f.reads()).toBe(2);

    const g = fixture();
    g.delay(300_000);
    await g.poll();
    g.unchanged();
    g.delay(0);
    await g.poll();
    expect(g.reads()).toBe(2);
  });

  it("primes before gathering, reuses only the observed report, and preserves its age", async () => {
    const f = fixture();
    expect(await f.poll()).toBe(4);
    expect(f.order).toEqual(["signals", "authoritative"]);
    f.unchanged();
    f.report.reason = "caller mutation";
    f.time(299_999);
    await f.poll();
    expect(f.reads()).toBe(1);
    expect(f.report.reason).toBe("read 1");
    f.time(300_000);
    await f.poll();
    expect(f.reads()).toBe(2);
  });

  for (const [state, code] of [
    ["ROUND_READY", 0],
    ["CONVERGED", 0],
    ["HITL_PARKED", 8],
    ["PR_CONFLICTING", 9],
    ["PR_NOT_OPEN", 5],
    ["INDETERMINATE", 1],
    ["HEAD_LAG", 4],
    ["MERGEABILITY_UNKNOWN", 4],
    ["STALE_REVIEW", 4],
  ] as const) {
    it(`always re-gathers ${state}, even with unchanged server signals`, async () => {
      const f = fixture();
      f.state(state, code);
      await f.poll();
      f.unchanged();
      await f.poll();
      expect(f.reads()).toBe(2);
    });
  }

  it("re-gathers completed reviewers awaiting publication rather than reusing their work counts", async () => {
    const f = fixture();
    f.state("AWAITING_REVIEWER", 4, "completed");
    await f.poll();
    f.unchanged();
    await f.poll();
    expect(f.reads()).toBe(2);
  });

  for (const next of [
    null,
    { head: HEAD, pullBody: "open pull", unchanged: false },
    { head: HEAD, pullBody: "changed base", unchanged: true },
    { head: "b".repeat(40), pullBody: "open pull", unchanged: true },
  ]) {
    it(`refreshes on failed or changed signals ${JSON.stringify(next)}`, async () => {
      const f = fixture();
      await f.poll();
      f.signals(next);
      f.state("CONVERGED", 0, "completed");
      expect(await f.poll()).toBe(0);
      expect(f.reads()).toBe(2);
      expect(f.report.state).toBe("CONVERGED");
      f.unchanged();
      await f.poll();
      expect(f.reads()).toBe(3);
    });
  }

  it("refreshes when local head or repository/PR identity changes", async () => {
    for (const changed of [
      { ...ctx, localHead: "b".repeat(40) },
      { ...ctx, repo: "other" },
      { ...ctx, pr: "456" },
    ]) {
      const f = fixture();
      await f.poll();
      f.unchanged();
      await f.poll(changed);
      expect(f.reads()).toBe(2);
    }
  });

  it("disabled caching makes no signal requests and clears earlier waiting state", async () => {
    const f = fixture();
    await f.poll();
    f.unchanged();
    f.enabled(false);
    await f.poll();
    expect(f.order).toEqual(["signals", "authoritative", "authoritative"]);
    f.enabled(true);
    await f.poll();
    expect(f.reads()).toBe(3);
  });

  it("clock rollback expires a waiting observation", async () => {
    const f = fixture();
    f.time(1000);
    await f.poll();
    f.unchanged();
    f.time(999);
    await f.poll();
    expect(f.reads()).toBe(2);
  });

  it("zero max age does not probe even when caching is enabled", async () => {
    let reads = 0;
    const cache = new WaitingEvaluationCache(0, {
      enabled: () => true,
      now: () => 0,
      signals: async () => {
        throw new Error("zero max-age must not probe");
      },
    });
    expect(
      await cache.evaluate(ctx, emptyReport(), async () => {
        reads += 1;
        return 4;
      }),
    ).toBe(4);
    expect(reads).toBe(1);
  });

  it("shares the existing bounded max-age setting, with zero disabling reuse", () => {
    expect(waitingChecksMaxAgeMs("300")).toBe(300_000);
    expect(waitingChecksMaxAgeMs("0")).toBe(0);
    for (const value of ["-1", "1.5", "", "86401", "NaN"])
      expect(() => waitingChecksMaxAgeMs(value)).toThrow();
  });
});

it("the real evaluator primes conditional headers, skips a waiting GraphQL read, and freshly observes closure", () => {
  const dir = mkdtempSync(join(tmpdir(), "waiting-evaluator-"));
  try {
    const fixtureEnv: typeof process.env = {
      ...process.env,
      GH_REPO: "fixture/repo",
    };
    delete fixtureEnv.GIT_DIR;
    delete fixtureEnv.GIT_WORK_TREE;
    delete fixtureEnv.GIT_COMMON_DIR;
    const init = Bun.spawnSync(["git", "init", "--quiet", dir], {
      cwd: dir,
      env: fixtureEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(init, 0, "hermetic fixture git init");
    const fakeGh = String.raw`#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const dir = process.env.FIXTURE_DIR;
const closed = readFileSync(dir + '/phase', 'utf8') === 'closed';
appendFileSync(dir + '/calls', JSON.stringify(args) + '\n');
const head = '${HEAD}';
if (args[0] === 'pr' && args[1] === 'view') {
  console.log(JSON.stringify({state: closed ? 'CLOSED' : 'OPEN', isDraft: false,
    headRefOid: head, baseRefOid: 'b'.repeat(40), baseRefName: 'develop',
    headRefName: 'feature/example', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN'}));
} else if (args[0] === 'api') {
  const path = args.at(-1);
  const runs = {check_runs: [{id: 1, name: 'AI review', status: 'queued', conclusion: null,
    app: {slug: 'example-review'}, output: {title: ''}, started_at: null}]};
  let body;
  if (path.includes('/pulls/')) body = {state: closed ? 'closed' : 'open', merged: false, head: {sha: head}};
  else if (path.includes('/check-runs')) body = runs;
  else if (path.includes('/status')) body = {statuses: []};
  else if (path.includes('/comments')) body = [];
  else process.exit(2);
  if (args.includes('-i')) {
    const tag = closed ? '"closed"' : '"open"';
    const unchanged = args.includes('If-None-Match: ' + tag);
    process.stdout.write('HTTP/2.0 ' + (unchanged ? '304 Not Modified' : '200 OK') + '\r\nEtag: ' + tag + '\r\n\r\n');
    if (!unchanged) process.stdout.write(JSON.stringify(body));
    process.exit(unchanged ? 1 : 0);
  } else console.log(JSON.stringify([body]));
} else process.exit(2);
`;
    writeFakeProgram(join(dir, "gh"), fakeGh);
    writeFileSync(join(dir, "phase"), "open");
    const script = `
import { writeFileSync } from 'node:fs';
import { evaluate, emptyReport } from ${JSON.stringify(resolve(import.meta.dir, "../scripts/lib/status/evaluate.ts"))};
import { WaitingEvaluationCache } from ${JSON.stringify(resolve(import.meta.dir, "../scripts/lib/status/waiting-cache.ts"))};
const ctx = {...${JSON.stringify(ctx)}, botsOnly: false, headSync: true,
  driveStateScript: '', listThreadsScript: '', summaryScript: '', waitingCache: new WaitingEvaluationCache(300000)};
const results = [];
for (let poll = 0; poll < 4; poll++) {
  if (poll === 2) writeFileSync(process.env.FIXTURE_DIR + '/phase', 'closed');
  const report = emptyReport();
  const code = await evaluate(ctx, report);
if (report.state === "INDETERMINATE") throw new Error(report.reason);
results.push([code, report.state]);
}
console.log(JSON.stringify(results));
`;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: dir,
      env: {
        ...fixtureEnv,
        PATH: `${dir}${delimiter}${process.env.PATH}`,
        FIXTURE_DIR: dir,
        // The drive waits only on a reviewer the repository names.
        DRIVE_PR_REVIEWER_APP: "example-review",
        JIG_GH_CACHE_DIR: join(dir, "cache"),
        JIG_GH_CACHE: "on",
        NODE_ENV: "test",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(result, 0, "real waiting evaluator");
    expect(JSON.parse(result.stdout.toString())).toEqual([
      [4, "AWAITING_REVIEWER"],
      [4, "AWAITING_REVIEWER"],
      [5, "PR_NOT_OPEN"],
      [5, "PR_NOT_OPEN"],
    ]);
    const calls = readFileSync(join(dir, "calls"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.filter((args) => args[0] === "pr")).toHaveLength(3);
    const pulls = calls.filter((args) => args.at(-1)?.includes("/pulls/"));
    expect(pulls).toHaveLength(4);
    expect(pulls[0]).not.toContain('If-None-Match: "open"');
    expect(pulls[1]).toContain('If-None-Match: "open"');
    expect(calls[0]?.at(-1)).toContain("/pulls/");
    const firstGraphql = calls.findIndex((args) => args[0] === "pr");
    expect(
      calls
        .slice(0, firstGraphql)
        .some((args) => args.at(-1)?.includes("/check-runs")),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
