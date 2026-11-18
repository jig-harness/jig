import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { stoppedLedger } from "../../dispatch/__tests__/fixtures.ts";
import { writeRecord } from "../../dispatch/lib/launches.ts";
import { isNeed } from "../../dispatch/lib/line.ts";
import {
  stationContextOf,
  stationDecision,
} from "../../dispatch/lib/line-station.ts";
import { rearmLockNeeds } from "../../dispatch/lib/rearm-lock-needs.ts";
import { statePath } from "../../dispatch/lib/state.ts";
import {
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
    pullRequest(w, 12, [], [ledgerOn(701, stoppedLedger(12, 12))]);
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
    expect(real.stdout).toContain("admitted account");
  });
  it("rearms a stopped drive from its lock without starting CI hold diagnosis", async () => {
    const w = world();
    pullRequest(w, 12, [], [ledgerOn(701, stoppedLedger(12, 12))]);
    const diagnosed = join(w.root, "diagnosed");
    const listing = w.env.JIG_ASK_DRIVES_SCRIPT as string;
    const rows = {
      rows: [
        { kind: "pr", key: "12", state: "stale", diag: { worktree: w.tree } },
      ],
    };
    writeFileSync(
      listing,
      `if (!process.argv.includes("--lock-only")) {
        await Bun.write(${JSON.stringify(diagnosed)}, "diagnosis started");
        process.exit(1);
      }
      console.log(JSON.stringify(${JSON.stringify(rows)}));`,
    );
    expectSpawnExit(await w.send([ADDRESS, "rearm"]), 0);
    expect(existsSync(diagnosed)).toBe(false);
    expect(w.writes()).toContainEqual([
      "pr",
      "edit",
      "12",
      "--repo",
      REPO,
      "--add-label",
      "jig:rearm",
    ]);
  });
  it("refuses a failed lock read and records one investigation need for that stop", async () => {
    const w = world();
    const ledger = stoppedLedger(12, 12);
    pullRequest(w, 12, [], [ledgerOn(701, ledger)]);
    const listing = w.env.JIG_ASK_DRIVES_SCRIPT as string;
    writeFileSync(listing, "process.exit(1);");
    const dry = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(dry, 1);
    expect(existsSync(statePath(w.state))).toBe(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const real = await w.send([ADDRESS, "rearm"]);
      expectSpawnExit(real, 1);
      expect(real.stderr).toContain("the driver lock could not be read");
      expect(real.stderr).toContain(
        "listing failed: the drive's listing exited 1",
      );
      expect(real.stderr).toContain("recorded a need");
    }
    expect(w.writes()).toEqual([]);
    const drive = {
      number: 12,
      url: `https://github.com/${REPO}/pull/12`,
      title: "A change",
      head: "work",
      class: "re-armable" as const,
      why: "The drive stopped",
      evidence: {
        driver: "stopped",
        generation: ledger.generation,
        heartbeat: ledger.driver.heartbeat,
      },
    };
    const needs = rearmLockNeeds(REPO.toUpperCase(), [drive], w.state);
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({
      cause: "needs-person",
      target: "PR #12",
      reason: expect.stringContaining("exited 1"),
      evidence: { stewardAct: "Investigate" },
    });
    expect(
      needs
        .filter(isNeed)
        .map((need) =>
          stationDecision(need, stationContextOf(REPO, undefined)),
        ),
    ).toEqual([null]);
    expect(
      rearmLockNeeds(
        REPO,
        [
          {
            ...drive,
            evidence: { ...drive.evidence, generation: ledger.generation + 1 },
          },
        ],
        w.state,
      ),
    ).toEqual([]);
    writeFileSync(listing, "console.log(JSON.stringify({ rows: [] }));");
    expectSpawnExit(await w.send([ADDRESS, "rearm"]), 1); // The now-readable fixture has no worktree.
    expect(rearmLockNeeds(REPO, [drive], w.state)).toEqual([]);
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
