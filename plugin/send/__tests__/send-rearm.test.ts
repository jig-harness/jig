import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { stoppedLedger } from "../../dispatch/__tests__/fixtures.ts";
import { writeRecord } from "../../dispatch/lib/launches.ts";
import { REARM_REQUEST } from "../../dispatch/lib/rearm-binding.ts";
import { claimBody, readClaim } from "../../shared/records/forge-claims.ts";
import { localWriter } from "../../shared/records/writer.ts";
import {
  comment,
  ledgerOn,
  pullRequest,
  REPO,
  runningLedger,
  type SendWorld,
  sendWorld,
} from "./send-fixtures.ts";

let current: SendWorld | null = null;
afterEach(() => {
  current?.close();
  current = null;
});
const ADDRESS = `drive@${REPO}#12`;
function world() {
  current = sendWorld();
  current.stoppedDriver(12);
  return current;
}

describe("jig send rearm", () => {
  it("withdraws a pending rearm and refuses if there is no request label", async () => {
    const w = world();
    const ledger = stoppedLedger(12, 12);
    const request = comment(
      702,
      claimBody(REARM_REQUEST, {
        key: "rearm",
        generation: ledger.generation,
        writer: localWriter("forge"),
        payload: { label: "jig:rearm", stopComment: 701 },
        text: "Requested a re-arm.",
      }),
    );
    pullRequest(
      w,
      12,
      ["jig:rearm", "jig:hold"],
      [ledgerOn(701, ledger), request],
    );
    const withdrawn = await w.send([ADDRESS, "withdraw-rearm"]);
    expectSpawnExit(withdrawn, 0);
    expect(withdrawn.stdout).toContain("removed from pull request 12");
    expect(w.writes().at(-1)).toEqual([
      "pr",
      "edit",
      "12",
      "--repo",
      REPO,
      "--remove-label",
      "jig:rearm",
    ]);
    const { body } = JSON.parse(
      readFileSync(join(w.dir, "gh-posted-comment.json"), "utf8"),
    );
    expect(readClaim(REARM_REQUEST, body)).toMatchObject({
      ok: true,
      value: {
        payload: { label: "jig:rearm", requestId: 702, stopComment: null },
      },
    });
    const writes = w.writes();
    pullRequest(w, 12, ["jig:hold"], [ledgerOn(701, stoppedLedger(12, 12))]);
    const absent = await w.send([ADDRESS, "withdraw-rearm"]);
    expectSpawnExit(absent, 1);
    expect(absent.stderr).toContain("no rearm request to withdraw");
    expect(w.writes()).toEqual(writes);
  });

  it("refuses a new request while an earlier delivered request still awaits acknowledgment even with no forge label", async () => {
    const w = world();
    pullRequest(w, 12, [], [ledgerOn(701, stoppedLedger(12, 12))]);
    writeRecord(
      {
        version: 1,
        id: "20261105T100000Z-abcdef12",
        token: "token",
        action: "rearm",
        repo: REPO,
        repoPath: w.repo,
        pr: 12,
        item: null,
        account: "a",
        vendor: "claude",
        configDir: w.root,
        wallBackoffMs: 1,
        replaces: null,
        facts: "old",
        createdAt: "2026-11-05T10:00:00Z",
        workspace: { id: "ws", path: w.tree },
        attempts: [
          { at: "2026-11-05T10:00:00Z", outcome: "sent", detail: "accepted" },
        ],
        agentId: null,
        model: null,
        effort: null,
        released: false,
        command: null,
        marker: null,
        rearmLabel: "jig:rearm",
      },
      w.state,
    );
    const pending = await w.send([ADDRESS, "rearm"]);
    expectSpawnExit(pending, 1);
    expect(pending.stderr).toContain("awaiting acknowledgment");
    expect(w.writes()).toEqual([]);
  });
  it("writes the request for a stopped ledger in its existing tree, with dry run leaving no record", async () => {
    const w = world();
    const ledger = stoppedLedger(12, 12);
    pullRequest(w, 12, [], [ledgerOn(701, ledger)]);
    const dry = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(dry, 0);
    expect(dry.stdout).toContain(w.tree);
    expect(w.writes()).toEqual([]);
    const real = await w.send([ADDRESS, "rearm"]);
    expectSpawnExit(real, 0);
    expect(w.writes()).toContainEqual([
      "pr",
      "edit",
      "12",
      "--repo",
      REPO,
      "--add-label",
      "jig:rearm",
    ]);
    const { body } = JSON.parse(
      readFileSync(join(w.dir, "gh-posted-comment.json"), "utf8"),
    );
    expect(readClaim(REARM_REQUEST, body)).toMatchObject({
      ok: true,
      value: {
        generation: ledger.generation,
        payload: { label: "jig:rearm", stopComment: 701 },
      },
    });
    expect(w.writes().map(([cmd]) => cmd)).toEqual(["api", "pr"]);
    expect(real.stdout).toContain("admitted account");
  });
  it("refuses a running ledger, a live local lock and a stop a person recorded", async () => {
    const w = world();
    pullRequest(w, 12, [], [ledgerOn(701, runningLedger(12))]);
    expectSpawnExit(await w.send([ADDRESS, "rearm"]), 1);
    pullRequest(w, 12, [], [ledgerOn(701, stoppedLedger(12, 12))]);
    w.liveDriver(12, 3);
    const live = await w.send([ADDRESS, "rearm"]);
    expectSpawnExit(live, 1);
    expect(live.stderr).toContain("still held");
    w.stoppedDriver(12);
    const ledger = stoppedLedger(12, 12);
    ledger.driver.personStop = {
      reason: "operator stopped it",
      at: new Date().toISOString(),
    };
    pullRequest(w, 12, [], [ledgerOn(701, ledger)]);
    const person = await w.send([ADDRESS, "rearm"]);
    expectSpawnExit(person, 1);
    expect(person.stderr).toContain("person");
    expect(w.writes()).toEqual([]);
  });
  it("refuses a stopped ledger with no tree here and a duplicate request", async () => {
    const w = sendWorld();
    current = w;
    pullRequest(w, 12, [], [ledgerOn(701, stoppedLedger(12, 12))]);
    expectSpawnExit(await w.send([ADDRESS, "rearm"]), 1);
    w.stoppedDriver(12);
    pullRequest(w, 12, ["jig:rearm"], [ledgerOn(701, stoppedLedger(12, 12))]);
    const duplicate = await w.send([ADDRESS, "rearm"]);
    expectSpawnExit(duplicate, 1);
    expect(duplicate.stderr).toContain("already carries");
    expect(w.writes()).toEqual([]);
  });
});
