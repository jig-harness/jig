/**
 * drive-pr suite: the economic circuit breaker's arithmetic and framing:
 * the round ceiling and its override, the wall-clock cap, the divergence
 * stop, the settings' bounds, and the circuit fields the ledger carries.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkParkedDecision } from "../../../shared/decisions/park.ts";
import { parseMs } from "../../../shared/time.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  answerRaisesCeiling,
  type CeilingFacts,
  divergenceDecision,
  PAST_CEILING_OPTION,
  ROUND_CEILING_PARK,
  roundCeilingDecision,
} from "../scripts/lib/driver/circuit-park.ts";
import {
  atRoundCeiling,
  diverges,
  divergenceStops,
  findingMovement,
  hoursDriven,
  isOptionalCircuit,
  malformedLedgerCircuit,
  openFindingKeys,
  type RoundFindings,
  raisedCeiling,
  raisedWallClock,
  roundCeiling,
  seedCircuit,
  wallClockSpent,
  withRoundFindings,
} from "../scripts/lib/state/circuit-breaker.ts";
import {
  type CircuitLimits,
  passDeadlineUnderCap,
} from "../scripts/lib/driver/circuit-breaker.ts";
import {
  LEDGER_MARKER,
  ledgerFromState,
  parseLedger,
} from "../scripts/lib/state/ledger.ts";
import { rearmGrant } from "../scripts/lib/state/round-grant.ts";
import type { PendingVerdict } from "../scripts/lib/state/pass-handoff.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { fakeForge, runIn, SCRIPTS } from "./provisional-fixtures.ts";
import { writeState } from "./state-rows.ts";

const spent = (rounds: number, headCounted = true) => ({ rounds, headCounted });

describe("the round ceiling", () => {
  it("is reached once the heads counted before the resumed one fill it", () => {
    expect(atRoundCeiling(spent(9), 8)).toBe(true);
    expect(atRoundCeiling(spent(8), 8)).toBe(false);
    expect(atRoundCeiling(spent(8, false), 8)).toBe(true);
  });

  it("caps a re-arm's grant: the grant counts the stop on the ceiling, and the enforced budget is the smaller", () => {
    // max_rounds 10, ceiling 8: the 9th head was counted and refused.
    const grant = rearmGrant(
      { rounds: 9, attempts: 1, granted: 0, headCounted: true },
      10,
      Math.min(10, roundCeiling(8, 0)),
    );
    expect(grant).toEqual({ granted: 8, resetAttempts: true });
    expect(Math.min(10 + grant.granted, roundCeiling(8, 0))).toBe(8);
  });

  it("is raised by one block by an override, only once it is reached, and never lowered", () => {
    expect(raisedCeiling(spent(9), 8, 0, 10)).toBe(10);
    expect(roundCeiling(8, raisedCeiling(spent(9), 8, 0, 10))).toBe(18);
    // Read again below the raised ceiling: nothing more.
    expect(raisedCeiling(spent(9), 8, 10, 10)).toBe(10);
    expect(raisedCeiling(spent(3), 8, 0, 10)).toBe(0);
    // Reached again after the first raise: one more block.
    expect(raisedCeiling(spent(19), 8, 10, 10)).toBe(20);
  });
});

describe("the wall-clock cap", () => {
  const hour = 3_600_000;
  const first = "2026-01-01T00:00:00.000Z";
  const at = (h: number) => parseMs(first) + h * hour;

  it("measures hours from the first launch, and none before one", () => {
    expect(hoursDriven(first, at(5))).toBe(5);
    expect(hoursDriven(undefined, at(5))).toBe(0);
  });

  it("is spent at the cap plus what overrides added, never with no cap", () => {
    expect(wallClockSpent(4, 0, 4)).toBe(true);
    expect(wallClockSpent(4, 0, 3.9)).toBe(false);
    expect(wallClockSpent(4, 5, 8)).toBe(false);
    expect(wallClockSpent(null, 0, 1000)).toBe(false);
  });

  it("is moved on by one more cap from now by an override, once spent", () => {
    expect(raisedWallClock(4, 0, 6)).toBe(6);
    expect(wallClockSpent(4, raisedWallClock(4, 0, 6), 6)).toBe(false);
    expect(raisedWallClock(4, 0, 2)).toBe(0);
    expect(raisedWallClock(null, 0, 6)).toBe(0);
  });
});

describe("the divergence stop", () => {
  const round = (
    n: number,
    newFindings: number,
    fixedFindings: number,
    open = 3,
  ): RoundFindings => ({
    round: n,
    head: "a".repeat(40),
    newFindings,
    fixedFindings,
    open,
  });

  it("reads the gate's open threads and summary findings by key", () => {
    expect(
      openFindingKeys({
        work: {
          unresolvedThreadKeys: ["PRRT_b", "PRRT_a"],
          summaryUnaddressedKeys: ["f1"],
        },
      }),
    ).toEqual(["PRRT_a", "PRRT_b", "f1"]);
    expect(openFindingKeys({ work: { unresolvedThreadKeys: [] } })).toBeNull();
  });

  it("leaves out the summary findings the reviewer holds as not blocking", () => {
    expect(
      openFindingKeys({
        work: {
          unresolvedThreadKeys: ["PRRT_a"],
          summaryUnaddressedKeys: ["f1", "held1", "held2"],
          summaryNotBlockingKeys: ["held2", "held1"],
        },
      }),
    ).toEqual(["PRRT_a", "f1"]);
    expect(
      openFindingKeys({
        work: {
          unresolvedThreadKeys: [],
          summaryUnaddressedKeys: ["held1"],
          summaryNotBlockingKeys: ["held1"],
        },
      }),
    ).toEqual([]);
    expect(
      openFindingKeys({
        work: {
          unresolvedThreadKeys: [],
          summaryUnaddressedKeys: ["f1"],
          summaryNotBlockingKeys: "f1",
        },
      }),
    ).toBeNull();
  });

  it("counts what is newly open and what is no longer open, and nothing for a gate that did not move", () => {
    expect(findingMovement(["a", "b"], ["b", "c", "d"])).toEqual({
      newFindings: 2,
      fixedFindings: 1,
    });
    expect(findingMovement(["a"], ["a"])).toEqual({
      newFindings: 0,
      fixedFindings: 0,
    });
    expect(findingMovement(undefined, ["a"])).toBeNull();
  });

  it("parks after two rounds in a row that each raised more findings than they fixed", () => {
    expect(divergenceStops([round(1, 4, 3), round(2, 2, 1)])).toBe(true);
    expect(divergenceStops([round(1, 1, 0)])).toBe(false);
  });

  it("does not count a round that raised as many findings as it fixed", () => {
    expect(diverges(round(1, 8, 8))).toBe(false);
    expect(diverges(round(1, 9, 8))).toBe(true);
    expect(divergenceStops([round(1, 3, 3), round(2, 2, 2)])).toBe(false);
    expect(divergenceStops([round(1, 3, 2), round(2, 6, 6)])).toBe(false);
  });

  it("does not park when findings strictly decrease", () => {
    expect(
      divergenceStops([round(1, 1, 3), round(2, 0, 2), round(3, 1, 2)]),
    ).toBe(false);
  });

  it("does not park when a diverging round is followed by a converging one", () => {
    expect(
      divergenceStops([round(1, 3, 2), round(2, 0, 1), round(3, 2, 1)]),
    ).toBe(false);
  });

  it("does not count a round that raised nothing, and needs a finding still open", () => {
    expect(divergenceStops([round(1, 0, 0), round(2, 0, 0)])).toBe(false);
    expect(divergenceStops([round(1, 3, 2), round(2, 3, 2, 0)])).toBe(false);
  });

  it("keeps the last rounds only", () => {
    let history: RoundFindings[] = [];
    for (let n = 1; n <= 10; n++)
      history = withRoundFindings(history, round(n, 1, 1));
    expect(history.map((r) => r.round)).toEqual([7, 8, 9, 10]);
  });
});

describe("the circuit breaker's parks", () => {
  const facts: CeilingFacts = {
    pr: "999",
    rounds: 8,
    hoursDriven: 12.25,
    ceiling: 8,
    ceilingSource: "the default",
    raised: 0,
    wallClock: null,
    cause: "rounds",
    block: 10,
    overrideCommand: "bun arm-drive.ts 999 --past-ceiling",
  };

  it("frames round-ceiling as a valid decision that states the rounds, the hours, the ceiling and the refusal", () => {
    const decision = roundCeilingDecision(facts);
    expect(checkParkedDecision(decision, "human-decision")).toEqual([]);
    const text = decision.steps.join("\n");
    expect(text).toContain("8 distinct reviewed head(s)");
    expect(text).toContain("12.3h");
    expect(text).toContain("round ceiling of 8 (the default)");
    expect(text).toContain("Automatic re-arming is refused");
    expect(text).toContain("--past-ceiling");
    expect(decision.call.options.map((o) => o.id)).toContain(
      PAST_CEILING_OPTION,
    );
  });

  it("names the wall-clock cap when that is what stopped the drive", () => {
    const decision = roundCeilingDecision({
      ...facts,
      cause: "wall-clock",
      wallClock: {
        hours: 6,
        source: "drive.max_wall_clock_hours",
        raisedHours: 0,
      },
    });
    expect(checkParkedDecision(decision, "human-decision")).toEqual([]);
    expect(decision.call.question).toContain("wall-clock cap");
    expect(decision.steps.join("\n")).toContain("wall-clock cap is 6h");
  });

  it("frames divergence-stop with the round-over-round counts", () => {
    const decision = divergenceDecision(
      "999",
      [
        {
          round: 3,
          head: "b".repeat(40),
          newFindings: 2,
          fixedFindings: 1,
          open: 2,
        },
        {
          round: 4,
          head: "c".repeat(40),
          newFindings: 2,
          fixedFindings: 2,
          open: 2,
        },
      ],
      2,
    );
    expect(checkParkedDecision(decision, "human-decision")).toEqual([]);
    expect(decision.steps).toContain(
      "Round 4 (head cccccccccccc): 2 new finding(s), 2 fixed, 2 open.",
    );
  });

  it("reads only an unconditional choice of the override as one", () => {
    const decision = roundCeilingDecision(facts);
    const verdict = (option: string, note?: string): PendingVerdict => ({
      kind: "finding",
      key: ROUND_CEILING_PARK,
      reason: decision.call.question,
      decision,
      answers: [
        {
          url: "https://example.invalid/c/1",
          at: "2026-01-01T00:00:00.000Z",
          author: "person",
          body: `answer ${ROUND_CEILING_PARK}: choose ${option}`,
          choice: {
            option,
            recommended: false,
            form: "choose",
            ...(note === undefined ? {} : { note }),
          },
        },
      ],
    });
    expect(answerRaisesCeiling(verdict("Allow one more budget"))).toBe(true);
    expect(answerRaisesCeiling(verdict("Finish by hand"))).toBe(false);
    expect(
      answerRaisesCeiling(
        verdict("Allow one more budget", "only if CI is green"),
      ),
    ).toBe(false);
  });
});

describe("the circuit fields in the state and the ledger", () => {
  it("accepts absent fields and refuses malformed ones", () => {
    expect(isOptionalCircuit({})).toBe(true);
    expect(
      isOptionalCircuit({
        ceilingRaised: 10,
        firstDrivenAt: "2026-01-01T00:00:00.000Z",
        wallClockRaisedHours: 1.5,
        openFindings: ["a"],
        roundFindings: [],
      }),
    ).toBe(true);
    expect(isOptionalCircuit({ ceilingRaised: -1 })).toBe(false);
    expect(isOptionalCircuit({ firstDrivenAt: "yesterday" })).toBe(false);
    expect(malformedLedgerCircuit({ ceilingRaised: "ten" })).toEqual([
      "ceilingRaised",
    ]);
  });

  it("seeds the ledger's raises and the earlier first launch", () => {
    const state: Record<string, unknown> = {
      ceilingRaised: 20,
      firstDrivenAt: "2026-01-02T00:00:00.000Z",
    };
    seedCircuit(state, { firstDrivenAt: "2026-01-01T00:00:00.000Z" });
    expect(state).toEqual({ firstDrivenAt: "2026-01-01T00:00:00.000Z" });
  });

  it("seeds a person's circuit stop and the consumed overrides, and flags a malformed first launch", () => {
    const stop = {
      key: "round-ceiling",
      choice: "Finish by hand",
      at: "2026-01-01T00:00:00.000Z",
    };
    const state: Record<string, unknown> = {};
    seedCircuit(state, { circuitStop: stop, usedOverrides: ["k"] });
    expect(state).toEqual({ circuitStop: stop, usedOverrides: ["k"] });
    expect(malformedLedgerCircuit({ firstDrivenAt: "soon" })).toEqual([
      "firstDrivenAt",
    ]);
    expect(malformedLedgerCircuit({ circuitStop: { key: 1 } })).toEqual([
      "circuitStop",
    ]);
  });
});

describe("the settings", () => {
  /** What the two settings read under an overlay whose `drive` section is `drive`. */
  async function readSettings(drive: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "circuit-settings-"));
    const overlay = join(dir, "overlay.json");
    writeFileSync(overlay, JSON.stringify({ drive }));
    const module = join(
      import.meta.dir,
      "..",
      "scripts",
      "lib",
      "circuit-settings.ts",
    );
    const p = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import(${JSON.stringify(module)}).then((m) => { try { console.log(JSON.stringify([m.maxTotalRoundsSetting().value, m.maxWallClockHoursSetting()?.value ?? null])); } catch (e) { console.log(JSON.stringify(String(e.message))); } })`,
      ],
      {
        cwd: dir,
        env: { ...process.env, JIG_OVERLAY: overlay },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    return JSON.parse(stdout) as unknown;
  }

  it("defaults to a ceiling of 8 and no wall-clock cap", async () => {
    expect(await readSettings({})).toEqual([8, null]);
  });

  it("reads the documented range", async () => {
    expect(
      await readSettings({ max_total_rounds: 50, max_wall_clock_hours: 1.5 }),
    ).toEqual([50, 1.5]);
  });

  it.each([0, 51, 2.5, "eight"])(
    "refuses a ceiling of %p, naming the setting",
    async (value) => {
      expect(String(await readSettings({ max_total_rounds: value }))).toContain(
        "drive.max_total_rounds must be a whole number from 1 to 50",
      );
    },
  );

  it.each([0, 0.05, -2, "six"])(
    "refuses a wall-clock cap of %p, naming the setting",
    async (value) => {
      const read = await readSettings({ max_wall_clock_hours: value });
      expect(String(read)).toContain(
        "drive.max_wall_clock_hours must be a number of hours of at least 0.1",
      );
    },
  );
});

describe("the divergence stop at the round gates", () => {
  const LIB = join(SCRIPTS, "lib");
  /** Run `checkDivergence` on each status in turn, then print the exits and the stored state. */
  const PROBE = `
import { checkDivergence } from ${JSON.stringify(join(LIB, "driver", "circuit-breaker.ts"))};
import { openStore } from ${JSON.stringify(join(LIB, "state", "store.ts"))};
const statuses = JSON.parse(await Bun.stdin.text());
const exits = [];
for (const status of statuses) exits.push(await checkDivergence("12", status, false));
const state = (await openStore("12")).read().state;
console.log(JSON.stringify({ exits, history: state.roundFindings ?? [], parked: state.parked.map((p) => p.key) }));
`;

  async function gates(statuses: Record<string, unknown>[]) {
    const forge = fakeForge();
    writeState(forge.stateDir, "12", freshState(12));
    const file = join(forge.dir, "probe.ts");
    writeFileSync(file, PROBE);
    const r = await runIn(forge, file, [], {
      stdin: JSON.stringify(statuses),
      env: { DRIVE_PR_TARGET: "12" },
    });
    expectSpawnExit(r, 0);
    return JSON.parse(r.stdout) as {
      exits: (number | null)[];
      history: RoundFindings[];
      parked: string[];
    };
  }

  /** A gate whose open summary findings are `open`, of which `held` are rendered not blocking. */
  const gate = (open: string[], held: string[], n: number) => ({
    head: { api: String(n).repeat(40) },
    work: {
      unresolvedThreadKeys: [],
      summaryUnaddressedKeys: open,
      summaryNotBlockingKeys: held,
    },
  });

  it("records open 0 and never parks when only not-blocking findings churn", async () => {
    const churn = [
      ["h1"],
      ["h2", "h3"],
      ["h4", "h5", "h6"],
      ["h7", "h8", "h9", "h10"],
    ];
    const r = await gates(churn.map((keys, n) => gate(keys, keys, n + 1)));
    expect(r.exits).toEqual([null, null, null, null]);
    expect(r.parked).not.toContain("divergence-stop");
    expect(r.history.every((h) => h.open === 0)).toBe(true);
  });

  it("still parks when the blocking findings beside them grow", async () => {
    const r = await gates([
      gate(["b1", "h1"], ["h1"], 1),
      gate(["b2", "b3", "h2"], ["h2"], 2),
      gate(["b4", "b5", "b6", "h3"], ["h3"], 3),
    ]);
    expect(r.exits.at(-1)).toBe(8);
    expect(r.parked).toContain("divergence-stop");
    expect(
      r.history.map((h) => [h.newFindings, h.fixedFindings, h.open]),
    ).toEqual([
      [2, 1, 2],
      [3, 2, 3],
    ]);
  });
});

describe("a person's answers to the circuit breaker's parks", () => {
  const LIB = join(SCRIPTS, "lib");
  /** Apply `verdicts` as a re-arm does, then print the override flag and the stored history. */
  const PROBE = `
import { applyCircuitAnswers, pastCeilingAnswered } from ${JSON.stringify(join(LIB, "driver", "circuit-breaker.ts"))};
import { openStore } from ${JSON.stringify(join(LIB, "state", "store.ts"))};
const verdicts = JSON.parse(await Bun.stdin.text());
await applyCircuitAnswers("12", verdicts, false);
const state = (await openStore("12")).read().state;
console.log(JSON.stringify({ override: pastCeilingAnswered(), history: state.roundFindings ?? null, stop: state.circuitStop ?? null }));
`;

  async function apply(verdicts: PendingVerdict[]) {
    const forge = fakeForge();
    writeState(forge.stateDir, "12", {
      ...freshState(12),
      roundFindings: [
        {
          round: 1,
          head: "a".repeat(40),
          newFindings: 2,
          fixedFindings: 1,
          open: 2,
        },
      ],
    });
    const file = join(forge.dir, "probe.ts");
    writeFileSync(file, PROBE);
    const r = await runIn(forge, file, [], {
      stdin: JSON.stringify(verdicts),
      env: { DRIVE_PR_TARGET: "12" },
    });
    expectSpawnExit(r, 0);
    return JSON.parse(r.stdout) as {
      override: boolean;
      history: unknown;
      stop: { key: string; choice: string } | null;
    };
  }

  const ceiling = roundCeilingDecision({
    pr: "12",
    rounds: 8,
    hoursDriven: 1,
    ceiling: 8,
    ceilingSource: "the default",
    raised: 0,
    wallClock: null,
    cause: "rounds",
    block: 10,
    overrideCommand: "bun arm-drive.ts 12 --past-ceiling",
  });
  const answer = (
    key: string,
    option: string,
    decision: PendingVerdict["decision"],
  ) =>
    ({
      kind: "finding",
      key,
      reason: "q?",
      ...(decision === undefined ? {} : { decision }),
      answers: [
        {
          url: "https://example.invalid/c/1",
          at: "2026-01-01T00:00:00.000Z",
          author: "person",
          body: `answer ${key}: choose ${option}`,
          choice: { option, recommended: false, form: "choose" },
        },
      ],
    }) satisfies PendingVerdict;

  it("lets the launch drive past the ceiling on the override answer, and on no other", async () => {
    expect(
      (
        await apply([
          answer(ROUND_CEILING_PARK, "Allow one more budget", ceiling),
        ])
      ).override,
    ).toBe(true);
    expect(
      (await apply([answer(ROUND_CEILING_PARK, "Finish by hand", ceiling)]))
        .override,
    ).toBe(false);
  });

  it("starts the count of diverging rounds again only on Continue driving", async () => {
    const decision = divergenceDecision("12", [], 2);
    const answered = await apply([
      answer("divergence-stop", "Continue driving", decision),
    ]);
    expect(answered.history).toBeNull();
    expect(answered.stop).toBeNull();
  });

  it.each(["Finish by hand", "Re-scope or close"])(
    "keeps the drive stopped on a %p answer to divergence-stop",
    async (option) => {
      const decision = divergenceDecision("12", [], 2);
      const kept = await apply([answer("divergence-stop", option, decision)]);
      expect(kept.history).toHaveLength(1);
      expect(kept.stop).toMatchObject({
        key: "divergence-stop",
        choice: option,
      });
    },
  );

  it("keeps the drive stopped on a Finish by hand answer to round-ceiling", async () => {
    const kept = await apply([
      answer(ROUND_CEILING_PARK, "Finish by hand", ceiling),
    ]);
    expect(kept.override).toBe(false);
    expect(kept.stop).toMatchObject({
      key: ROUND_CEILING_PARK,
      choice: "Finish by hand",
    });
  });
});

describe("an in-flight pass under the wall-clock cap", () => {
  const limits = (hoursAgo: number, cap: number | null): CircuitLimits => ({
    pr: "1",
    maxTotal: { value: 8, source: "default" },
    raised: 0,
    ceiling: 8,
    wallClock: cap === null ? null : { value: cap, source: "default" },
    raisedHours: 0,
    firstDrivenAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    block: 10,
  });

  it("cuts the pass deadline to the time the cap has left, and gives a disabled deadline that bound", () => {
    const sec = passDeadlineUnderCap(limits(0.9, 1), 5400);
    expect(sec).toBeGreaterThan(0);
    expect(sec).toBeLessThanOrEqual(360);
    expect(passDeadlineUnderCap(limits(0.9, 1), 0)).toBeLessThanOrEqual(360);
  });

  it("leaves the configured deadline when no cap binds sooner, and never reaches zero", () => {
    expect(passDeadlineUnderCap(limits(0, 100), 5400)).toBe(5400);
    expect(passDeadlineUnderCap(limits(0, null), 5400)).toBe(5400);
    expect(passDeadlineUnderCap(undefined, 0)).toBe(0);
    expect(passDeadlineUnderCap(limits(5, 1), 5400)).toBe(1);
  });
});

describe("a ledger with a malformed circuit stop", () => {
  it("is refused, since dropping it would resume a drive a person stopped", () => {
    const ledger = ledgerFromState(freshState(999), {
      generation: 1,
      claims: [],
      narrative: [],
      driver: {
        actor: "wt-aaaaaaaaaaaaaaaa",
        clone: "clone-a",
        heartbeat: "2026-11-20T00:00:00.000Z",
        state: "running",
      },
    });
    const parsed = parseLedger(
      `${LEDGER_MARKER}\n<!-- drive-pr-ledger-data\n${JSON.stringify({ ...ledger, circuitStop: { key: 1 } })}\n-->\n`,
    );
    expect(parsed?.kind).toBe("malformed");
  });
});
