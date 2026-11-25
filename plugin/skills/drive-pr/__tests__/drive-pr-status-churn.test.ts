/**
 * drive-pr suite: drive-status.ts's structural-churn brake, end to end: the
 * counting gate that completes a same-file streak parks the drive under
 * `structural-churn` and exits HITL_PARKED; the standing park holds live
 * work, and a conflicting pull request reports PR_CONFLICTING before it; a
 * round carrying a high finding does not count; a file whose content
 * returns to an earlier one parks the drive.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  writeFixture,
  park,
  probeIn,
  useDrivePrSuite,
  type FixtureThread,
  type ProbeResult,
} from "./drive-pr-harness.ts";
import { createStatusEscalationFixtures } from "./drive-pr-status-escalation-fixtures.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { readState, seedRounds, writeState } from "./state-rows.ts";

useDrivePrSuite();

const { driveState } = createStatusEscalationFixtures();

const scratch = mkdtempSync(join(tmpdir(), "status-churn-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * A repository with one commit per round, each rewriting a.ts, whose ids are
 * the heads: a round is a distinct push, and its file contents are read.
 */
function history(rounds: number): { cwd: string; heads: string[] } {
  const cwd = mkdtempSync(join(scratch, "repo-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  const git = (...args: string[]): string => {
    const r = spawnSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd, env, encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q");
  const heads: string[] = [];
  for (let i = 1; i <= rounds; i++) {
    writeFileSync(join(cwd, "a.ts"), `export const round = ${i};\n`);
    git("add", ".");
    git("commit", "-q", "-m", `round ${i}`);
    heads.push(git("rev-parse", "HEAD"));
  }
  return { cwd, heads };
}

/** A reviewer finding on `a.ts`, at `severity` in Jig's own format. */
function finding(id: string, severity = "medium"): FixtureThread {
  return {
    id,
    path: "a.ts",
    bot: true,
    comments: [
      {
        author: "example-review[bot]",
        bot: true,
        body: `🟡 **${severity}** · 🏷️ category: docs\n\nReword this sentence.`,
      },
    ],
  };
}

const ENV = { JIG__dispatch__person: "maintainer" };

/** Run counting gates for rounds `1..severities.length`, one finding each. */
async function rounds(
  severities: string[],
  repo = history(severities.length + 1),
): Promise<{
  stateDir: string;
  results: ProbeResult[];
  repo: ReturnType<typeof history>;
}> {
  let stateDir = "";
  const results: ProbeResult[] = [];
  const { cwd, heads } = repo;
  for (const [i, severity] of severities.entries()) {
    const head = heads[i] as string;
    const fx = writeFixture({
      head,
      threads: [finding(`PRRT_${i}`, severity)],
    });
    stateDir ||= fx.stateDir;
    results.push(
      await probeIn(fx.dir, stateDir, head, ["--bump-attempt"], {
        env: ENV,
        cwd,
      }),
    );
  }
  return { stateDir, results, repo };
}

const exitOf = (r: ProbeResult) => ({
  ...r,
  stdout: JSON.stringify(r.json),
});

interface StoredPark {
  key: string;
  class?: string;
  decision?: { call: { options: { id: string }[]; recommended: string } };
}

async function stored(
  stateDir: string,
  cwd?: string,
): Promise<{
  parked: StoredPark[];
  churnAckRound?: number;
  roundPaths?: { severe?: boolean; blobs?: Record<string, string> }[];
}> {
  return JSON.parse((await driveState(stateDir, ["get", "999"], cwd)).stdout);
}

describe("drive-status.ts structural-churn brake", () => {
  it("parks the drive when the same file churns for four non-severe rounds", async () => {
    const { stateDir, results, repo } = await rounds([
      "medium",
      "low",
      "medium",
      "low",
    ]);
    for (const r of results.slice(0, 3)) expectSpawnExit(exitOf(r), 0);
    const last = results[3] as ProbeResult;
    expectSpawnExit(exitOf(last), 8);
    expect(last.state).toBe("HITL_PARKED");
    expect(last.json.reason).toContain("structural churn (same-file)");
    expect(last.json.reason).toContain("rounds 1, 2, 3, 4");
    expect(last.json.work).toMatchObject({
      actionableParkKeys: ["structural-churn-r4"],
    });
    const state = await stored(stateDir, repo.cwd);
    expect(state.churnAckRound).toBe(4);
    const park = state.parked.find((p) => p.key === "structural-churn-r4");
    expect(park?.class).toBe("structural-churn");
    expect(park?.decision?.call.options.map((o) => o.id)).toEqual([
      "defer",
      "narrow",
      "continue",
    ]);
    expect(park?.decision?.call.recommended).toBe("defer");
  });

  it("records an unreconciled round without facts, so it never trips the brake", async () => {
    const { stateDir, repo } = await rounds(
      ["medium", "low", "medium"],
      history(4),
    );
    const head = repo.heads[3] as string;
    const fx = writeFixture({ head, threads: [finding("PRRT_3", "low")] });
    const r = await probeIn(fx.dir, stateDir, head, ["--bump-attempt"], {
      env: ENV,
      cwd: repo.cwd,
      reconcile: false,
    });
    expectSpawnExit(exitOf(r), 0);
    expect(r.state).toBe("ROUND_READY");
    const state = await stored(stateDir, repo.cwd);
    expect(state.parked).toEqual([]);
    const entry = state.roundPaths?.at(-1);
    expect(entry?.severe).toBeUndefined();
    expect(entry?.blobs).toBeUndefined();
  });

  it("holds live work while its park stands", async () => {
    const { stateDir, repo } = await rounds(
      ["medium", "low", "medium", "low"],
      history(5),
    );
    const head = repo.heads[4] as string;
    const fx = writeFixture({ head, threads: [finding("PRRT_new")] });
    const r = await probeIn(fx.dir, stateDir, head, ["--bump-attempt"], {
      env: ENV,
      cwd: repo.cwd,
    });
    expectSpawnExit(exitOf(r), 8);
    expect(r.state).toBe("HITL_PARKED");
    expect(r.json.reason).toContain("structural-churn-r4");
    expect(r.json.work).toMatchObject({ unresolvedThreads: 1 });
  });

  it("does not park when a round in the streak carried a high finding", async () => {
    const { stateDir, results } = await rounds([
      "medium",
      "low",
      "high",
      "medium",
    ]);
    for (const r of results) expectSpawnExit(exitOf(r), 0);
    const state = await stored(stateDir);
    expect(state.parked).toEqual([]);
    expect(state.churnAckRound).toBeUndefined();
  });

  it("reports PR_CONFLICTING before a standing churn park, never ROUND_READY", async () => {
    const head = "c4a".padEnd(40, "0");
    const fx = writeFixture({
      head,
      mergeable: "CONFLICTING",
      threads: [finding("PRRT_live")],
    });
    await park(
      fx.stateDir,
      "structural-churn-r1",
      "finding",
      "structural-churn",
    );
    const r = await probeIn(fx.dir, fx.stateDir, head, ["--bump-attempt"], {
      env: ENV,
    });
    expectSpawnExit(exitOf(r), 9);
    expect(r.state).toBe("PR_CONFLICTING");
    expect(r.json.reason).toContain("structural-churn-r1");
    expect(r.json.work).toMatchObject({ unresolvedThreads: 1 });
  });

  it("records the park but reports PR_CONFLICTING when the round that trips it conflicts", async () => {
    const { stateDir, repo } = await rounds(
      ["medium", "low", "medium"],
      history(4),
    );
    const head = repo.heads[3] as string;
    const fx = writeFixture({
      head,
      mergeable: "CONFLICTING",
      threads: [finding("PRRT_3", "low")],
    });
    const r = await probeIn(fx.dir, stateDir, head, ["--bump-attempt"], {
      env: ENV,
      cwd: repo.cwd,
    });
    expectSpawnExit(exitOf(r), 9);
    expect(r.state).toBe("PR_CONFLICTING");
    expect(r.json.reason).toContain("structural-churn-r4");
    const state = await stored(stateDir, repo.cwd);
    expect(state.parked.map((p) => p.key)).toEqual(["structural-churn-r4"]);
  });

  it("parks on a file whose content returned to an earlier one (A, B, A)", async () => {
    const head = "c4a".padEnd(40, "4");
    const fx = writeFixture({ head, threads: [finding("PRRT_live", "high")] });
    seedRounds(fx.stateDir, 3, "c4a".padEnd(40, "3"));
    const blob = (c: string) => c.repeat(40);
    const seeded = readState(fx.stateDir, "999") as Record<string, unknown>;
    writeState(fx.stateDir, "999", {
      ...seeded,
      roundPaths: ["a", "b", "a"].map((c, i) => ({
        round: i + 1,
        paths: ["a.ts"],
        severe: true,
        blobs: { "a.ts": blob(c) },
      })),
    });
    const r = await probeIn(fx.dir, fx.stateDir, head, ["--bump-attempt"], {
      env: ENV,
    });
    expectSpawnExit(exitOf(r), 8);
    expect(r.state).toBe("HITL_PARKED");
    expect(r.json.reason).toContain("structural churn (oscillation)");
    const park = (await stored(fx.stateDir)).parked.find(
      (p) => p.key === "structural-churn-r4",
    );
    expect(park?.class).toBe("structural-churn");
    expect(park?.decision?.call.options.map((o) => o.id)).toEqual([
      "defer",
      "narrow",
      "continue",
    ]);
  });

  it("is off when drive.churn_rounds is 0", async () => {
    let stateDir = "";
    const { cwd, heads } = history(5);
    for (let i = 1; i <= 5; i++) {
      const head = heads[i - 1] as string;
      const fx = writeFixture({ head, threads: [finding(`PRRT_${i}`)] });
      stateDir ||= fx.stateDir;
      const r = await probeIn(fx.dir, stateDir, head, ["--bump-attempt"], {
        env: { ...ENV, DRIVE_PR_CHURN_ROUNDS: "0" },
        cwd,
      });
      expectSpawnExit(exitOf(r), 0);
    }
  });
});
