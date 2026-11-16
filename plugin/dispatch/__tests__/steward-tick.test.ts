import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  world,
  type World,
  openPr,
  stoppedLedger,
  ledgerComment,
  checkoutOn,
} from "./fixtures.ts";
import { cloneId } from "../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import { cloneKey } from "../../skills/drive-pr/scripts/lib/state/clone-key.ts";
import { worktreePathKey } from "../../skills/drive-pr/scripts/lib/state/actor.ts";
import { factsOf } from "../lib/actions/drive-hold.ts";
import { account, machineFile, dispatchState } from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";
import { stateDb } from "../lib/state.ts";
import type { TickReceipt } from "../receipts.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import {
  stewardRecords,
  submitStewardRecords,
  readStewardDigest,
} from "../lib/steward.ts";

let current: World | null = null;
afterEach(() => {
  if (current) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});
function fixture(owner = true) {
  const w = world();
  current = w;
  w.setConfig(
    "issue_tracker:\n  adapter: github\ndispatch:\n  identity: factory-bot\n",
  );
  withOrigin(w);
  machineFile(
    w,
    [account(w, "a", "a@example.com")],
    { steward: { enabled: true, every: "20m" } },
    ["steward"],
    { owner },
  );
  // A drive stopped for a person: a re-arm could resolve it, so it is in the judgment backlog.
  stopped(w, [7]);
  return w;
}
function stopped(w: World, prs: number[]) {
  w.setPrs(
    "open",
    prs.map((n) => openPr(n, `feature/stopped-${n}`)),
  );
  for (const n of prs)
    w.setComments(n, [ledgerComment(n * 100 + 1, stoppedLedger(n, 2))]);
}
async function tick(w: World) {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}
describe("steward tick integration", () => {
  test("owner schedules a complex-model pass under a 15 minute deadline, and an unchanged backlog never schedules another", async () => {
    const w = fixture();
    const first = await tick(w);
    expect(first.repos[0]?.launches).toMatchObject([
      { action: "steward", outcome: "launched" },
    ]);
    expect(first.repos[0]?.steward?.trigger).toBe("started");
    const db = stateDb(dispatchState(w));
    const row = db
      .query("SELECT id, record FROM launches WHERE action = 'steward'")
      .get() as { id: string; record: string };
    expect(JSON.parse(row.record)).toMatchObject({
      action: "steward",
      passTimeoutSec: 900,
      model: "opus",
      headless: true,
    });
    // End the stored reservation so this assertion exercises the judged backlog, not the live-slot guard.
    db.query("UPDATE launches SET exit = ?, result = 'done' WHERE id = ?").run(
      JSON.stringify({ at: new Date().toISOString(), code: 0, signal: null }),
      row.id,
    );
    db.query(
      "UPDATE steward_runs SET at_ms = at_ms - 1200001, submitted = 1",
    ).run();
    const next = await tick(w);
    expect(
      next.repos[0]?.launches.filter((r) => r.action === "steward"),
    ).toEqual([]);
    expect(next.repos[0]?.steward?.trigger).toBe("judged");
    expect(db.query("SELECT COUNT(*) AS n FROM steward_runs").get()).toEqual({
      n: 1,
    });
  }, 60_000);
  test("a new backlog member starts a pass in the same tick, and the hourly budget refuses a fourth", async () => {
    const w = fixture();
    const db = stateDb(dispatchState(w));
    const endSteward = () => {
      db.query(
        "UPDATE launches SET exit = ?, result = 'done' WHERE action = 'steward' AND exit IS NULL",
      ).run(
        JSON.stringify({ at: new Date().toISOString(), code: 0, signal: null }),
      );
      db.query("UPDATE steward_runs SET submitted = 1").run();
    };
    const stewardLaunches = (receipt: TickReceipt) =>
      receipt.repos[0]?.launches.filter((r) => r.action === "steward");
    for (const prs of [[7], [7, 8], [7, 8, 9]]) {
      stopped(w, prs);
      const receipt = await tick(w);
      expect(stewardLaunches(receipt)).toMatchObject([{ outcome: "launched" }]);
      endSteward();
      expect(stewardLaunches(await tick(w))).toEqual([]);
    }
    stopped(w, [7, 8, 9, 10]);
    const fourth = await tick(w);
    expect(stewardLaunches(fourth)).toEqual([]);
    expect(fourth.repos[0]?.steward).toEqual({
      status: "the host's hourly steward budget is spent",
      trigger: "budget",
    });
    expect(db.query("SELECT COUNT(*) AS n FROM steward_runs").get()).toEqual({
      n: 3,
    });
  }, 60_000);
  test("an empty backlog starts no pass, and the dashboard says why", async () => {
    const w = fixture();
    w.setPrs("open", []);
    const receipt = await tick(w);
    expect(receipt.repos[0]?.launches).toEqual([]);
    expect(receipt.repos[0]?.steward).toEqual({
      status: "the judgment backlog is empty",
      trigger: "empty",
    });
    const row = stateDb(dispatchState(w))
      .query("SELECT line FROM tick_line WHERE id = 1")
      .get() as { line: string };
    const line = JSON.parse(row.line) as LineSnapshot;
    expect(line.repos[0]?.notes).toContain(
      "steward not started: the judgment backlog is empty",
    );
  }, 60_000);
  test("a non-owner host never starts a steward or stores a digest", async () => {
    const w = fixture(false);
    const receipt = await tick(w);
    expect(receipt.repos[0]?.launches).toEqual([]);
    expect(
      stateDb(dispatchState(w))
        .query("SELECT COUNT(*) AS n FROM steward_runs")
        .get(),
    ).toEqual({ n: 0 });
  }, 60_000);
  test("records submitted by a pass wait until a later tick, and a forged human-stop rearm is consumed without launching", async () => {
    const w = fixture();
    await tick(w);
    const root = dispatchState(w);
    const db = stateDb(root);
    const row = db.query("SELECT id FROM steward_runs LIMIT 1").get() as {
      id: string;
    };
    w.setPrs("open", [openPr(7, "feature/stopped")]);
    w.setComments(7, [ledgerComment(701, stoppedLedger(7, 18))]);
    expect(
      submitStewardRecords(
        row.id,
        [
          {
            kind: "rearm",
            target: "PR #7",
            facts: "generation 1",
            class: "transient",
            reason: "timed out",
          },
        ],
        root,
      ),
    ).toEqual({ ok: true, value: "submitted" });
    expect(stewardRecords("example-org/example-repo", root)[0]?.applied).toBe(
      false,
    );
    const receipt = await tick(w);
    expect(stewardRecords("example-org/example-repo", root)[0]?.applied).toBe(
      true,
    );
    expect(receipt.repos[0]?.launches.some((r) => r.action === "rearm")).toBe(
      false,
    );
  }, 60_000);
  test("a transient recovery waits for an account, then launches once and spends the shared recovery budget", async () => {
    const w = fixture();
    machineFile(
      w,
      [{ ...account(w, "a", "a@example.com"), max: 1 }],
      { steward: { enabled: true, every: "20m" } },
      ["steward", "rearm"],
    );
    const ws = join(w.root, "original-stopped-tree");
    checkoutOn(w.repo, ws, "feature/steward", w.env);
    const ledger = stoppedLedger(7, 2);
    ledger.driver.actor = `wt-${worktreePathKey(ws)}`;
    ledger.driver.clone = cloneId(cloneKey(join(w.repo, ".git")));
    ledger.narrative = [
      "The forge request timed out during a brief outage; retry the same operation.",
    ];
    w.setPrs("open", [openPr(7, "feature/steward")]);
    w.setComments(7, [ledgerComment(701, ledger)]);
    w.setWorkspaces([{ branch: "feature/steward", linkedPR: 7, path: ws }]);
    await tick(w);
    const root = dispatchState(w);
    const db = stateDb(root);
    const row = db.query("SELECT id FROM steward_runs LIMIT 1").get() as {
      id: string;
    };
    const digest = readStewardDigest(row.id, root);
    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    const pr = digest.value.drives[0];
    expect(pr?.class).toBe("needs-person");
    if (!pr) return;
    expect(
      submitStewardRecords(
        row.id,
        [
          {
            kind: "rearm",
            target: "PR #7",
            facts: factsOf(pr),
            class: "forge-timeout",
            reason: "the handoff records a transient forge outage",
          },
        ],
        root,
      ),
    ).toEqual({ ok: true, value: "submitted" });
    const waiting = await tick(w);
    expect(
      waiting.repos[0]?.launches.some(
        (l) => l.action === "rearm" && l.outcome === "waits",
      ),
    ).toBe(true);
    expect(stewardRecords("example-org/example-repo", root)[0]?.applied).toBe(
      false,
    );
    db.query("UPDATE launches SET exit = ? WHERE id = ?").run(
      JSON.stringify({ at: new Date().toISOString(), code: 0, signal: null }),
      row.id,
    );
    writeFileSync(join(w.dir, "orca-terminal-noop"), "");
    const recovered = await tick(w);
    expect(recovered.repos[0]?.launches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "rearm", outcome: "launched" }),
      ]),
    );
    const launch = db
      .query("SELECT id, record FROM launches WHERE action = 'rearm'")
      .get() as { id: string; record: string };
    expect(JSON.parse(launch.record).facts).toStartWith("recovery: ");
    expect(stewardRecords("example-org/example-repo", root)[0]?.applied).toBe(
      true,
    );
    // Simulate a response lost before the wrapper claimed its reservation.
    const pending = JSON.parse(launch.record);
    pending.attempts = [
      {
        at: new Date().toISOString(),
        outcome: "lost",
        detail: "response lost",
      },
    ];
    db.query(
      "UPDATE launches SET record = ?, claim = NULL, exit = NULL WHERE id = ?",
    ).run(JSON.stringify(pending), launch.id);
    const replayed = await tick(w);
    expect(replayed.repos[0]?.launches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "rearm",
          outcome: "retried",
          record: launch.id,
        }),
      ]),
    );
    expect(
      db
        .query("SELECT COUNT(*) AS n FROM launches WHERE action = 'rearm'")
        .get(),
    ).toEqual({ n: 1 });
    expect(
      (await tick(w)).repos[0]?.launches.some((l) => l.action === "rearm"),
    ).toBe(false);
  }, 60_000);
});
