/**
 * drive-pr suite: drive-status.ts's structural-churn brake, end to end: the
 * counting gate that completes a same-file streak parks the drive under
 * `structural-churn` and exits HITL_PARKED; the standing park holds live
 * work; a round carrying a high finding does not count.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import {
  writeFixture,
  probeIn,
  useDrivePrSuite,
  type FixtureThread,
  type ProbeResult,
} from "./drive-pr-harness.ts";
import { createStatusEscalationFixtures } from "./drive-pr-status-escalation-fixtures.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

useDrivePrSuite();

const { driveState } = createStatusEscalationFixtures();

/** A distinct head per round: a round is a distinct push. */
const headOf = (round: number) => `c4a${String(round).padStart(37, "0")}`;

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
async function rounds(severities: string[]): Promise<{
  stateDir: string;
  results: ProbeResult[];
}> {
  let stateDir = "";
  const results: ProbeResult[] = [];
  for (const [i, severity] of severities.entries()) {
    const head = headOf(i + 1);
    const fx = writeFixture({
      head,
      threads: [finding(`PRRT_${i}`, severity)],
    });
    stateDir ||= fx.stateDir;
    results.push(
      await probeIn(fx.dir, stateDir, head, ["--bump-attempt"], { env: ENV }),
    );
  }
  return { stateDir, results };
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

async function stored(stateDir: string): Promise<{
  parked: StoredPark[];
  churnAckRound?: number;
}> {
  return JSON.parse((await driveState(stateDir, ["get", "999"])).stdout);
}

describe("drive-status.ts structural-churn brake", () => {
  it("parks the drive when the same file churns for four non-severe rounds", async () => {
    const { stateDir, results } = await rounds([
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
    const state = await stored(stateDir);
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

  it("holds live work while its park stands", async () => {
    const { stateDir } = await rounds(["medium", "low", "medium", "low"]);
    const head = headOf(5);
    const fx = writeFixture({ head, threads: [finding("PRRT_new")] });
    const r = await probeIn(fx.dir, stateDir, head, ["--bump-attempt"], {
      env: ENV,
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

  it("is off when drive.churn_rounds is 0", async () => {
    let stateDir = "";
    for (let i = 1; i <= 5; i++) {
      const fx = writeFixture({
        head: headOf(i),
        threads: [finding(`PRRT_${i}`)],
      });
      stateDir ||= fx.stateDir;
      const r = await probeIn(fx.dir, stateDir, headOf(i), ["--bump-attempt"], {
        env: { ...ENV, DRIVE_PR_CHURN_ROUNDS: "0" },
      });
      expectSpawnExit(exitOf(r), 0);
    }
  });
});
