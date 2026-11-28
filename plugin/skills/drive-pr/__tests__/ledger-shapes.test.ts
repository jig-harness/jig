import { expect, test } from "bun:test";
import { matches } from "../../../shared/shapes.ts";
import { LEDGER_PAYLOAD_SHAPE } from "../scripts/lib/state/ledger-shapes.ts";
import {
  ledgerFromState,
  renderLedger,
  parseLedger,
} from "../scripts/lib/state/ledger.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { markerText } from "../../../shared/records/envelope.ts";

function ledger() {
  return ledgerFromState(freshState(12), {
    generation: 1,
    driver: {
      actor: "tree",
      clone: "clone",
      heartbeat: "2026-01-01T00:00:00.000Z",
      state: "running",
    },
    narrative: ["context"],
    claims: [],
  });
}

test("the ledger writer emits the declared payload shape", () => {
  const rendered = renderLedger(ledger());
  expect("body" in rendered).toBe(true);
  if (!("body" in rendered)) return;
  const text = markerText(rendered.body, "drive-pr-ledger-data");
  expect(text.ok).toBe(true);
  if (!text.ok) return;
  const value: unknown = JSON.parse(text.value);
  expect(matches(LEDGER_PAYLOAD_SHAPE, value)).toBe(true);
  expect(parseLedger(rendered.body)?.kind).toBe("ledger");
});

test("the ledger description rejects damaged nested held items and driver fields", () => {
  const valid = ledger();
  for (const bad of [
    { ...valid, generation: 0 },
    { ...valid, held: [{ key: "key", kind: "thread", round: 0, actor: 1 }] },
    { ...valid, driver: { ...valid.driver, state: "unknown" } },
    { ...valid, claims: [{ id: "1", clone: "clone", generation: 1 }] },
    { ...valid, narrative: [1] },
  ])
    expect(matches(LEDGER_PAYLOAD_SHAPE, bad)).toBe(false);
});

test("the ledger shape preserves legacy optional fields and unconstrained quota park objects", () => {
  const {
    events: _e,
    ciActions: _c,
    rulings: _r,
    resolvedParks: _p,
    roundPaths: _rp,
    churnAckRound: _ca,
    ...legacy
  } = ledger();
  expect(matches(LEDGER_PAYLOAD_SHAPE, legacy)).toBe(true);
  expect(matches(LEDGER_PAYLOAD_SHAPE, { ...legacy, quotaPark: {} })).toBe(
    true,
  );
});

test("a parked person is any GitHub login, an Enterprise Managed User's included", () => {
  const parked = (person: string) => ({
    ...ledger(),
    parked: [{ key: "t1", kind: "thread", reason: "why", round: 1, person }],
  });
  const read = (person: string) => {
    const rendered = renderLedger(parked(person) as ReturnType<typeof ledger>);
    if (!("body" in rendered)) throw new Error("the ledger did not render");
    return parseLedger(rendered.body);
  };
  for (const person of ["mona_acme", "Mona_ACME", "review-bot[bot]"]) {
    expect(matches(LEDGER_PAYLOAD_SHAPE, parked(person))).toBe(true);
    const got = read(person);
    expect(got?.kind).toBe("ledger");
    if (got?.kind === "ledger")
      expect(got.ledger.parked[0]?.person).toBe(person);
  }
  for (const person of ["@mona_acme", "mona acme", "org/team", "", "_mona"])
    expect(read(person)?.kind).toBe("malformed");
});
