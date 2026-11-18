/**
 * The follow-up marker's tables (`records/followup-values.ts`) hold what its
 * writers write and its reader reads: each run's markers carry the fields
 * the table says they carry and no other, and the reader takes every outcome
 * the table lists for a run and no outcome it does not.
 */
import { describe, expect, it } from "bun:test";
import { claimBody, readClaim } from "../records/forge-claims.ts";
import {
  type Carried,
  FOLLOWUP_FIELDS,
  FOLLOWUP_OUTCOMES,
  FOLLOWUP_RUNS,
  type FollowupRun,
} from "../records/followup-values.ts";
import {
  endedClaim,
  FOLLOWUP_CLAIM,
  manualClaim,
  saysOf,
  tickClaim,
} from "../records/launch-claims.ts";
import type { ClaimDraft, ClaimRecord } from "../records/forge-claims.ts";

const WRITER = { host: "sha256:0123456789abcdef" };
const RECORD = "20261101T120000Z-0123abcd";
const PR = 12;
const AT = "2026-11-01T12:00:00.000Z";

/** The fields the table says a run's markers carry: on every one, or on some. */
function carried(run: FollowupRun, how?: Carried): string[] {
  return Object.entries(FOLLOWUP_FIELDS)
    .filter(([, f]) => {
      const c = (f.carriedBy as Partial<Record<FollowupRun, Carried>>)[run];
      return c !== undefined && (how === undefined || c === how);
    })
    .map(([name]) => name)
    .sort();
}

/** A posted draft as the reader reads it back. */
function asRecord(draft: ClaimDraft): ClaimRecord {
  return {
    key: draft.key,
    at: AT,
    writer: WRITER,
    payload: draft.payload,
    legacy: false,
  };
}

const keys = (draft: ClaimDraft) => Object.keys(draft.payload).sort();

/** Every marker a tick's writers write: posted bare or in full, then ended done, failed (with its report's writer and cause) or by a death. */
function tickMarkers(): ClaimDraft[] {
  const bare = tickClaim(RECORD, { pr: PR, writer: WRITER });
  const full = tickClaim(
    RECORD,
    { pr: PR, writer: WRITER, host: "sha256:feedfacecafe0001", owner: true },
    "done",
  );
  const ended = (end: Parameters<typeof endedClaim>[3]) =>
    endedClaim("followup", asRecord(bare), PR, end, WRITER, "sha256:host");
  return [
    bare,
    full,
    ended({
      state: "ended",
      at: AT,
      exit: 0,
      outcome: "done",
      releaseTags: ["v1.2.3"],
    }),
    ended({ state: "ended", at: AT, exit: 1, outcome: "failed" }),
    ended({
      state: "ended",
      at: AT,
      exit: 1,
      outcome: "failed",
      by: "agent",
      cause: "needs-person",
    }),
    ended({ state: "died", at: AT, reason: "the session died" }),
  ];
}

/** Every marker a manual run's writers write: running, done, and ended. */
function manualMarkers(): ClaimDraft[] {
  const running = manualClaim(false, { pr: PR, writer: WRITER });
  return [
    running,
    manualClaim(true, { pr: PR, writer: WRITER }),
    endedClaim(
      "followup",
      asRecord(running),
      PR,
      { state: "ended", at: AT, exit: null, outcome: "done" },
      WRITER,
    ),
  ];
}

const MARKERS: Readonly<Record<FollowupRun, () => ClaimDraft[]>> = {
  tick: tickMarkers,
  manual: manualMarkers,
};

describe("the follow-up marker's fields", () => {
  it("lists a writer of markers for every run", () => {
    expect(Object.keys(MARKERS).sort()).toEqual(
      Object.keys(FOLLOWUP_RUNS).sort(),
    );
  });

  for (const run of Object.keys(FOLLOWUP_RUNS) as FollowupRun[]) {
    it(`are those a ${run} marker carries, and no other`, () => {
      const markers = MARKERS[run]();
      const written = [...new Set(markers.flatMap(keys))].sort();
      expect(written).toEqual(carried(run));
      for (const marker of markers) {
        expect(keys(marker).filter((k) => !carried(run).includes(k))).toEqual(
          [],
        );
        expect(
          carried(run, "always").filter((k) => !keys(marker).includes(k)),
        ).toEqual([]);
        expect(marker.payload.run).toBe(run);
      }
    });
  }

  it("hold, on every marker a writer writes, a value of the type the table declares", () => {
    const typeOf = (value: unknown) =>
      Array.isArray(value)
        ? "array"
        : typeof value === "number" && Number.isInteger(value)
          ? "integer"
          : typeof value;
    for (const run of Object.keys(FOLLOWUP_RUNS) as FollowupRun[])
      for (const marker of MARKERS[run]())
        for (const [field, value] of Object.entries(marker.payload))
          expect(typeOf(value)).toBe(
            FOLLOWUP_FIELDS[field as keyof typeof FOLLOWUP_FIELDS].type,
          );
  });

  it("carry a field the table says a run carries sometimes on some of its markers only", () => {
    for (const run of Object.keys(FOLLOWUP_RUNS) as FollowupRun[]) {
      const markers = MARKERS[run]();
      for (const field of carried(run, "sometimes"))
        expect({
          run,
          field,
          missing: markers.some((m) => !(field in m.payload)),
        }).toEqual({ run, field, missing: true });
    }
  });
});

describe("the follow-up marker's outcomes", () => {
  for (const run of Object.keys(FOLLOWUP_RUNS) as FollowupRun[]) {
    it(`are the only outcomes a ${run} marker's reader takes`, () => {
      const base = MARKERS[run]()[0];
      if (base === undefined) throw new Error(`no ${run} marker`);
      const reads = (outcome: string) => {
        const body = claimBody(FOLLOWUP_CLAIM, {
          ...base,
          payload: { ...base.payload, outcome },
        });
        const read = readClaim(FOLLOWUP_CLAIM, body, {
          repo: "o/r",
          number: PR,
        });
        return read?.ok === true;
      };
      for (const outcome of Object.keys(FOLLOWUP_OUTCOMES[run]))
        expect({ outcome, reads: reads(outcome) }).toEqual({
          outcome,
          reads: true,
        });
      const others = Object.values(FOLLOWUP_OUTCOMES)
        .flatMap((o) => Object.keys(o))
        .filter((o) => !Object.hasOwn(FOLLOWUP_OUTCOMES[run], o));
      for (const outcome of [...others, "unknown"])
        expect({ outcome, reads: reads(outcome) }).toEqual({
          outcome,
          reads: false,
        });
    });
  }

  it("read as the follow-up's answer for every tick outcome, and for a manual run's done alone", () => {
    const answer = (draft: ClaimDraft) => {
      const says = saysOf("followup", asRecord(draft), PR);
      return says.end?.state === "ended" ? says.end.outcome : null;
    };
    for (const outcome of Object.keys(FOLLOWUP_OUTCOMES.tick))
      expect(
        answer(
          tickClaim(RECORD, { pr: PR, writer: WRITER }, outcome as "done"),
        ),
      ).toBe(outcome as "done");
    expect(answer(manualClaim(true, { pr: PR, writer: WRITER }))).toBe("done");
    expect(answer(manualClaim(false, { pr: PR, writer: WRITER }))).toBeNull();
  });
});
