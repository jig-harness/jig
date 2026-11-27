/**
 * A person's request for a steward pass (`jig send steward@… start`), as the
 * owner host's tick reads it: it starts a pass whatever the judgment backlog
 * holds, under the rules a triggered pass is held to, and it is taken once the
 * pass started or a rule refused it, with an outcome-log row that says which.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  world,
  type World,
  openPr,
  stoppedLedger,
  ledgerComment,
} from "./fixtures.ts";
import {
  account,
  claimed,
  dispatchState,
  earlierRecord,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";
import { clearMain } from "../clear.ts";
import { readRecord } from "../lib/launches.ts";
import { stateDb } from "../lib/state.ts";
import type { TickReceipt } from "../receipts.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import { keepStewardRun, readStewardDigest } from "../lib/steward.ts";
import {
  keepStewardRequest,
  type StewardRequest,
} from "../lib/steward-requests.ts";

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

function request(w: World): StewardRequest {
  const kept = keepStewardRequest(REPO, "maintainer", dispatchState(w));
  expect(kept.ok).toBe(true);
  if (!kept.ok) throw new Error(kept.failure.reason);
  return kept.value;
}

function isClaimedOrEnded(w: World, id: string): boolean {
  const row = stateDb(dispatchState(w))
    .query("SELECT claim, exit FROM launches WHERE id = ?")
    .get(id) as { claim: string | null; exit: string | null } | null;
  return row !== null && (row.claim !== null || row.exit !== null);
}

describe("a requested steward pass", () => {
  test("starts on the next tick with an empty judgment backlog, reads the same digest, and settles once wrapper or execution evidence exists", async () => {
    const w = fixture();
    const quiet = await tick(w);
    expect(quiet.repos[0]?.steward?.trigger).toBe("empty");
    const req = request(w);
    const receipt = await tick(w);
    expect(stewardLaunches(receipt)).toMatchObject([{ outcome: "launched" }]);
    expect(receipt.repos[0]?.steward).toMatchObject({
      status:
        "started on maintainer's request, for 0 unjudged of 0 in the judgment backlog",
      trigger: "started",
      requestedBy: "maintainer",
    });
    const root = dispatchState(w);
    const run = stateDb(root).query("SELECT id FROM steward_runs").get() as {
      id: string;
    };
    expect(readRecord(run.id, root)?.stewardRequest).toBe(req.id);
    // Runtime acknowledgment alone leaves the request kept until wrapper or execution evidence is observed.
    expect(pendingRequests(w)).toEqual([
      { repo: REPO.toLowerCase(), by: "maintainer" },
    ]);
    expect(requestRows(w)).toEqual([]);
    const digest = readStewardDigest(run.id, root);
    expect(digest.ok && digest.value.backlog).toEqual([]);
    expect(digest.ok && digest.value.repo).toBe(REPO);
    await waitFor("steward wrapper claim", () => isClaimedOrEnded(w, run.id));
    const settled = await tick(w);
    expect(stewardLaunches(settled)).toEqual([]);
    expect(settled.repos[0]?.steward?.status).toContain(
      `answered by steward pass ${run.id}`,
    );
    expect(pendingRequests(w)).toEqual([]);
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

  test("keeps the request through an acknowledged-but-unclaimed launch, and fulfills it once that stuck launch is cleared", async () => {
    const w = fixture();
    const root = dispatchState(w);
    writeFileSync(join(w.dir, "orca-terminal-noop"), "");
    const req = request(w);
    const first = await tick(w);
    const firstId = stewardLaunches(first)[0]?.record;
    expect(stewardLaunches(first)).toMatchObject([{ outcome: "launched" }]);
    expect(firstId).toBeTruthy();
    if (!firstId) throw new Error("expected first steward launch id");
    expect(readRecord(firstId, root)?.stewardRequest).toBe(req.id);
    expect(pendingRequests(w)).toEqual([
      { repo: REPO.toLowerCase(), by: "maintainer" },
    ]);
    expect(requestRows(w)).toEqual([]);

    // Next tick still sees an acknowledged-but-unclaimed launch: keep the request, start nothing, log nothing.
    const second = await tick(w);
    expect(stewardLaunches(second)).toEqual([]);
    expect(second.repos[0]?.steward?.status).toContain(
      `steward launch ${firstId} is acknowledged and awaiting wrapper claim`,
    );
    expect(pendingRequests(w)).toEqual([
      { repo: REPO.toLowerCase(), by: "maintainer" },
    ]);
    expect(requestRows(w)).toEqual([]);

    // Operator clears the stuck unclaimed launch; the request stands and starts a fresh pass.
    expect(await clearMain(firstId, root)).toBe(0);
    unlinkSync(join(w.dir, "orca-terminal-noop"));
    const third = await tick(w);
    const secondId = stewardLaunches(third)[0]?.record;
    expect(stewardLaunches(third)).toMatchObject([{ outcome: "launched" }]);
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    if (!secondId) throw new Error("expected second steward launch id");
    expect(readRecord(secondId, root)?.stewardRequest).toBe(req.id);

    await waitFor("fresh steward wrapper claim", () =>
      isClaimedOrEnded(w, secondId),
    );
    const settled = await tick(w);
    expect(stewardLaunches(settled)).toEqual([]);
    expect(pendingRequests(w)).toEqual([]);
    expect(requestRows(w)).toEqual([
      expect.objectContaining({
        event: "steward-requested",
        class: null,
        reason: expect.stringContaining(
          `started steward pass ${secondId}, requested by maintainer`,
        ),
      }),
    ]);
  }, 60_000);

  test("an unrelated steward launch created after the request never satisfies it as requested", async () => {
    const w = fixture();
    const root = dispatchState(w);
    // First: an unrelated pending-with-sent launch created after the request refuses it as held, never logs steward-requested.
    const heldReq = request(w);
    const later = new Date(Date.parse(heldReq.at) + 5_000).toISOString();
    earlierRecord(w, {
      id: "20261127T230001Z-aaaaaaaa",
      action: "steward",
      account: "a",
      pr: null,
      item: null,
      createdAt: later,
      attempts: [{ at: later, outcome: "sent", detail: "started" }],
    });
    const refused = await tick(w);
    expect(stewardLaunches(refused)).toEqual([]);
    expect(refused.repos[0]?.steward).toEqual({
      status:
        "maintainer's request refused: a steward pass already holds this repository",
      trigger: "held",
      requestedBy: "maintainer",
    });
    expect(pendingRequests(w)).toEqual([]);
    expect(requestRows(w)).toEqual([
      expect.objectContaining({
        event: "steward-request-refused",
        class: "refused",
      }),
    ]);

    // End the unrelated launch, then send a new request whose timestamp precedes a second unrelated ended launch:
    // the tick must start a fresh pass carrying the new request's identity rather than treating the unrelated launch as its answer.
    claimed(
      w,
      "20261127T230001Z-aaaaaaaa",
      {
        hostId: "h",
        host: "h",
        bootId: "b",
        pid: 1,
        start: "s",
        claimedAt: later,
      },
      0,
    );
    const freshReq = request(w);
    const evenLater = new Date(Date.parse(freshReq.at) + 5_000).toISOString();
    earlierRecord(w, {
      id: "20261127T230002Z-bbbbbbbb",
      action: "steward",
      account: "a",
      pr: null,
      item: null,
      createdAt: evenLater,
      attempts: [{ at: evenLater, outcome: "sent", detail: "started" }],
    });
    claimed(
      w,
      "20261127T230002Z-bbbbbbbb",
      {
        hostId: "h",
        host: "h",
        bootId: "b",
        pid: 2,
        start: "s",
        claimedAt: evenLater,
      },
      0,
    );
    const launched = await tick(w);
    const launchedId = stewardLaunches(launched)[0]?.record;
    expect(stewardLaunches(launched)).toMatchObject([{ outcome: "launched" }]);
    expect(launchedId).toBeTruthy();
    if (!launchedId) throw new Error("expected launched steward id");
    expect(readRecord(launchedId, root)?.stewardRequest).toBe(freshReq.id);
    await waitFor("fresh launch claim", () => isClaimedOrEnded(w, launchedId));
    await tick(w);
    expect(pendingRequests(w)).toEqual([]);
    expect(requestRows(w)).toContainEqual(
      expect.objectContaining({
        event: "steward-requested",
        reason: expect.stringContaining(
          `started steward pass ${launchedId}, requested by maintainer`,
        ),
      }),
    );
  }, 60_000);
});
