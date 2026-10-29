/**
 * The drive ledger's pure half (`lib/state/ledger.ts`): the render/parse
 * round trip, the size cut and its order, the version refusal, which
 * comments are trusted and which ledger is canonical, the claims in force,
 * and seeding a state from a ledger.
 */
import { describe, expect, it } from "bun:test";
import {
  type ForgeComment,
  type Ledger,
  LEDGER_MARKER,
  claimFloor,
  effectiveClaims,
  ledgerFromState,
  newerClaim,
  parseClaim,
  parseLedger,
  renderClaim,
  renderLedger,
  seedFromLedger,
  snapshotFrom,
} from "../scripts/lib/state/ledger.ts";
import { type DriveState, freshState } from "../scripts/lib/state/schema.ts";

const ACTOR_A = "wt-aaaaaaaaaaaaaaaa";
const SHA = "a91d4f7c05444444444444444444444444444444";

function driveState(): DriveState {
  return {
    ...freshState(999),
    rounds: 3,
    phase: "pass",
    lastCountedHead: SHA,
    verifiedSha: SHA,
    readyMarkedRound: 1,
    parked: [
      {
        key: "PRRT_parked",
        kind: "thread",
        reason: "Choose between <a> and --> b: a decision -->",
        round: 2,
        at: "2026-10-01T10:00:00.000Z",
      },
    ],
    held: [
      {
        key: "PRRT_held",
        kind: "thread",
        outcome: "accepted",
        round: 3,
        actor: ACTOR_A,
        commentUrl: "https://example.invalid/held",
        verifiedSha: SHA,
      },
    ],
  };
}

function ledger(over: Partial<Ledger> = {}): Ledger {
  return {
    ...ledgerFromState(driveState(), {
      generation: 4,
      driver: {
        actor: ACTOR_A,
        account: null,
        clone: "clone-a",
        heartbeat: "2026-10-01T11:00:00.000Z",
        state: "running",
      },
      narrative: Array.from({ length: 30 }, (_, i) => `narrative line ${i}`),
      claims: [],
    }),
    ...over,
  };
}

function comment(
  id: number,
  body: string,
  over: Partial<ForgeComment> = {},
): ForgeComment {
  return {
    id,
    body,
    login: "maintainer",
    association: "MEMBER",
    updatedAt: "2026-10-01T11:00:00Z",
    ...over,
  };
}

describe("render and parse", () => {
  it("round-trips a ledger, escaping what could close the comment", () => {
    const rendered = renderLedger(ledger());
    if ("error" in rendered) throw new Error(rendered.error);
    expect(rendered.body.startsWith(LEDGER_MARKER)).toBe(true);
    // The parked reason's `-->` and `<a>` never reach the body raw.
    const data = rendered.body.slice(rendered.body.indexOf("{"));
    expect(data).not.toContain("<a>");
    expect(rendered.body.match(/-->/g)?.length).toBe(2);
    const parsed = parseLedger(rendered.body);
    expect(parsed?.kind).toBe("ledger");
    if (parsed?.kind !== "ledger") return;
    expect(parsed.ledger).toEqual(rendered.ledger);
    expect(parsed.ledger.parked[0]?.reason).toBe(
      "Choose between <a> and --> b: a decision -->",
    );
    expect(parsed.ledger.narrative).toHaveLength(20);
    expect(parsed.ledger.narrative.at(-1)).toBe("narrative line 29");
    expect(parsed.ledger.decisions).toEqual([]);
  });

  it("names a version it does not read, and leaves other comments alone", () => {
    const rendered = renderLedger(ledger());
    if ("error" in rendered) throw new Error(rendered.error);
    const v9 = rendered.body.replace('"ledgerVersion":1', '"ledgerVersion":9');
    expect(parseLedger(v9)).toEqual({ kind: "unknown-version", version: 9 });
    expect(parseLedger(`quoting ${LEDGER_MARKER} in a discussion`)).toBeNull();
    expect(parseLedger(`${LEDGER_MARKER}\nno data`)?.kind).toBe("malformed");
  });
});

describe("the size cut", () => {
  const bulky = (): Ledger =>
    ledger({
      held: Array.from({ length: 400 }, (_, i) => ({
        key: `PRRT_held_${i}`,
        kind: "thread" as const,
        round: 3,
        actor: ACTOR_A,
        outcome: "accepted" as const,
        commentUrl: `https://example.invalid/${i}`,
      })),
      narrative: Array.from({ length: 20 }, () => "n".repeat(400)),
    });

  function sizeOf(l: Ledger): number {
    const r = renderLedger(l, 10_000_000);
    if ("error" in r) throw new Error(r.error);
    return Buffer.byteLength(r.body);
  }

  it("drops held outcomes first, then the narrative, never a parked decision", () => {
    const full = sizeOf(bulky());
    const noOutcomes = sizeOf({
      ...bulky(),
      held: bulky().held.map(({ outcome: _o, ...h }) => h),
      cut: ["held items' outcomes"],
    });
    const first = renderLedger(bulky(), full - 1);
    if ("error" in first) throw new Error(first.error);
    expect(first.ledger.cut).toEqual(["held items' outcomes"]);
    expect(first.ledger.held.every((h) => h.outcome === undefined)).toBe(true);
    expect(first.ledger.narrative).toHaveLength(20);

    const second = renderLedger(bulky(), noOutcomes - 1);
    if ("error" in second) throw new Error(second.error);
    expect(second.ledger.cut).toEqual([
      "held items' outcomes",
      "the narrative",
    ]);
    expect(second.ledger.narrative).toEqual([]);
    expect(second.ledger.parked).toEqual(bulky().parked);
    expect(Buffer.byteLength(second.body)).toBeLessThanOrEqual(noOutcomes - 1);
  });

  it("refuses rather than drop a parked decision", () => {
    const r = renderLedger(ledger(), 200);
    expect("error" in r && r.error).toContain("parked decisions");
  });
});

describe("trust and the canonical ledger", () => {
  const body = (generation: number): string => {
    const r = renderLedger(ledger({ generation }));
    if ("error" in r) throw new Error(r.error);
    return r.body;
  };

  it("ignores and reports a ledger from an unassociated author", () => {
    const forged = comment(10, body(50), {
      login: "drive-by",
      association: "NONE",
    });
    const snap = snapshotFrom([forged], "drive-bot");
    expect(snap.canonical).toBeNull();
    expect(snap.untrusted.map((c) => c.id)).toEqual([10]);
    expect(snap.maxGeneration).toBe(0);
  });

  it("trusts the drive's own login whatever its association", () => {
    const own = comment(11, body(3), {
      login: "drive-bot",
      association: "CONTRIBUTOR",
    });
    expect(snapshotFrom([own], "drive-bot").canonical?.comment.id).toBe(11);
    expect(snapshotFrom([own], null).canonical).toBeNull();
  });

  it("makes the lower id canonical when two creations raced", () => {
    const snap = snapshotFrom(
      [comment(70, body(6)), comment(60, body(5))],
      null,
    );
    expect(snap.canonical?.comment.id).toBe(60);
    expect(snap.duplicates.map((c) => c.id)).toEqual([70]);
    expect(snap.maxGeneration).toBe(6);
  });
});

describe("takeover claims", () => {
  const claimBody = (clone: string, generation: number): string =>
    renderClaim({
      actor: ACTOR_A,
      account: null,
      clone,
      generation,
      at: "2026-10-01T12:00:00.000Z",
    });

  it("round-trips a claim", () => {
    expect(parseClaim(claimBody("clone-b", 4))?.clone).toBe("clone-b");
  });

  it("counts only the earliest claim on a generation", () => {
    const snap = snapshotFrom(
      [
        comment(200, claimBody("clone-c", 4)),
        comment(150, claimBody("clone-b", 4)),
        comment(300, claimBody("clone-d", 5)),
      ],
      null,
    );
    expect(effectiveClaims(snap.claims).map((c) => c.id)).toEqual([150, 300]);
    expect(claimFloor(snap.claims)).toBe(300);
    // The winner (clone-b, 150) is not ended by the loser it beat (200).
    expect(newerClaim(snap.claims.slice(0, 2), 150, "clone-b")).toBeNull();
    // A driver from before both is ended by the winner.
    expect(newerClaim(snap.claims, 0, "clone-a")?.id).toBe(150);
    // A driver's own clone's claim never ends it.
    expect(newerClaim(snap.claims, 150, "clone-d")).toBeNull();
  });
});

describe("seeding", () => {
  it("lays the ledger's subset over a fresh state", () => {
    const seeded = seedFromLedger(freshState(999), ledger());
    if ("error" in seeded) throw new Error(seeded.error);
    const { state, dropped } = seeded;
    expect(dropped).toEqual([]);
    expect(state.rounds).toBe(3);
    expect(state.parked.map((p) => p.key)).toEqual(["PRRT_parked"]);
    expect(state.held.map((h) => h.key)).toEqual(["PRRT_held"]);
    expect(state.ledgerGeneration).toBe(4);
  });

  it("leaves a held item whose outcome was cut to be triaged afresh", () => {
    const l = ledger();
    l.held = l.held.map(({ outcome: _o, ...h }) => h);
    const seeded = seedFromLedger(freshState(999), l);
    if ("error" in seeded) throw new Error(seeded.error);
    const { state, dropped } = seeded;
    expect(state.held).toEqual([]);
    expect(dropped).toEqual(["PRRT_held"]);
  });

  it("refuses a ledger that would make an unusable state", () => {
    const l = ledger();
    l.held = [{ ...l.held[0], actor: "not-an-actor" } as Ledger["held"][0]];
    const seeded = seedFromLedger(freshState(999), l);
    expect("error" in seeded && seeded.error).toContain("usable");
  });
});
