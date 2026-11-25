/**
 * The structural-churn brake's resumable subset on the drive ledger
 * (`lib/state/ledger-churn.ts`): bounded `roundPaths` and `churnAckRound`
 * persistence, parse validation, oldest-first size cutting, and the
 * incomplete-evidence marker that makes the brake fail closed after a cut.
 */
import { describe, expect, it } from "bun:test";
import { structuralChurn } from "../scripts/lib/state/churn.ts";
import {
  type Ledger,
  ledgerFromState,
  parseLedger,
  renderLedger,
  seedFromLedger,
} from "../scripts/lib/state/ledger.ts";
import { ROUND_PATHS_WINDOW } from "../scripts/lib/state/round-paths.ts";
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
      narrative: [],
      claims: [],
    }),
    ...over,
  };
}

describe("ledger structural-churn evidence", () => {
  it("persists and restores bounded roundPaths and churnAckRound across clones", () => {
    const blob = (n: number) => `${String(n).padStart(2, "0")}`.repeat(20);
    const manyRounds = Array.from(
      { length: ROUND_PATHS_WINDOW + 3 },
      (_, i) => ({
        round: i + 1,
        paths: ["src/a.ts"],
        severe: false,
        blobs: { "src/a.ts": blob(i + 1) },
      }),
    );
    const source: DriveState = {
      ...driveState(),
      rounds: manyRounds.length,
      roundPaths: manyRounds,
      churnAckRound: 10,
    };
    const built = ledgerFromState(source, {
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
    expect(built.roundPaths).toHaveLength(ROUND_PATHS_WINDOW);
    expect(built.roundPaths?.[0]?.round).toBe(4);
    expect(built.churnAckRound).toBe(10);

    const rendered = renderLedger(built);
    if ("error" in rendered) throw new Error(rendered.error);
    const parsed = parseLedger(rendered.body);
    expect(parsed?.kind).toBe("ledger");
    if (parsed?.kind !== "ledger") return;
    expect(parsed.ledger.roundPaths).toEqual(built.roundPaths);
    expect(parsed.ledger.churnAckRound).toBe(10);

    // Fresh clone takeover gets the bounded observations so a continuing
    // streak still trips the brake on the next round.
    const freshSeeded = seedFromLedger(freshState(999), parsed.ledger);
    if ("error" in freshSeeded) throw new Error(freshSeeded.error);
    expect(freshSeeded.state.roundPaths).toEqual(
      manyRounds.slice(-ROUND_PATHS_WINDOW),
    );
    expect(freshSeeded.state.churnAckRound).toBe(10);
    expect(structuralChurn(freshSeeded.state, { rounds: 4 })?.rounds).toEqual([
      12, 13, 14, 15,
    ]);

    // Older clone adopts a newer churnAckRound answered on another clone
    // rather than re-parking on consumed evidence.
    const answered = ledgerFromState(
      { ...source, churnAckRound: manyRounds.length },
      {
        generation: 6,
        driver: {
          actor: ACTOR_A,
          clone: "clone-a",
          heartbeat: "2026-10-01T11:05:00.000Z",
          state: "running",
        },
        narrative: [],
        claims: [],
      },
    );
    const staleLocal: DriveState = {
      ...freshState(999),
      rounds: 12,
      roundPaths: manyRounds.slice(0, 12),
      churnAckRound: 8,
    };
    const updated = seedFromLedger(staleLocal, answered);
    if ("error" in updated) throw new Error(updated.error);
    expect(updated.state.churnAckRound).toBe(manyRounds.length);
    expect(structuralChurn(updated.state, { rounds: 4 })).toBeNull();
  });

  it("rejects malformed churn evidence or out-of-range churnAckRound on parse", () => {
    const blob = "b".repeat(40);
    const rendered = renderLedger(
      ledger({
        round: 3,
        roundPaths: [
          {
            round: 1,
            paths: ["src/a.ts"],
            severe: false,
            blobs: { "src/a.ts": blob },
          },
        ],
        churnAckRound: 2,
      }),
    );
    if ("error" in rendered) throw new Error(rendered.error);
    expect(parseLedger(rendered.body)?.kind).toBe("ledger");
    expect(
      parseLedger(
        rendered.body.replace('"churnAckRound":2', '"churnAckRound":9'),
      )?.kind,
    ).toBe("malformed");
    expect(parseLedger(rendered.body.replace(blob, "not-a-sha"))?.kind).toBe(
      "malformed",
    );
  });

  it("trims roundPaths oldest-first under the size limit without dropping churnAckRound", () => {
    const entries = [1, 2, 3].map((round) => ({
      round,
      paths: [`src/${"p".repeat(120)}-${round}.ts`],
      severe: false,
      blobs: { [`src/${"p".repeat(120)}-${round}.ts`]: SHA },
    }));
    const l = ledger({
      round: 3,
      roundPaths: entries,
      churnAckRound: 2,
      narrative: [],
    });
    const full = renderLedger(l, 10_000_000);
    if ("error" in full) throw new Error(full.error);
    const fullBytes = Buffer.byteLength(full.body);
    const cut = renderLedger(l, fullBytes - 200);
    if ("error" in cut) throw new Error(cut.error);
    expect(cut.ledger.churnAckRound).toBe(2);
    expect(cut.ledger.roundPaths?.length ?? 0).toBeLessThan(entries.length);
    expect(
      cut.ledger.cut.some(
        (c) => c === "the older round paths" || c === "the round paths",
      ),
    ).toBe(true);
  });

  it("marks churn evidence lost when the size cut drops unacknowledged rounds and keeps that marker on re-render", () => {
    const blob = (n: number) => `${String(n).padStart(2, "0")}`.repeat(20);
    const entries = [1, 2, 3, 4].map((round) => ({
      round,
      paths: [`src/${"p".repeat(120)}-${round}.ts`],
      severe: false,
      blobs: { [`src/${"p".repeat(120)}-${round}.ts`]: blob(round) },
    }));
    const full = renderLedger(
      ledger({ round: 4, roundPaths: entries, narrative: [] }),
      10_000_000,
    );
    if ("error" in full) throw new Error(full.error);
    const cut = renderLedger(
      ledger({ round: 4, roundPaths: entries, narrative: [] }),
      Buffer.byteLength(full.body) - 200,
    );
    if ("error" in cut) throw new Error(cut.error);
    const parsed = parseLedger(cut.body);
    if (parsed?.kind !== "ledger") throw new Error("expected ledger");

    const seeded = seedFromLedger(freshState(999), parsed.ledger);
    if ("error" in seeded) throw new Error(seeded.error);
    expect(seeded.state.churnEvidenceLost).toBe(true);

    // Re-rendering under a generous limit keeps the loss marker so a later
    // clone still sees that unacknowledged churn evidence was dropped.
    const next = renderLedger(
      ledgerFromState(seeded.state, {
        generation: 5,
        driver: {
          actor: ACTOR_A,
          clone: "clone-b",
          heartbeat: "2026-10-01T11:10:00.000Z",
          state: "running",
        },
        narrative: [],
        claims: [],
      }),
    );
    if ("error" in next) throw new Error(next.error);
    expect(next.ledger.cut).toContain("the older round paths");

    // A later ledger that acknowledges the current round clears the loss flag.
    const acked = seedFromLedger(
      seeded.state,
      ledger({
        round: 4,
        roundPaths: entries.slice(-2),
        churnAckRound: 4,
        cut: ["the older round paths"],
      }),
    );
    if ("error" in acked) throw new Error(acked.error);
    expect(acked.state.churnEvidenceLost).toBeUndefined();

    // Dropping only already-acknowledged rounds does not mark evidence lost.
    const onlyAckCut = seedFromLedger(
      freshState(999),
      ledger({
        round: 4,
        roundPaths: entries.slice(2),
        churnAckRound: 2,
        cut: ["the older round paths"],
      }),
    );
    if ("error" in onlyAckCut) throw new Error(onlyAckCut.error);
    expect(onlyAckCut.state.churnEvidenceLost).toBeUndefined();
  });
});
