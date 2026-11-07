import { Defect } from "../../shared/errors.ts";
/** A stale plan cannot spend a recovery allowance another host consumed before reservation. */
import { describe, expect, it } from "bun:test";
import { ok } from "../../shared/outcome.ts";
import type {
  SharedClaim,
  SharedRecords,
} from "../../shared/records/shared.ts";
import { launchClaimer } from "../lib/shared-launches.ts";
import { noCauseFacts, settleNoCauseStops } from "../lib/no-cause-stops.ts";
import type { LaunchRecord, ReadRecord } from "../lib/launches.ts";
import type { DrivenPr } from "../lib/types.ts";

function pr(legacy: boolean): DrivenPr {
  return {
    number: 7,
    title: "recover",
    url: "https://example.com/pull/7",
    head: "feature/7",
    class: "re-armable",
    why: "no cause",
    evidence: {
      noCause: true,
      legacyNoCause: legacy,
      generation: 3,
      exit: null,
      heartbeat: "2026-11-01T00:00:00Z",
    },
  };
}
function record(facts: string): LaunchRecord {
  return {
    version: 1,
    id: "20261107T000000Z-aaaaaaaa",
    token: "token",
    action: "rearm",
    repo: "example-org/example-repo",
    repoPath: "/repo",
    pr: 7,
    item: null,
    account: "a",
    vendor: "claude",
    configDir: "/config",
    wallBackoffMs: 3600000,
    replaces: null,
    facts,
    createdAt: new Date().toISOString(),
    workspace: null,
    attempts: [],
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
  };
}
function claim(
  id: number,
  facts: string,
  ownRecord?: string,
  ended = true,
): SharedClaim {
  const at = new Date(Date.now() - 1000).toISOString();
  return {
    id,
    stage: "drive",
    login: "drive-bot",
    createdAt: at,
    trusted: true,
    says: ok({
      pr: 7,
      attempt: id,
      at,
      run: "tick",
      action: "rearm",
      record: ownRecord ?? `record-${id}`,
      host: `host-${id}`,
      owner: true,
      facts,
      change: null,
      conflictStop: false,
      end: ended ? { state: "ended", at, exit: null, outcome: null } : null,
      legacy: false,
    }),
  };
}

async function reserve(
  candidate: LaunchRecord,
  own: number,
  history: SharedClaim[],
) {
  const released: number[] = [];
  // This boundary only calls claim, list and release; unexpected calls fail the test.
  const unexpected = async (): Promise<never> => {
    throw new Defect(
      "unexpected shared-record operation at recovery reservation",
    );
  };
  const records = {
    listRepository: unexpected,
    check: unexpected,
    end: unexpected,
    budget: unexpected,
    medium: "forge",
    claim: async () => ok({ kind: "holds" as const, id: own, attempt: own }),
    list: async () => ok(history),
    release: async (_target: unknown, id: number) => {
      released.push(id);
      return ok(undefined);
    },
  } satisfies SharedRecords;
  const claimer = launchClaimer({
    records,
    slug: candidate.repo,
    host: "candidate-host",
    owner: true,
    login: "drive-bot",
  });
  return { result: await claimer.claim(candidate), released };
}

describe("recovery reservation", () => {
  it("counts only the winning reservation of each earlier attempt", async () => {
    const facts = noCauseFacts(pr(false));
    const candidate = record(facts);
    const earlier = [1, 2, 3].map((id) => claim(id, facts, undefined, false));
    for (const c of earlier) if (c.says.ok) c.says.value.attempt = 1;
    const local: ReadRecord[] = earlier.map((c) => ({
      record: {
        ...record(facts),
        id: c.says.ok ? String(c.says.value.record) : "",
      },
      state: { kind: "pending" },
      result: null,
    }));
    expect(
      settleNoCauseStops(
        [pr(false)],
        local,
        new Map([[7, ok(earlier)]]),
        Date.now(),
      )[0]?.class,
    ).toBe("re-armable");
    const reserved = claim(4, facts, candidate.id, false);
    if (reserved.says.ok) reserved.says.value.attempt = 2;
    expect(
      settleNoCauseStops(
        [pr(false)],
        [],
        new Map([[7, ok(earlier)]]),
        Date.now(),
      )[0]?.class,
    ).toBe("re-armable");
    const { result, released } = await reserve(candidate, 4, [
      ...earlier,
      reserved,
    ]);
    expect(result).toEqual({ claim: 4 });
    expect(released).toEqual([]);
  });

  for (const legacy of [false, true]) {
    it.each(["ended", "died"] as const)(
      `counts shared %s losers without local records for the ${legacy ? "legacy" : "modern"} budget`,
      async (state) => {
        const drive = pr(legacy);
        const facts = noCauseFacts(drive);
        const history = [
          claim(1, "ordinary stop"),
          ...[2, 3, 4].map((id) => claim(id, facts)),
        ];
        for (const c of history) if (c.says.ok) c.says.value.attempt = 1;
        if (state === "died")
          for (const c of history.slice(1))
            if (c.says.ok)
              c.says.value.end = {
                state,
                at: c.says.value.at,
                reason: "the claimed wrapper disappeared without an exit",
              };
        expect(
          settleNoCauseStops(
            [drive],
            [],
            new Map([[7, ok(history)]]),
            Date.now(),
          )[0]?.class,
        ).toBe("stopped-unknown");
        const candidate = record(facts);
        const reserved = claim(5, facts, candidate.id, false);
        if (reserved.says.ok) reserved.says.value.attempt = 2;
        const { result, released } = await reserve(candidate, 5, [
          ...history,
          reserved,
        ]);
        expect(result).toMatchObject({
          refused: expect.stringContaining(
            legacy ? "legacy no-exit" : "budget 3",
          ),
        });
        expect(released).toEqual([5]);
        // Mirrored claims for one launch consume its allowance only once.
        for (const c of history.slice(1))
          if (c.says.ok) c.says.value.record = "same-launch";
        if (!legacy)
          expect(
            settleNoCauseStops(
              [drive],
              [],
              new Map([[7, ok(history)]]),
              Date.now(),
            )[0]?.class,
          ).toBe("re-armable");
      },
    );
    it(`counts executed losing reservations against the ${legacy ? "legacy" : "modern"} budget`, () => {
      const drive = pr(legacy);
      const facts = noCauseFacts(drive);
      const history = [
        claim(1, "ordinary stop"),
        claim(2, facts),
        claim(3, facts),
        claim(4, facts),
      ];
      for (const c of history) if (c.says.ok) c.says.value.end = null;
      for (const c of history) if (c.says.ok) c.says.value.attempt = 1;
      const local: ReadRecord[] = history.slice(1).map((c) => ({
        record: {
          ...record(facts),
          id: c.says.ok ? String(c.says.value.record) : "",
        },
        state: {
          kind: "ended",
          exit: { at: new Date().toISOString(), code: 11, signal: null },
          process: null,
        },
        result: null,
      }));
      expect(
        settleNoCauseStops(
          [drive],
          local,
          new Map([[7, ok(history)]]),
          Date.now(),
        )[0]?.class,
      ).toBe("stopped-unknown");
      // A runtime receipt is execution evidence even before its wrapper claims the record.
      const sent = local.map(
        (r): ReadRecord => ({
          ...r,
          state: { kind: "pending" },
          record: {
            ...r.record,
            attempts: [
              { at: r.record.createdAt, outcome: "sent", detail: "started" },
            ],
          },
        }),
      );
      expect(
        settleNoCauseStops(
          [drive],
          sent,
          new Map([[7, ok(history)]]),
          Date.now(),
        )[0]?.class,
      ).toBe("stopped-unknown");
      const failed = sent.map(
        (r): ReadRecord => ({
          ...r,
          record: {
            ...r.record,
            attempts: r.record.attempts.map((a) => ({
              ...a,
              outcome: "failed",
            })),
          },
        }),
      );
      expect(
        settleNoCauseStops(
          [drive],
          failed,
          new Map([[7, ok(history)]]),
          Date.now(),
        )[0]?.class,
      ).toBe("re-armable");
      const lost = sent.map(
        (r): ReadRecord => ({
          ...r,
          record: {
            ...r.record,
            attempts: r.record.attempts.map((a) => ({ ...a, outcome: "lost" })),
          },
        }),
      );
      expect(
        settleNoCauseStops(
          [drive],
          lost,
          new Map([[7, ok(history)]]),
          Date.now(),
        )[0]?.class,
      ).toBe("stopped-unknown");
    });
    it(`refuses a stale ${legacy ? "legacy" : "modern"} plan after a competing host consumed the remaining allowance`, async () => {
      const drive = pr(legacy);
      const facts = noCauseFacts(drive);
      const prior = legacy ? [] : [claim(1, facts), claim(2, facts)];
      expect(
        settleNoCauseStops(
          [drive],
          [],
          new Map([[7, ok(prior)]]),
          Date.now(),
        )[0]?.class,
      ).toBe("re-armable");
      const candidate = record(facts);
      // Another host wins the last allowance, ends without changing the ledger, then this stale plan reserves.
      const competed = claim(3, facts);
      const reserved = claim(4, facts, candidate.id, false);
      const { result, released } = await reserve(candidate, 4, [
        ...prior,
        competed,
        reserved,
      ]);
      expect(result).toMatchObject({
        refused: expect.stringContaining(
          legacy ? "legacy no-exit" : "budget 3",
        ),
      });
      expect(released).toEqual([4]);
    });
    it(`does not count its own ${legacy ? "legacy" : "modern"} reservation or later losing reservations`, async () => {
      const facts = noCauseFacts(pr(legacy));
      const candidate = record(facts);
      const prior = legacy ? [] : [claim(1, facts), claim(2, facts)];
      const reserved = claim(3, facts, candidate.id, false);
      const later = claim(4, facts, "losing-record", false);
      const { result, released } = await reserve(candidate, 3, [
        ...prior,
        reserved,
        later,
      ]);
      expect(result).toEqual({ claim: 3 });
      expect(released).toEqual([]);
    });
  }
});
