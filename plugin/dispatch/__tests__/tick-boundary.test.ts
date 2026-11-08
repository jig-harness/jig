/**
 * dispatch: the tick's boundaries. A defect thrown in one repository's turn
 * stops that turn only, a defect in the closing steps still leaves a
 * receipt, and every receipt carries each phase's milliseconds. Each tick
 * runs in a child with its own home (fixtures.ts), from a script that
 * injects the defect.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  assignedIssue,
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";

const DISPATCH = resolve(import.meta.dir, "..");

/**
 * A tick over the world's repository and a second checkout of it, whose
 * runtime gives the first repository a malformed answer (a bug in a runtime:
 * `ok` with no workspaces) and the second Orca's own.
 */
const MALFORMED_RUNTIME = `import { orcaRuntime } from ${JSON.stringify(`${DISPATCH}/lib/runtime/orca.ts`)};
import { runTick } from ${JSON.stringify(`${DISPATCH}/tick.ts`)};
const orca = orcaRuntime();
const first = process.argv[2];
const runtime = {
  ...orca,
  name: orca.name,
  interactiveBinding: orca.interactiveBinding,
  // The first repository's answer is malformed, whichever repository asks first.
  sessions: async (repo, join) => (repo.path === first ? { ok: true, source: "stub", workspaces: null } : orca.sessions(repo, join)),
  // Every answer comes from \`sessions\` above, not Orca's reader for a tick.
  sessionsOnce: undefined,
};
const result = await runTick({ repos: process.argv.slice(2), runtime, followupSince: "2026-10-30T00:00:00Z" });
if ("held" in result) process.exit(3);
console.log(JSON.stringify(result.receipt));
process.exit(result.receipt.exitStatus);
`;

/** A tick whose closing step, settling the records of repositories it did not read, throws. */
const CLOSING_DEFECT = `import { mock } from "bun:test";
const settle = ${JSON.stringify(`${DISPATCH}/lib/tick-settle.ts`)};
const real = await import(settle);
const { logRepo } = real;
mock.module(settle, () => ({ logRepo, settleOutcomes: async () => { throw new TypeError("a bug in the closing steps"); } }));
const { runTick } = await import(${JSON.stringify(`${DISPATCH}/tick.ts`)});
const { readMachineConfig } = await import(${JSON.stringify(`${DISPATCH}/lib/machine-config.ts`)});
const machine = readMachineConfig();
if (!machine.ok) throw new Error(machine.failure.reason);
const result = await runTick({ machine: machine.value, repos: process.argv.slice(2), followupSince: "2026-10-30T00:00:00Z" });
if ("held" in result) process.exit(3);
console.log(JSON.stringify(result.receipt));
process.exit(result.receipt.exitStatus);
`;

/** A tick whose follow-up outcomes cannot be written, at the start and again at the close. */
const SETTLE_DEFECT = `import { mock } from "bun:test";
const outcomes = ${JSON.stringify(`${DISPATCH}/lib/followup-outcomes.ts`)};
const real = await import(outcomes);
mock.module(outcomes, () => ({ ...real, settleFollowups: () => { throw new TypeError("a write failed"); } }));
const { runTick } = await import(${JSON.stringify(`${DISPATCH}/tick.ts`)});
const result = await runTick({ repos: process.argv.slice(2), followupSince: "2026-10-30T00:00:00Z" });
if ("held" in result) process.exit(3);
console.log(JSON.stringify(result.receipt));
process.exit(result.receipt.exitStatus);
`;

/** A tick over an ended follow-up record older than the retention, whose outcome write fails \`FAILS\` times (every time when negative), then reports the rows left. */
const aged = (fails: number, repo: string) => `import { mock } from "bun:test";
const outcomes = ${JSON.stringify(`${DISPATCH}/lib/followup-outcomes.ts`)};
const real = await import(outcomes);
const realSettle = real.settleFollowups;
let calls = 0;
mock.module(outcomes, () => ({ ...real, settleFollowups: (...args) => { if (${fails} < 0 || calls++ < ${fails}) throw new TypeError("a write failed"); return realSettle(...args); } }));
const { writeRecord, recordExit } = await import(${JSON.stringify(`${DISPATCH}/lib/launches.ts`)});
const { stateDb } = await import(${JSON.stringify(`${DISPATCH}/lib/state.ts`)});
const id = "20260101T000000Z-aaaaaaaa";
writeRecord({ version: 1, id, token: "t", action: "followup", repo: ${JSON.stringify(repo)}, repoPath: "/r", pr: 7, account: "a", vendor: "claude", configDir: "/c", wallBackoffMs: 1, replaces: null, facts: "", createdAt: "2026-01-01T00:00:00.000Z", workspace: null, attempts: [], item: null, agentId: null, model: null, effort: null, released: false, command: null, marker: null });
recordExit(id, { at: "2026-01-01T01:00:00.000Z", code: 0, signal: null });
const { runTick } = await import(${JSON.stringify(`${DISPATCH}/tick.ts`)});
const result = await runTick({ repos: process.argv.slice(2), followupSince: "2026-10-30T00:00:00Z" });
if ("held" in result) process.exit(3);
const db = stateDb();
console.log(JSON.stringify({
  receipt: result.receipt,
  rows: db.query("SELECT id FROM launches WHERE id = ?").all(id).length,
  outcomes: db.query("SELECT outcome FROM followup_outcomes WHERE pr = 7").all().length,
}));
process.exit(result.receipt.exitStatus);
`;

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** One assigned item and one quota-parked pull request, in a world with a second checkout. */
function fixture(): { w: World; second: string } {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setIssues([assignedIssue(12, "factory-bot", [])]);
  w.setAssigner(12, "maintainer", "WRITE");
  w.setPrs("open", [openPr(7, "feature/7-parked")]);
  w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16))]);
  const second = join(w.root, "second");
  mkdirSync(second, { recursive: true });
  return { w, second };
}

async function run(
  w: World,
  name: string,
  script: string,
  repos: string[],
): Promise<{ receipt: TickReceipt; stderr: string }> {
  const entry = join(w.root, name);
  writeFileSync(entry, script);
  const r = await w.dispatch(repos, entry);
  expectSpawnExit(r, 1);
  return { receipt: JSON.parse(r.stdout) as TickReceipt, stderr: r.stderr };
}

describe("a defect in one repository's turn", () => {
  it("stops that turn only: the next repository is planned, the receipt names the defect, its stack goes to the log, and the tick exits 1", async () => {
    const { w, second } = fixture();
    const { receipt, stderr } = await run(
      w,
      "malformed-runtime.ts",
      MALFORMED_RUNTIME,
      [w.repo, second],
    );
    const [broken, next] = receipt.repos;
    expect(broken?.path).toBe(w.repo);
    expect(broken?.defect?.code).toBe("defect");
    expect(broken?.defect?.phase).toBe("runtime");
    expect(broken?.defect?.reason).toStartWith(
      "a TypeError was thrown in the runtime phase: ",
    );
    expect(broken?.refused).toContain(
      "a defect stopped this repository's turn, and nothing after it was done this tick: a TypeError was thrown in the runtime phase",
    );
    // The stack goes to the log, never on the receipt.
    expect(JSON.stringify(receipt)).not.toContain("tick-observe.ts");
    // What the phases before the defect read stays on the report.
    expect(broken?.records.map((r) => r.record)).toEqual(["tracker", "forge"]);
    expect(next?.path).toBe(second);
    expect(next?.defect).toBeUndefined();
    expect(next?.actions.map((a) => [a.stage, a.target])).toEqual([
      ["pickup", "#12"],
      ["rearm", "PR #7"],
    ]);
    expect(receipt.completed).toBe(true);
    expect(receipt.exitStatus).toBe(1);
    expect(stderr).toContain(
      `a defect stopped ${SLUG}'s turn: a TypeError was thrown in the runtime phase`,
    );
    expect(stderr).toContain("tick-observe.ts");
  });
});

describe("a defect in the tick's closing steps", () => {
  it.each([true, false])(
    "still writes the receipt and preserves repository coverage (full sweep: %s)",
    async (sweep) => {
      const { w, second } = fixture();
      machineFile(w, [account(w, "a", "a@example.com")]);
      const seed = await w.dispatch(["--json"]);
      expectSpawnExit(seed, 0);
      const first = JSON.parse(seed.stdout) as TickReceipt;
      if (!sweep)
        machineFile(w, [account(w, "a", "a@example.com")], {
          repositories: [
            { path: w.repo, stages: ["rearm"] },
            { path: second, stages: ["rearm"] },
          ],
        });
      const { receipt, stderr } = await run(
        w,
        "closing-defect.ts",
        CLOSING_DEFECT,
        [w.repo],
      );
      expect(receipt.completed).toBe(false);
      expect(receipt.exitStatus).toBe(1);
      expect(receipt.defect).toEqual({
        code: "defect",
        phase: "close",
        reason:
          "a TypeError was thrown in the close phase: a bug in the closing steps",
      });
      expect(receipt.repos[0]?.actions.map((a) => a.target)).toEqual([
        "#12",
        "PR #7",
      ]);
      expect(stderr).toContain(
        "a defect stopped the tick: a TypeError was thrown in the close phase: a bug in the closing steps\nTypeError: a bug in the closing steps\n    at ",
      );
      const db = new Database(join(dispatchState(w), "state.sqlite"));
      const stored = db
        .query("SELECT line FROM tick_line WHERE id = 1")
        .get() as { line: string };
      db.close();
      const line = JSON.parse(stored.line) as LineSnapshot;
      expect(line.runId).toBe(first.runId);
      expect(line.ticks?.at(-1)).toMatchObject({
        runId: receipt.runId,
        exitStatus: 1,
        defects: 1,
        sweep,
      });
      const listed = await w.dispatch(["receipts"]);
      expectSpawnExit(listed, 0);
      expect(listed.stdout).toContain("incomplete");
      expect(listed.stdout).toContain("1 defect(s)");
    },
  );
});

describe("the receipt's timings", () => {
  it("records each phase's milliseconds per repository and the tick's own, and prints them", async () => {
    const { w } = fixture();
    const r = await w.dispatch(["--repo", w.repo, "--json"]);
    expectSpawnExit(r, 0);
    const receipt = JSON.parse(r.stdout) as TickReceipt;
    const phases = receipt.repos[0]?.phasesMs ?? {};
    expect(Object.keys(phases)).toEqual([
      "open",
      "tracker",
      "forge",
      "claims",
      "runtime",
      "observe",
      "plan",
      "log",
      "apply",
      "labels",
      "shared",
    ]);
    for (const ms of Object.values(phases)) {
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    expect(Object.keys(receipt.phasesMs ?? {})).toEqual([
      "start",
      "observe",
      "wait",
      "act",
      "close",
    ]);
    const text = await w.dispatch(["--repo", w.repo]);
    expectSpawnExit(text, 0);
    expect(text.stdout).toMatch(/\n {2}took {5}\d.*: open \d+ ms, tracker /);
    expect(text.stdout).toMatch(
      /\nTick took .*: start .*, observe .*, wait .*, act .*, close /,
    );
    const listed = await w.dispatch(["receipts"]);
    expectSpawnExit(listed, 0);
    expect(listed.stdout).toMatch(/exit 0 in \d/);
  });
});

describe("follow-up outcomes that cannot be written", () => {
  it("keeps the startup defect on the receipt, not completed, while every repository still has its turn", async () => {
    const { w } = fixture();
    const { receipt } = await run(w, "settle-defect.ts", SETTLE_DEFECT, [
      w.repo,
    ]);
    expect(receipt.defect?.phase).toBe("start");
    expect(receipt.completed).toBe(false);
    expect(receipt.exitStatus).toBe(1);
    expect(receipt.repos.map((r) => r.path)).toEqual([w.repo]);
  });
});

describe("an ended follow-up whose outcome cannot be written", () => {
  async function ageing(fails: number, repo = SLUG) {
    const { w } = fixture();
    const entry = join(w.root, "aged.ts");
    writeFileSync(entry, aged(fails, repo));
    const r = await w.dispatch([w.repo], entry);
    expectSpawnExit(r, 1);
    return JSON.parse(r.stdout) as {
      receipt: TickReceipt;
      rows: number;
      outcomes: number;
    };
  }

  it("keeps its launch row past the retention while every write fails", async () => {
    const { receipt, rows, outcomes } = await ageing(-1);
    expect(rows).toBe(1);
    expect(outcomes).toBe(0);
    expect(receipt.completed).toBe(false);
  });

  it("writes it at the close when only the start failed and its repository had no turn this tick, and prunes it after", async () => {
    const { receipt, rows, outcomes } = await ageing(
      1,
      "example-org/omitted-repo",
    );
    expect(outcomes).toBe(1);
    expect(rows).toBe(0);
    // The defect the start kept stays on the receipt.
    expect(receipt.defect?.phase).toBe("start");
  });
});
