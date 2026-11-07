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
import type { LaunchRecord } from "../lib/launches.ts";
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
  for (const legacy of [false, true]) {
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
