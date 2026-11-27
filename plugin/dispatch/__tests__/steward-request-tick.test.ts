/**
 * A person's request for a steward pass (`jig send steward@… start`), as the
 * owner host's tick reads it: it starts a pass whatever the judgment backlog
 * holds, under the rules a triggered pass is held to, and it is taken once the
 * pass started or a rule refused it, with an outcome-log row that says which.
 */
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
} from "./fixtures.ts";
import { account, machineFile, dispatchState } from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";
import { stateDb } from "../lib/state.ts";
import type { TickReceipt } from "../receipts.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import { keepStewardRun, readStewardDigest } from "../lib/steward.ts";
import { keepStewardRequest } from "../lib/steward-requests.ts";

const REPO = "example-org/example-repo";

let current: World | null = null;
afterEach(() => {
  if (current) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

function fixture() {
  const w = world();
  current = w;
  w.setConfig(
    "issue_tracker:\n  adapter: github\ndispatch:\n  identity: factory-bot\n",
  );
  withOrigin(w);
  machineFile(
    w,
    [account(w, "a", "a@example.com")],
    { steward: { enabled: true } },
    ["steward"],
    { owner: true },
  );
  w.setPrs("open", []);
  return w;
}

async function tick(w: World) {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const stewardLaunches = (receipt: TickReceipt) =>
  receipt.repos[0]?.launches.filter((l) => l.action === "steward") ?? [];

function pendingRequests(w: World) {
  return stateDb(dispatchState(w))
    .query("SELECT repo, requested_by AS by FROM steward_requests")
    .all();
}

function requestRows(w: World) {
  return (
    stateDb(dispatchState(w))
      .query(
        "SELECT row FROM log WHERE stage = 'steward' AND key LIKE 'steward-request %'",
      )
      .all() as Array<{ row: string }>
  ).map(
    (r) =>
      JSON.parse(r.row) as {
        event: string;
        class: string | null;
        reason: string;
      },
  );
}

function lineNotes(w: World): string[] {
  const row = stateDb(dispatchState(w))
    .query("SELECT line FROM tick_line WHERE id = 1")
    .get() as { line: string };
  return (JSON.parse(row.line) as LineSnapshot).repos[0]?.notes ?? [];
}

function request(w: World) {
  const kept = keepStewardRequest(REPO, "maintainer", dispatchState(w));
  expect(kept.ok).toBe(true);
}

describe("a requested steward pass", () => {
  test("starts on the next tick with an empty judgment backlog, reads the same digest, and the log says it was requested", async () => {
    const w = fixture();
    const quiet = await tick(w);
    expect(quiet.repos[0]?.steward?.trigger).toBe("empty");
    request(w);
    const receipt = await tick(w);
    expect(stewardLaunches(receipt)).toMatchObject([{ outcome: "launched" }]);
    expect(receipt.repos[0]?.steward).toMatchObject({
      status:
        "started on maintainer's request, for 0 unjudged of 0 in the judgment backlog",
      trigger: "started",
      requestedBy: "maintainer",
    });
    expect(pendingRequests(w)).toEqual([]);
    const root = dispatchState(w);
    const run = stateDb(root).query("SELECT id FROM steward_runs").get() as {
      id: string;
    };
    const digest = readStewardDigest(run.id, root);
    expect(digest.ok && digest.value.backlog).toEqual([]);
    expect(digest.ok && digest.value.repo).toBe(REPO);
    expect(requestRows(w)).toEqual([
      expect.objectContaining({
        event: "steward-requested",
        class: null,
        reason: expect.stringContaining(
          `started steward pass ${run.id}, requested by maintainer`,
        ),
      }),
    ]);
  }, 60_000);

  test("is refused while the host's hourly budget is spent, naming the budget, and is taken", async () => {
    const w = fixture();
    const root = dispatchState(w);
    await tick(w);
    const now = Date.now();
    for (const n of [1, 2, 3])
      keepStewardRun(
        `20261127T00000${n}Z-0000000${n}`,
        {
          version: 1,
          repo: REPO,
          drives: [],
          needs: [],
          queue: [],
          passes: [],
          failures: [],
          load: null,
        },
        now - n * 60_000,
        root,
      );
    request(w);
    const receipt = await tick(w);
    expect(stewardLaunches(receipt)).toEqual([]);
    expect(receipt.repos[0]?.steward).toEqual({
      status:
        "maintainer's request refused: the host's hourly steward budget is spent",
      trigger: "budget",
      requestedBy: "maintainer",
    });
    expect(lineNotes(w)).toContain(
      "steward not started: maintainer's request refused: the host's hourly steward budget is spent",
    );
    expect(pendingRequests(w)).toEqual([]);
    expect(requestRows(w)).toEqual([
      expect.objectContaining({
        event: "steward-request-refused",
        class: "refused",
        reason: expect.stringContaining(
          "was refused: the host's hourly steward budget is spent",
        ),
      }),
    ]);
  }, 60_000);

  test("is refused while a steward pass holds the repository, naming the hold, and is taken", async () => {
    const w = fixture();
    // A drive stopped for a person puts a member in the backlog, so this tick starts a pass that keeps running.
    w.setPrs("open", [openPr(7, "feature/stopped-7")]);
    w.setComments(7, [ledgerComment(701, stoppedLedger(7, 2))]);
    expect(stewardLaunches(await tick(w))).toMatchObject([
      { outcome: "launched" },
    ]);
    request(w);
    const receipt = await tick(w);
    expect(stewardLaunches(receipt)).toEqual([]);
    expect(receipt.repos[0]?.steward).toEqual({
      status:
        "maintainer's request refused: a steward pass already holds this repository",
      trigger: "held",
      requestedBy: "maintainer",
    });
    expect(lineNotes(w)).toContain(
      "steward not started: maintainer's request refused: a steward pass already holds this repository",
    );
    expect(pendingRequests(w)).toEqual([]);
    expect(requestRows(w)).toEqual([
      expect.objectContaining({
        event: "steward-request-refused",
        class: "refused",
        reason: expect.stringContaining(
          "was refused: a steward pass already holds this repository",
        ),
      }),
    ]);
  }, 60_000);
});
