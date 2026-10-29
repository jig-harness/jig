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

  it("reads a data block without a version number as damage, never a future ledger", () => {
    for (const data of ["{}", '{"ledgerVersion":"2"}', '{"ledgerVersion":0}'])
      expect(
        parseLedger(
          `${LEDGER_MARKER}\n<!-- drive-pr-ledger-data\n${data}\n-->\n`,
        )?.kind,
      ).toBe("malformed");
  });

  it("round-trips an unconfirmed hold's round", () => {
    const l = ledger();
    l.held = l.held.map((h) => ({ ...h, round: -1 }));
    const rendered = renderLedger(l);
    if ("error" in rendered) throw new Error(rendered.error);
    const parsed = parseLedger(rendered.body);
    expect(parsed?.kind === "ledger" && parsed.ledger.held[0]?.round).toBe(-1);
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

  it("never takes a member's comment opening with the marker for the ledger", () => {
    const snap = snapshotFrom(
      [
        comment(20, `${LEDGER_MARKER}\nWhat is this comment for?`),
        comment(60, body(5)),
      ],
      null,
    );
    expect(snap.canonical?.comment.id).toBe(60);
    expect(snap.malformed.map((c) => c.id)).toEqual([20]);
    expect(snap.duplicates).toEqual([]);
  });
});

describe("what is posted", () => {
  it("carries no account and redacts email-shaped text", () => {
    const l = ledgerFromState(
      {
        ...driveState(),
        quotaPark: {
          vendor: "claude",
          window: "weekly",
          resetAt: null,
          at: "2026-10-01T10:00:00.000Z",
          account: "acct-0123456789abcdef",
        },
        parked: [
          {
            key: "PRRT_p",
            kind: "thread",
            reason: "Ask first.last@example.co.uk",
            round: 1,
          },
        ],
        decisions: [
          {
            at: "2026-10-01T10:30:00.000Z",
            round: 1,
            level: "unattended",
            class: "file-issue",
            what: "filed it for first.last@example.co.uk",
            record: "https://example.invalid/u/first.last@example.co.uk",
            reverse: "ask first.last@example.co.uk",
          },
        ],
      },
      {
        generation: 1,
        driver: {
          actor: ACTOR_A,
          clone: "clone-a",
          heartbeat: "2026-10-01T11:00:00.000Z",
          state: "running",
        },
        narrative: ["mailed a.b+c@sub.example.com today"],
        claims: [],
      },
    );
    expect(l.quotaPark).not.toHaveProperty("account");
    expect(l.parked[0]?.reason).toBe("Ask <redacted>");
    expect(l.narrative).toEqual(["mailed <redacted> today"]);
    expect(JSON.stringify(l.decisions)).not.toContain("@");
    expect(l.decisions[0]?.record).toBe("https://example.invalid/u/<redacted>");
  });

  it("redacts account identifiers inside agent-authored text", () => {
    const l = ledgerFromState(
      {
        ...driveState(),
        parked: [
          {
            key: "PRRT_p",
            kind: "thread",
            reason: "quota wall on acct-0123456789abcdef",
            round: 1,
          },
        ],
      },
      {
        generation: 1,
        driver: {
          actor: ACTOR_A,
          clone: "clone-a",
          heartbeat: "2026-10-01T11:00:00.000Z",
          state: "running",
        },
        narrative: ["billed to token:0123456789ab and api-key:ba9876543210"],
        claims: [],
      },
    );
    expect(l.parked[0]?.reason).toBe("quota wall on <redacted>");
    expect(l.narrative).toEqual(["billed to <redacted> and <redacted>"]);
  });
});

describe("takeover claims", () => {
  const claimBody = (clone: string, generation: number): string =>
    renderClaim({
      actor: ACTOR_A,
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

  it("ends a driver whose own claim lost its generation, even to an earlier id", () => {
    const parsed = parseClaim(claimBody("clone-c", 4));
    if (parsed === null) throw new Error("the claim does not parse");
    const own = { id: 200, claim: parsed };
    const rival = snapshotFrom(
      [comment(150, claimBody("clone-b", 4))],
      null,
    ).claims;
    // The rival's id is below the driver's own position, and it still wins.
    expect(newerClaim(rival, 200, "clone-c", own)?.id).toBe(150);
    // The driver's own winning claim stands against a later rival.
    const later = snapshotFrom(
      [comment(250, claimBody("clone-b", 4))],
      null,
    ).claims;
    expect(newerClaim(later, 200, "clone-c", own)).toBeNull();
  });

  it("lets a claim posted past the lease window replace an abandoned winner", () => {
    const at = (iso: string): string =>
      renderClaim({ actor: ACTOR_A, clone: "clone-c", generation: 4, at: iso });
    const snap = snapshotFrom(
      [
        comment(150, claimBody("clone-b", 4)),
        // Within the window of the winner: it lost.
        comment(200, at("2026-10-01T13:00:00.000Z")),
        // Past the window (240 minutes by default): the winner was abandoned.
        comment(300, at("2026-10-01T16:30:00.000Z")),
      ],
      null,
    );
    expect(effectiveClaims(snap.claims).map((c) => c.id)).toEqual([300]);
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

  it("carries the decisions taken unattended, listed in the body and seeded back", () => {
    const decided: DriveState = {
      ...driveState(),
      decisions: [
        {
          at: "2026-10-01T10:30:00.000Z",
          round: 3,
          level: "unattended",
          class: "file-issue",
          what: "filed the follow-up for the retry budget",
          record: "https://example.invalid/issues/7",
          reverse: "close the issue",
        },
      ],
    };
    const l = ledgerFromState(decided, {
      generation: 5,
      driver: {
        actor: ACTOR_A,
        clone: "clone-a",
        heartbeat: "2026-10-01T11:00:00.000Z",
        state: "running",
      },
      narrative: [],
      claims: [],
    });
    const rendered = renderLedger(l);
    if ("error" in rendered) throw new Error(rendered.error);
    expect(rendered.body).toContain("## Decisions taken unattended");
    expect(rendered.body).toContain(
      "- **file-issue** at `unattended`, round 3: filed the follow-up for the retry budget",
    );
    const parsed = parseLedger(rendered.body);
    if (parsed?.kind !== "ledger") throw new Error("not a ledger");
    const seeded = seedFromLedger(freshState(999), parsed.ledger);
    if ("error" in seeded) throw new Error(seeded.error);
    expect(seeded.state.decisions).toEqual(decided.decisions);
  });

  it("carries the arbiter's rulings, so a recovered drive parks under the same boundary", () => {
    const ruled: DriveState = {
      ...driveState(),
      rulings: [
        {
          key: "PRRT_r",
          verdict: "rejected",
          humanDecision: false,
          round: 2,
          at: "2026-10-01T10:30:00.000Z",
        },
        {
          key: "PRRT_h",
          verdict: "escalate",
          class: "human-decision",
          humanDecision: true,
          round: 2,
          at: "2026-10-01T10:31:00.000Z",
        },
      ],
    };
    const l = ledgerFromState(ruled, {
      generation: 5,
      driver: {
        actor: ACTOR_A,
        clone: "clone-a",
        heartbeat: "2026-10-01T11:00:00.000Z",
        state: "running",
      },
      narrative: [],
      claims: [],
    });
    const rendered = renderLedger(l);
    if ("error" in rendered) throw new Error(rendered.error);
    const parsed = parseLedger(rendered.body);
    if (parsed?.kind !== "ledger") throw new Error("not a ledger");
    const seeded = seedFromLedger(freshState(999), parsed.ledger);
    if ("error" in seeded) throw new Error(seeded.error);
    expect(seeded.state.rulings).toEqual(ruled.rulings);
  });

  it("carries a held finding's answer and the per-head budgets through a render", () => {
    const state: DriveState = {
      ...driveState(),
      attempts: 2,
      attemptsHead: SHA,
      deadlineRetries: 1,
      held: [
        ...driveState().held,
        {
          key: "b9a7a18089043564",
          kind: "finding",
          outcome: "accepted",
          round: 3,
          actor: ACTOR_A,
          reason: "fixed the missing lock",
        },
      ],
    };
    const rendered = renderLedger(
      ledgerFromState(state, {
        generation: 4,
        driver: {
          actor: ACTOR_A,
          clone: "clone-a",
          heartbeat: "2026-10-01T11:00:00.000Z",
          state: "running",
        },
        narrative: [],
        claims: [],
      }),
    );
    if ("error" in rendered) throw new Error(rendered.error);
    const parsed = parseLedger(rendered.body);
    if (parsed?.kind !== "ledger") throw new Error("the ledger does not parse");
    const seeded = seedFromLedger(freshState(999), parsed.ledger);
    if ("error" in seeded) throw new Error(seeded.error);
    expect(seeded.state.held.find((h) => h.kind === "finding")?.reason).toBe(
      "fixed the missing lock",
    );
    expect(seeded.state).toMatchObject({
      attempts: 2,
      attemptsHead: SHA,
      deadlineRetries: 1,
    });
  });

  it("clears this clone's round records when the ledger's round history is behind them", () => {
    const local: DriveState = {
      ...freshState(999),
      rounds: 7,
      lastReflectedRound: 6,
      lastReflectedAttempts: 2,
      lastEscalatedRound: 7,
      lastEscalatedInvariant: "the parser reads once",
      roundPaths: [
        { round: 6, paths: ["src/parser.ts"] },
        { round: 7, paths: ["src/parser.ts"] },
      ],
    };
    const seeded = seedFromLedger(local, ledger());
    if ("error" in seeded) throw new Error(seeded.error);
    expect(seeded.state).toMatchObject({
      rounds: 3,
      lastReflectedRound: 0,
      lastReflectedAttempts: 0,
      lastEscalatedRound: 0,
      lastEscalatedInvariant: "",
      roundPaths: [],
    });
  });

  it("keeps this clone's round records when the ledger's rounds are not behind them", () => {
    const local: DriveState = {
      ...freshState(999),
      rounds: 2,
      lastEscalatedRound: 2,
      lastEscalatedInvariant: "the parser reads once",
      roundPaths: [{ round: 2, paths: ["src/parser.ts"] }],
    };
    const seeded = seedFromLedger(local, ledger());
    if ("error" in seeded) throw new Error(seeded.error);
    expect(seeded.state).toMatchObject({
      rounds: 3,
      lastEscalatedRound: 2,
      lastEscalatedInvariant: "the parser reads once",
      roundPaths: [{ round: 2, paths: ["src/parser.ts"] }],
    });
  });

  it("refuses another pull request's ledger", () => {
    const seeded = seedFromLedger(freshState(998), ledger());
    expect("error" in seeded && seeded.error).toContain("PR #999");
  });

  it("refuses a ledger that would make an unusable state", () => {
    const l = ledger();
    l.held = [{ ...l.held[0], actor: "not-an-actor" } as Ledger["held"][0]];
    const seeded = seedFromLedger(freshState(999), l);
    expect("error" in seeded && seeded.error).toContain("usable");
  });
});
