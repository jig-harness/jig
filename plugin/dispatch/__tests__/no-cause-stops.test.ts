import { claimBody } from "../../shared/records/forge-claims.ts";
import {
  launchClaim,
  endedClaim,
  LAUNCH_CLAIM,
} from "../../shared/records/launch-claims.ts";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
/** Accidental stop recovery is durable across ticks and bounded across accounts. */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { statePath } from "../lib/state.ts";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  exitWritten,
  dispatchState,
  earlierRecord,
  claimed,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});
function fixture(modern: boolean): World {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  withOrigin(w);
  const head = "feature/7-accident";
  w.setPrs("open", [openPr(7, head)]);
  const ledger: Ledger = stoppedLedger(7, undefined);
  if (modern) ledger.driver.recoveryVersion = 1;
  w.setComments(7, [ledgerComment(701, ledger)]);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: head, linkedPR: 7, path: ws }]);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
  return w;
}
async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}
async function rearm(w: World) {
  const r = await tick(w);
  const launch = r.repos[0]?.launches?.[0];
  expect(launch).toMatchObject({ action: "rearm", outcome: "launched" });
  await waitFor("the recovery's exit", () =>
    exitWritten(w, launch?.record ?? ""),
  );
}
describe("no recorded cause", () => {
  it("re-arms three times, then notifies once with the handoff", async () => {
    const w = fixture(true);
    w.setConfig(
      `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  renotify_after: 1h\n`,
    );
    for (let i = 0; i < 3; i++) await rearm(w);
    const fourth = await tick(w);
    expect(fourth.repos[0]?.launches).toEqual([]);
    expect(fourth.repos[0]?.notifications).toMatchObject([
      { cause: "stopped-unknown", outcome: "sent" },
    ]);
    expect(fourth.repos[0]?.actions[0]?.notice?.text).toContain(
      "repeated no-cause stops",
    );
    expect(fourth.repos[0]?.actions[0]?.notice?.text).toContain(
      ".context/pr-drive-7.md",
    );
    const notices = fourth.repos[0]?.notifications?.[0]?.workspace;
    const psPath = join(w.dir, "orca-ps.json");
    const ps = JSON.parse(readFileSync(psPath, "utf8")) as {
      worktrees: Array<{ path: string; unread: boolean }>;
    };
    for (const row of ps.worktrees)
      if (row.path === notices) row.unread = false;
    writeFileSync(psPath, JSON.stringify(ps));
    const db = new Database(statePath(dispatchState(w)));
    try {
      const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
      db.query("UPDATE notices SET at = ?, sent_at = ?").run(at, at);
    } finally {
      db.close();
    }
    const fifth = await tick(w);
    expect(fifth.repos[0]?.launches).toEqual([]);
    expect(fifth.repos[0]?.notifications).toMatchObject([
      { outcome: "suppressed" },
    ]);
  }, 120_000);
  it.each([null, 11])(
    "keeps a third foreign recovery held until it ends (%s), then notifies",
    async (exit) => {
      const w = fixture(true);
      const ledger = stoppedLedger(7, undefined);
      ledger.driver.recoveryVersion = 1;
      const at = new Date(Date.now() - 1000).toISOString();
      const writer = { host: "sha256:cccccccccccccccc" };
      const claims = [1, 2, 3].map((n) =>
        launchClaim(
          {
            stage: "drive",
            pr: 7,
            run: "tick",
            action: "rearm",
            record: `20261105T010000Z-ccccccc${n}`,
            host: writer.host,
            owner: true,
            facts: noCauseFacts({
              ...accidental,
              evidence: {
                ...accidental.evidence,
                heartbeat: ledger.driver.heartbeat,
                generation: ledger.generation,
              },
            }),
            writer,
          },
          n,
          at,
        ),
      );
      const comments = (endedThird: boolean) => [
        ledgerComment(701, ledger),
        ...claims.map((posted, i) => {
          const body =
            i < 2 || endedThird
              ? endedClaim(
                  "drive",
                  {
                    key: posted.key,
                    generation: i + 1,
                    at,
                    writer,
                    payload: posted.payload,
                    legacy: false,
                  },
                  7,
                  { state: "ended", at, exit, outcome: null },
                  writer,
                )
              : posted;
          return forgeComment(
            702 + i,
            claimBody(LAUNCH_CLAIM, body),
            "drive-bot",
          );
        }),
      ];
      w.setComments(7, comments(false));
      const active = await tick(w);
      expect(active.repos[0]?.actions).toEqual([]);
      expect(active.repos[0]?.running).toMatchObject([
        { target: "PR #7", reason: expect.stringContaining("held by host") },
      ]);
      w.setComments(7, comments(true));
      const ended = await tick(w);
      expect(ended.repos[0]?.actions).toMatchObject([
        { stage: "notify", cause: "stopped-unknown" },
      ]);
    },
    120_000,
  );
  it("notifies after the third local recovery refused on unchanged ledger facts", async () => {
    const w = fixture(true);
    const ledger = stoppedLedger(7, undefined);
    const facts = noCauseFacts({
      ...accidental,
      evidence: {
        ...accidental.evidence,
        heartbeat: ledger.driver.heartbeat,
        generation: ledger.generation,
      },
    });
    for (let i = 1; i <= 3; i++) {
      const id = `20261107T00000${i}Z-aaaaaaa${i}`;
      earlierRecord(w, {
        id,
        account: "a",
        facts,
        createdAt: new Date(Date.now() - (4 - i) * 1000).toISOString(),
      });
      claimed(
        w,
        id,
        {
          pid: process.pid,
          host: "test",
          hostId: "",
          bootId: "",
          start: "",
          claimedAt: new Date().toISOString(),
        },
        11,
      );
    }
    expect((await tick(w)).repos[0]?.actions).toMatchObject([
      { stage: "notify", cause: "stopped-unknown" },
    ]);
  }, 120_000);
  it("gives the same legacy ledger only one attempt", async () => {
    const w = fixture(false);
    await rearm(w);
    const again = await tick(w);
    expect(again.repos[0]?.launches).toEqual([]);
    expect(again.repos[0]?.actions[0]?.reason).toContain(
      "legacy no-exit ledger already received its one recovery attempt",
    );
  }, 120_000);
});

import {
  settleNoCauseStops,
  noCauseFacts,
  NO_CAUSE_WINDOW_MS,
} from "../lib/no-cause-stops.ts";
import type { DrivenPr } from "../lib/types.ts";
import type { SharedClaim } from "../../shared/records/shared.ts";
const NOW = Date.parse("2026-11-06T12:00:00Z");
const accidental: DrivenPr = {
  number: 7,
  title: "recover",
  url: "https://example.com/pull/7",
  head: "feature/7",
  class: "re-armable",
  why: "no recorded cause",
  evidence: {
    noCause: true,
    legacyNoCause: false,
    generation: 3,
    heartbeat: "2026-11-06T11:00:00Z",
    exit: null,
    round: 1,
  },
};
function claim(id: number, at: string): SharedClaim {
  return {
    id,
    stage: "drive",
    login: "drive-bot",
    createdAt: at,
    trusted: true,
    says: {
      ok: true,
      value: {
        pr: 7,
        attempt: id,
        at,
        run: "tick",
        action: "rearm",
        record: `launch-${id}`,
        host: `host-${id}`,
        owner: true,
        facts: noCauseFacts(accidental),
        change: null,
        conflictStop: false,
        end: { state: "ended", at, exit: null, outcome: null },
        legacy: false,
      },
    },
  };
}
function budget(pr: DrivenPr, rows: SharedClaim[], nowMs = NOW) {
  return settleNoCauseStops(
    [pr],
    [],
    new Map([[7, { ok: true, value: rows }]]),
    nowMs,
  )[0];
}
describe("shared no-cause recovery budget", () => {
  it("bounds attempts across hosts and expires them by time, without a round reset", () => {
    const rows = [1, 2, 3].map((id) =>
      claim(id, new Date(NOW - id * 1000).toISOString()),
    );
    expect(budget(accidental, rows)?.class).toBe("stopped-unknown");
    expect(
      budget(
        { ...accidental, evidence: { ...accidental.evidence, round: 5 } },
        rows,
      )?.class,
    ).toBe("stopped-unknown");
    expect(budget(accidental, rows, NOW + NO_CAUSE_WINDOW_MS)?.class).toBe(
      "re-armable",
    );
  });
  it("does not grant a legacy ledger another attempt after its window expires", () => {
    const legacy = {
      ...accidental,
      evidence: { ...accidental.evidence, legacyNoCause: true },
    };
    const earlier = claim(1, "2026-11-01T00:00:00Z");
    if (earlier.says.ok) earlier.says.value.facts = noCauseFacts(legacy);
    expect(budget(legacy, [earlier])?.class).toBe("stopped-unknown");
  });
  it("reports failed and trusted malformed launch-claim reads as unplaced", () => {
    const failed = settleNoCauseStops(
      [accidental],
      [],
      new Map([
        [
          7,
          {
            ok: false,
            failure: { code: "unreadable", reason: "forge unavailable" },
          },
        ],
      ]),
      NOW,
    )[0];
    expect(failed).toMatchObject({
      class: "unplaced",
      why: expect.stringContaining("forge unavailable"),
    });
    const bad = {
      ...claim(1, new Date(NOW).toISOString()),
      says: {
        ok: false as const,
        failure: { code: "unreadable" as const, reason: "damaged claim" },
      },
    };
    expect(budget(accidental, [bad])).toMatchObject({
      class: "unplaced",
      why: expect.stringContaining("damaged claim"),
    });
  });
  it("leaves unreadable or future attempt times for a person", () => {
    expect(budget(accidental, [claim(1, "bad-time")])?.class).toBe(
      "stopped-unknown",
    );
    expect(
      budget(accidental, [claim(1, new Date(NOW + 1000).toISOString())])?.class,
    ).toBe("stopped-unknown");
  });
});
