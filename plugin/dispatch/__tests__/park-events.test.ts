/**
 * How each park left, in the outcome log: a park answered between two ticks
 * is counted from its resolution receipt, a park the line held that left
 * with no receipt is counted as removed, a receipt is never counted twice,
 * and only the owner host's tick writes rows. The unit cases compare lines
 * and ledgers directly; the last runs real ticks over the fake forge.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { ResolutionReceipt } from "../../skills/drive-pr/scripts/lib/state/resolution-receipt.ts";
import type { LinePark, LineSnapshot } from "../lib/dashboard-contract.ts";
import type { EventRow } from "../lib/log.ts";
import {
  type ParkMemory,
  type ParkRepo,
  parkOutcomes,
  withUnreadRepos,
} from "../lib/park-events.ts";
import type { DrivenPr } from "../lib/types.ts";
import {
  ledgerComment,
  mergedPr,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";

const NOW = "2026-11-10T12:00:00.000Z";
const PARKED_AT = "2026-11-10T09:00:00.000Z";
const DIGEST = "3fa9c2d1e0b4";

function receipt(
  key: string,
  over: Partial<ResolutionReceipt> = {},
): ResolutionReceipt {
  return {
    key,
    kind: "finding",
    reason: "Keep the flag?",
    class: "scope",
    digest: DIGEST,
    parkedAt: PARKED_AT,
    outcome: "answered",
    answers: [
      {
        author: "ana",
        at: "2026-11-10T10:30:00.000Z",
        url: "https://example.test/c/1",
        choice: { option: "Keep", recommended: true, form: "approve" },
      },
    ],
    answeredAt: "2026-11-10T10:30:00.000Z",
    resolvedAt: "2026-11-10T11:00:00.000Z",
    ...over,
  };
}

const parkOf = (key: string, parkedAt = PARKED_AT) => ({
  key,
  kind: "finding" as const,
  digest: DIGEST,
  parkedAt,
  class: "scope",
});

function drive(
  pr: number,
  parked: ReturnType<typeof parkOf>[],
  resolved: ResolutionReceipt[] = [],
): DrivenPr {
  return {
    number: pr,
    url: `https://example.test/pull/${pr}`,
    title: "t",
    head: "h",
    class: "parked",
    why: "parked",
    evidence: {},
    parks: { parked, resolved },
  };
}

function linePark(key: string, pr = 7, parkedAt = PARKED_AT): LinePark {
  return {
    repo: SLUG,
    pr,
    key,
    kind: "finding",
    digest: DIGEST,
    parkedAt,
    class: "scope",
  };
}

const repo = (drives: DrivenPr[], over: Partial<ParkRepo> = {}): ParkRepo => ({
  slug: SLUG,
  owner: true,
  open: drives.map((d) => d.number),
  drives,
  ...over,
});

const events = (rows: EventRow[]) =>
  rows.map((r) => [r.event, r.park?.key]).sort();

describe("park outcomes", () => {
  it("counts a park raised and answered between two ticks from its receipt", () => {
    const got = parkOutcomes([repo([drive(7, [], [receipt("A")])])], {}, NOW);
    expect(events(got.rows)).toEqual([["park-answered", "A"]]);
    const row = got.rows[0];
    expect(row?.park).toEqual({
      key: "A",
      class: "scope",
      digest: DIGEST,
      parkedAt: PARKED_AT,
      outcome: "answered",
      form: "approve",
      recommended: true,
      note: false,
    });
    expect(row?.durationMs).toBe(90 * 60_000);
    expect(row?.at).toBe("2026-11-10T11:00:00.000Z");
    expect(got.ingested).toHaveLength(1);
  });

  it("counts a held park that left with no receipt as removed, not answered", () => {
    const memory: ParkMemory = { parks: [linePark("A")] };
    const got = parkOutcomes([repo([drive(7, [])])], memory, NOW);
    expect(events(got.rows)).toEqual([["park-removed", "A"]]);
    expect(got.rows[0]?.park?.outcome).toBe("removed");
    expect(got.rows[0]?.durationMs).toBeUndefined();
    expect(got.parks).toEqual([]);
  });

  it("counts a park framed again under its key as a new occurrence, and the old one as removed", () => {
    const later = "2026-11-10T11:30:00.000Z";
    const memory: ParkMemory = { parks: [linePark("A")] };
    const got = parkOutcomes(
      [repo([drive(7, [parkOf("A", later)])])],
      memory,
      NOW,
    );
    expect(events(got.rows)).toEqual([["park-removed", "A"]]);
    expect(got.parks.map((p) => p.parkedAt)).toEqual([later]);
  });

  it("never counts one receipt twice, and forgets it once the ledger no longer lists it", () => {
    const first = parkOutcomes(
      [repo([drive(7, [], [receipt("A")])])],
      { parks: [linePark("A")] },
      NOW,
    );
    expect(events(first.rows)).toEqual([["park-answered", "A"]]);
    const again = parkOutcomes(
      [repo([drive(7, [], [receipt("A")])])],
      first,
      NOW,
    );
    expect(again.rows).toEqual([]);
    expect(again.ingested).toEqual(first.ingested);
    const gone = parkOutcomes([repo([drive(7, [])])], again, NOW);
    expect(gone.rows).toEqual([]);
    expect(gone.ingested).toEqual([]);
  });

  it("reads the form of free answers, a note and a provisional decision", () => {
    const free = receipt("F", {
      answers: [{ author: "ana", at: PARKED_AT, url: "u" }],
    });
    const noted = receipt("N", {
      answers: [
        {
          author: "ana",
          at: PARKED_AT,
          url: "u",
          choice: {
            option: "Remove",
            recommended: false,
            form: "choose",
            note: "after the migration",
          },
        },
      ],
    });
    const { answeredAt: _a, ...provisional } = receipt("P", {
      outcome: "provisional",
      answers: [],
    });
    const got = parkOutcomes(
      [repo([drive(7, [], [free, noted, provisional])])],
      {},
      NOW,
    );
    const facts = Object.fromEntries(
      got.rows.map((r) => [
        r.park?.key,
        [r.event, r.park?.form, r.park?.recommended, r.park?.note],
      ]),
    );
    expect(facts).toEqual({
      F: ["park-answered", "free", null, false],
      N: ["park-answered", "choose", false, true],
      P: ["park-provisional", null, null, false],
    });
  });

  it("keeps a held park until its open or final ledger reads", () => {
    const memory: ParkMemory = {
      parks: [linePark("kept", 8), linePark("closed", 9)],
    };
    const got = parkOutcomes([repo([], { open: [8] })], memory, NOW);
    expect(got.rows).toEqual([]);
    expect(got.parks.map((p) => p.key)).toEqual(["kept", "closed"]);
    const unread = parkOutcomes([repo([], { open: null })], memory, NOW);
    expect(unread.rows).toEqual([]);
    expect(unread.parks.map((p) => p.key)).toEqual(["kept", "closed"]);
  });

  it("writes no rows on a host that does not own the repository", () => {
    const got = parkOutcomes(
      [repo([drive(7, [], [receipt("A")])], { owner: false })],
      { parks: [linePark("B")] },
      NOW,
    );
    expect(got.rows).toEqual([]);
    expect(got.ingested).toEqual([]);
  });

  it("counts final receipts without resurrecting parks or inferring removal", () => {
    const final = {
      number: 7,
      parks: {
        parked: [parkOf("C")],
        resolved: [
          receipt("A"),
          receipt("B", { outcome: "provisional", answers: [] }),
        ],
        receiptsCut: true,
      },
    };
    const got = parkOutcomes(
      [repo([], { open: [], finalParks: [final] })],
      { parks: [linePark("A"), linePark("C")] },
      NOW,
    );
    expect(events(got.rows)).toEqual([
      ["park-answered", "A"],
      ["park-provisional", "B"],
    ]);
    expect(got.parks).toEqual([]);
    const repeated = parkOutcomes(
      [repo([], { open: [], finalParks: [final] })],
      got,
      NOW,
    );
    expect(repeated.rows).toEqual([]);
  });
});

describe("the outcome log over real ticks", () => {
  let current: World | null = null;
  afterEach(() => {
    current?.close();
    current = null;
  });

  function parkRows(w: World): EventRow[] {
    const db = new Database(join(dispatchState(w), "state.sqlite"));
    try {
      return (
        db
          .query("SELECT row FROM log WHERE kind = 'event' ORDER BY seq")
          .all() as Array<{ row: string }>
      )
        .map((r) => JSON.parse(r.row) as EventRow)
        .filter((r) => r.park !== undefined);
    } finally {
      db.close();
    }
  }

  function storedLine(w: World): LineSnapshot {
    const db = new Database(join(dispatchState(w), "state.sqlite"));
    try {
      const row = db.query("SELECT line FROM tick_line WHERE id = 1").get() as {
        line: string;
      };
      return JSON.parse(row.line) as LineSnapshot;
    } finally {
      db.close();
    }
  }

  async function tick(w: World, exit = 0): Promise<void> {
    expectSpawnExit(await w.dispatch(["--json"]), exit);
  }

  it.each(["merged", "closed"])(
    "reads final receipts once after a pull request is %s",
    async (state) => {
      const w = world();
      current = w;
      w.setConfig(
        `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
      );
      machineFile(w, [account(w, "a", "a@example.com")], {}, ["notify"]);
      w.setPrs("open", [openPr(7, "feature/7")]);
      w.setComments(7, [
        ledgerComment(
          701,
          stoppedLedger(7, 16, {
            parked: ["A", "C"].map((key) => ({
              key,
              kind: "finding",
              reason: "Keep?",
              round: 1,
              at: PARKED_AT,
              class: "scope",
            })),
          }),
        ),
      ]);
      await tick(w);
      expect(storedLine(w).parks).toHaveLength(2);
      w.setPrs("open", []);
      if (state === "merged")
        w.setPrs("merged", [mergedPr(7, "feature/7", NOW)]);
      const damaged = ledgerComment(701, stoppedLedger(7, 0));
      w.setComments(7, [
        { ...damaged, body: "<!-- drive-pr-ledger -->\nunreadable" },
      ]);
      await tick(w, 1);
      expect(parkRows(w)).toEqual([]);
      expect(storedLine(w).parks).toHaveLength(2);
      w.setComments(7, [
        ledgerComment(
          701,
          stoppedLedger(7, 0, {
            parked: [],
            resolvedParks: [
              receipt("A"),
              receipt("B", { outcome: "provisional", answers: [] }),
            ].map(({ digest: _d, ...r }) => r),
          }),
        ),
      ]);
      await tick(w);
      expect(events(parkRows(w))).toEqual([
        ["park-answered", "A"],
        ["park-provisional", "B"],
      ]);
      expect(storedLine(w).parks).toEqual([]);
      // Once retired, a later ledger edit is not read again for park accounting.
      w.setComments(7, [
        ledgerComment(
          701,
          stoppedLedger(7, 0, { resolvedParks: [receipt("C")] }),
        ),
      ]);
      await tick(w);
      expect(parkRows(w)).toHaveLength(2);
    },
    120_000,
  );

  it("counts answered and removed parks once each across ticks", async () => {
    const w = world();
    current = w;
    w.setConfig(
      `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
    );
    w.setPrs("open", [openPr(7, "feature/7")]);
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["notify"]);
    const parked = (key: string) => ({
      key,
      kind: "finding" as const,
      reason: "Keep the flag?",
      round: 1,
      at: PARKED_AT,
      class: "scope",
    });
    w.setComments(7, [
      ledgerComment(
        701,
        stoppedLedger(7, 16, { parked: [parked("A"), parked("C")] }),
      ),
    ]);
    await tick(w);
    expect(storedLine(w).parks?.map((p) => p.key)).toEqual(["A", "C"]);
    expect(parkRows(w)).toEqual([]);

    // A answered, B raised and answered between the ticks, C withdrawn.
    const answered = stoppedLedger(7, 16, {
      parked: [],
      resolvedParks: [receipt("A"), receipt("B")].map(
        ({ digest: _d, ...r }) => r,
      ),
    });
    w.setComments(7, [ledgerComment(701, answered)]);
    await tick(w);
    expect(events(parkRows(w))).toEqual([
      ["park-answered", "A"],
      ["park-answered", "B"],
      ["park-removed", "C"],
    ]);

    await tick(w);
    expect(parkRows(w)).toHaveLength(3);
    expect(storedLine(w).ingested).toHaveLength(2);
  }, 120_000);
});

describe("parks of repositories the tick's part does not carry", () => {
  const none = { parks: [], ingested: [], rows: [] };
  const other = { ...linePark("B"), repo: "o/other" };
  const memory: ParkMemory = {
    parks: [linePark("A"), other],
    ingested: [`${SLUG}#7 old`, "o/other#9 old"],
  };

  it("keeps a listed repository the tick did not read, and drops one no longer listed", () => {
    const got = withUnreadRepos(
      none,
      new Set([SLUG]),
      new Set([SLUG, "o/other"]),
      memory,
    );
    expect(got.parks.map((p) => p.key)).toEqual(["B"]);
    expect(got.ingested).toEqual(["o/other#9 old"]);
    const dropped = withUnreadRepos(
      none,
      new Set([SLUG]),
      new Set([SLUG]),
      memory,
    );
    expect(dropped.parks).toEqual([]);
    expect(dropped.ingested).toEqual([]);
  });

  it("keeps the parks of a repository whose newer part the tick left in place", () => {
    const got = withUnreadRepos(none, new Set(), new Set([SLUG]), memory);
    expect(got.parks.map((p) => p.key)).toEqual(["A"]);
  });
});
