import { describe, expect, it } from "bun:test";
import {
  freshState,
  isUsableState,
  type DriveState,
} from "../scripts/lib/state/schema.ts";
import { isOptionalEvents, recordEvent } from "../scripts/lib/state/events.ts";
import { isOptionalCiActions } from "../scripts/lib/state/ci-actions.ts";
import {
  ledgerFromState,
  parseLedger,
  renderLedger,
  seedFromLedger,
} from "../scripts/lib/state/ledger.ts";
import type { StateStore } from "../scripts/lib/state/store.ts";

describe("additive CI telemetry", () => {
  it("records bounded telemetry without changing the control events older readers validate", async () => {
    let state = freshState(999);
    const store = {
      update: async (transform: (s: DriveState) => DriveState) => {
        state = transform(state);
      },
    } as StateStore;
    for (let n = 0; n < 12; n += 1)
      await recordEvent(
        store,
        JSON.stringify({
          kind: "ci",
          cause: `repair: check-${n}: ${"x".repeat(2000)}`,
        }),
      );
    expect(state.ciActions).toHaveLength(10);
    expect(state.ciActions?.[0]?.detail).toStartWith("check-2:");
    expect(state.ciActions?.[0]?.detail.length).toBe(1024);
    expect(state.events).toBeUndefined();
    expect(isOptionalEvents(state.events)).toBe(true);
    expect(isOptionalCiActions(state.ciActions)).toBe(true);
    expect(isUsableState(state, 999)).toBe(true);
  });

  it("round-trips and seeds telemetry in an ordinary version-one ledger", () => {
    const state: DriveState = {
      ...freshState(999),
      ciActions: [
        {
          at: "2026-11-14T12:00:00.000Z",
          round: 0,
          action: "rerun",
          detail: "run 41 on head a for tests",
        },
      ],
    };
    const ledger = ledgerFromState(state, {
      generation: 1,
      claims: [],
      narrative: [],
      driver: {
        actor: "wt-aaaaaaaaaaaaaaaa",
        clone: "clone-a",
        heartbeat: "2026-11-14T12:00:00.000Z",
        state: "running",
      },
    });
    const rendered = renderLedger(ledger);
    expect("error" in rendered).toBe(false);
    if ("error" in rendered) return;
    expect(rendered.ledger.ledgerVersion).toBe(1);
    expect(rendered.body).toContain("CI rerun:");
    const parsed = parseLedger(rendered.body);
    expect(parsed?.kind).toBe("ledger");
    if (parsed?.kind !== "ledger") return;
    expect(parsed.ledger.ciActions).toEqual(state.ciActions);
    expect(isOptionalEvents(parsed.ledger.events)).toBe(true);
    const seeded = seedFromLedger(freshState(999), parsed.ledger);
    expect("error" in seeded).toBe(false);
    if ("error" in seeded) return;
    expect(seeded.state.ciActions).toEqual(state.ciActions);
  });

  it("bounds telemetry after redaction expands its detail", () => {
    const state: DriveState = {
      ...freshState(999),
      ciActions: [
        {
          at: "2026-11-14T12:00:00.000Z",
          round: 0,
          action: "repair",
          detail: "a@b.zz ".repeat(140),
        },
      ],
    };
    const ledger = ledgerFromState(state, {
      generation: 1,
      claims: [],
      narrative: [],
      driver: {
        actor: "wt-aaaaaaaaaaaaaaaa",
        clone: "clone-a",
        heartbeat: "2026-11-14T12:00:00.000Z",
        state: "running",
      },
    });
    const rendered = renderLedger(ledger);
    expect("error" in rendered).toBe(false);
    if ("error" in rendered) return;
    expect(parseLedger(rendered.body)?.kind).toBe("ledger");
    expect(ledger.ciActions?.[0]?.detail.length).toBeLessThanOrEqual(1024);
    expect(ledger.ciActions?.[0]?.detail).not.toContain("a@b.zz");
  });

  it("redacts before bounding so a suffix cannot leak as an identifier fragment", async () => {
    let state = freshState(999);
    const store = {
      update: async (transform: (s: DriveState) => DriveState) => {
        state = transform(state);
      },
    } as StateStore;
    await recordEvent(
      store,
      JSON.stringify({
        kind: "ci",
        cause: `rerun: ${" ".repeat(1018)}alice@example.com`,
      }),
    );
    expect(state.ciActions?.[0]?.detail).not.toContain("alice@");
    expect(state.ciActions?.[0]?.detail.length).toBe(1024);
  });
});
