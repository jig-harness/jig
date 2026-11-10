/** A steward must read human holds independently of dispatch label projection. */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { cloneId } from "../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import { cloneKey } from "../../skills/drive-pr/scripts/lib/state/clone-key.ts";
import { worktreePathKey } from "../../skills/drive-pr/scripts/lib/state/actor.ts";
import { factsOf } from "../lib/actions/drive-hold.ts";
import { readRecord, writeRecord } from "../lib/launches.ts";
import { keepStewardRun, submitStewardRecords } from "../lib/steward.ts";
import { stateDb } from "../lib/state.ts";
import type { DrivenPr } from "../lib/types.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  world,
  openPr,
  labeled,
  ledgerComment,
  stoppedLedger,
  SLUG,
  type World,
} from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  if (current) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});
function fixture(automatic = false, prefix: string | null = "work:") {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  labels:\n    enabled: false\n${prefix === null ? "" : `    prefix: '${prefix}'\n`}`,
  );
  withOrigin(w);
  machineFile(
    w,
    [account(w, "a", "a@example.com")],
    { steward: { enabled: true, every: "20m" } },
    automatic ? ["rearm"] : ["rearm", "steward"],
  );
  const ws = join(w.root, "original-stopped-tree");
  mkdirSync(ws, { recursive: true });
  expectSpawnExit(Bun.spawnSync(["git", "init", "-q", ws]), 0);
  const ledger = stoppedLedger(7, automatic ? 16 : 2);
  ledger.driver.actor = `wt-${worktreePathKey(ws)}`;
  ledger.driver.clone = cloneId(cloneKey(join(ws, ".git")));
  ledger.narrative = [
    "The forge request timed out during a brief outage; retry the same operation.",
  ];
  w.setPrs("open", [openPr(7, "feature/steward")]);
  w.setComments(7, [ledgerComment(701, ledger)]);
  w.setWorkspaces([{ branch: "feature/steward", linkedPR: 7, path: ws }]);
  if (!automatic) {
    const pr: DrivenPr = {
      number: 7,
      url: "",
      title: "recover",
      head: "feature/steward",
      class: "needs-person",
      why: "unknown exit",
      evidence: {
        generation: ledger.generation,
        exit: 2,
        heartbeat: ledger.driver.heartbeat,
      },
    };
    keepStewardRun(
      "reviewed-stop",
      {
        version: 1,
        repo: SLUG,
        drives: [pr],
        needs: [],
        queue: [],
        passes: [],
        failures: [],
        load: null,
      },
      Date.now(),
      dispatchState(w),
    );
    expect(
      submitStewardRecords(
        "reviewed-stop",
        [
          {
            kind: "rearm",
            target: "PR #7",
            facts: factsOf(pr),
            class: "forge-timeout",
            reason: "the handoff records a transient timeout",
          },
        ],
        dispatchState(w),
      ).ok,
    ).toBe(true);
  }
  writeFileSync(join(w.dir, "orca-terminal-noop"), "");
  return w;
}
async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}
function failedLabels(w: World) {
  writeFileSync(join(w.dir, "pr-labels-fail"), "");
}
function noStarted(receipt: TickReceipt) {
  expect(
    receipt.repos[0]?.launches.some((l) =>
      ["launched", "retried", "lost"].includes(l.outcome),
    ),
  ).toBe(false);
}

for (const prefix of [null, "work:"]) {
  test(`an initial steward rearm respects ${prefix ?? "jig:"}hold while label projection is off`, async () => {
    const w = fixture(false, prefix);
    w.setPrs("open", [
      labeled(openPr(7, "feature/steward"), `${prefix ?? "jig:"}hold`),
    ]);
    const held = await tick(w);
    noStarted(held);
    expect(held.repos[0]?.launches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "waits",
          detail: expect.stringContaining("hold label"),
        }),
      ]),
    );
    w.setPrs("open", [openPr(7, "feature/steward")]);
    failedLabels(w);
    const unreadable = await tick(w);
    noStarted(unreadable);
    expect(
      unreadable.repos[0]?.launches.some((l) =>
        l.detail.includes("labels unavailable"),
      ),
    ).toBe(true);
    expect(
      stateDb(dispatchState(w))
        .query("SELECT COUNT(*) AS n FROM launches WHERE action = 'rearm'")
        .get(),
    ).toEqual({ n: 0 });
  }, 60000);

  test(`pending steward replays respect ${prefix ?? "jig:"}hold and refuse unreadable labels`, async () => {
    const w = fixture(false, prefix);
    const started = (await tick(w)).repos[0]?.launches.find(
      (l) => l.action === "rearm" && l.outcome === "launched",
    );
    expect(started?.record).toBeTruthy();
    if (!started?.record) return;
    const record = readRecord(started.record, dispatchState(w));
    expect(record).toBeTruthy();
    if (!record) return;
    record.attempts = [
      {
        at: new Date().toISOString(),
        outcome: "lost",
        detail: "response lost",
      },
    ];
    writeRecord(record, dispatchState(w));
    w.setPrs("open", [
      labeled(openPr(7, "feature/steward"), `${prefix ?? "jig:"}hold`),
    ]);
    const held = await tick(w);
    noStarted(held);
    expect(
      held.repos[0]?.launches.some((l) => l.detail.includes("hold label")),
    ).toBe(true);
    w.setPrs("open", [openPr(7, "feature/steward")]);
    failedLabels(w);
    const unreadable = await tick(w);
    noStarted(unreadable);
    expect(
      unreadable.repos[0]?.launches.some((l) =>
        l.detail.includes("labels unavailable"),
      ),
    ).toBe(true);
    rmSync(join(w.dir, "pr-labels-fail"));
    expect((await tick(w)).repos[0]?.launches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "retried", record: record.id }),
      ]),
    );
  }, 60000);
}

test("ordinary automatic rearm retains its existing labels-off behavior", async () => {
  const w = fixture(true);
  w.setPrs("open", [labeled(openPr(7, "feature/steward"), "work:hold")]);
  failedLabels(w);
  expect((await tick(w)).repos[0]?.launches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: "rearm", outcome: "launched" }),
    ]),
  );
}, 60000);
