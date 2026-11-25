/**
 * The structural-churn brake's pure parts: the predicate over recorded round
 * evidence, the framed decision it parks with, and the stored state's
 * acceptance of the per-round facts and the acknowledgment.
 */
import { describe, expect, it } from "bun:test";
import {
  checkParkedDecision,
  DECISION_BYTE_LIMIT,
} from "../../../shared/decisions/park.ts";
import {
  churnKey,
  structuralChurn,
  type ChurnTrip,
} from "../scripts/lib/state/churn.ts";
import { churnDecision } from "../scripts/lib/state/churn-decision.ts";
import { parseRoundInput } from "../scripts/lib/state/churn-facts.ts";
import { churnRoundsSetting } from "../scripts/lib/status/churn-brake.ts";
import {
  foldRoundPaths,
  freshState,
  isUsableState,
  type DriveState,
  type RoundPaths,
} from "../scripts/lib/state/schema.ts";

const blob = (n: number) => n.toString(16).padStart(40, "0");

/** One recorded round: paths, severity and the blob of each path. */
function round(
  r: number,
  paths: string[],
  opts: { severe?: boolean; blobs?: Record<string, number> } = {},
): RoundPaths {
  return {
    round: r,
    paths: [...paths].sort(),
    ...(opts.severe === undefined ? {} : { severe: opts.severe }),
    ...(opts.blobs === undefined
      ? {}
      : {
          blobs: Object.fromEntries(
            Object.entries(opts.blobs).map(([p, n]) => [p, blob(n)]),
          ),
        }),
  };
}

/** `n` consecutive non-severe rounds on `a.ts`, rewritten each round. */
function churning(from: number, n: number): RoundPaths[] {
  return Array.from({ length: n }, (_, i) =>
    round(from + i, ["a.ts"], { severe: false, blobs: { "a.ts": from + i } }),
  );
}

describe("structuralChurn: same-file", () => {
  it("trips on N consecutive non-severe rounds rewriting the same file", () => {
    expect(
      structuralChurn({ roundPaths: churning(3, 4) }, { rounds: 4 }),
    ).toEqual({ kind: "same-file", paths: ["a.ts"], rounds: [3, 4, 5, 6] });
  });

  it("names only the files in every round of the streak", () => {
    const roundPaths = churning(1, 4).map((e, i) =>
      i === 2 ? { ...e, paths: ["a.ts", "b.ts"] } : e,
    );
    expect(structuralChurn({ roundPaths }, { rounds: 4 })?.paths).toEqual([
      "a.ts",
    ]);
  });

  it("does not trip when a round in the streak carried a high or blocker finding", () => {
    const roundPaths = churning(1, 4).map((e) =>
      e.round === 3 ? { ...e, severe: true } : e,
    );
    expect(structuralChurn({ roundPaths }, { rounds: 4 })).toBeNull();
  });

  it("restarts the streak after a severe round and parks only once four follow it", () => {
    const severities = [false, false, true, false, false, false, false];
    const all = severities.map((severe, i) =>
      round(i + 1, ["a.ts"], { severe, blobs: { "a.ts": i + 1 } }),
    );
    for (let k = 1; k < all.length; k++)
      expect(
        structuralChurn({ roundPaths: all.slice(0, k) }, { rounds: 4 }),
      ).toBeNull();
    expect(structuralChurn({ roundPaths: all }, { rounds: 4 })).toEqual({
      kind: "same-file",
      paths: ["a.ts"],
      rounds: [4, 5, 6, 7],
    });
  });

  it("does not count a round recorded without its severity", () => {
    const roundPaths = churning(1, 4).map((e) => {
      if (e.round !== 2) return e;
      const { severe: _severe, ...rest } = e;
      return rest;
    });
    expect(structuralChurn({ roundPaths }, { rounds: 4 })).toBeNull();
  });

  it("does not trip on a streak shorter than N", () => {
    expect(
      structuralChurn({ roundPaths: churning(1, 3) }, { rounds: 4 }),
    ).toBeNull();
  });

  it("needs the rounds to be consecutive", () => {
    const roundPaths = churning(1, 4).map((e) =>
      e.round === 4 ? { ...e, round: 5 } : e,
    );
    expect(structuralChurn({ roundPaths }, { rounds: 4 })).toBeNull();
  });

  it("does not count a file left unchanged between two rounds", () => {
    const roundPaths = churning(1, 4).map((e) =>
      e.round === 3 ? { ...e, blobs: { "a.ts": blob(2) } } : e,
    );
    expect(structuralChurn({ roundPaths }, { rounds: 4 })).toBeNull();
  });

  it("never counts a file whose blob is unknown as rewritten", () => {
    const roundPaths = churning(1, 4).map(({ blobs: _blobs, ...e }) => e);
    expect(structuralChurn({ roundPaths }, { rounds: 4 })).toBeNull();
    const oneMissing = churning(1, 4).map((e) =>
      e.round === 3 ? { round: e.round, paths: e.paths, severe: false } : e,
    );
    expect(
      structuralChurn({ roundPaths: oneMissing }, { rounds: 4 }),
    ).toBeNull();
  });

  it("reads a blob entry inherited from Object.prototype as unknown", () => {
    const roundPaths = churning(1, 4).map((e) => ({
      ...e,
      blobs: {} as Record<string, string>,
    }));
    expect(
      structuralChurn(
        {
          roundPaths: roundPaths.map((e) => ({ ...e, paths: ["constructor"] })),
        },
        { rounds: 4 },
      ),
    ).toBeNull();
  });

  it("reads only the rounds after churnAckRound", () => {
    const roundPaths = churning(1, 5);
    expect(
      structuralChurn({ roundPaths, churnAckRound: 2 }, { rounds: 4 }),
    ).toBeNull();
    expect(
      structuralChurn({ roundPaths, churnAckRound: 1 }, { rounds: 4 })?.rounds,
    ).toEqual([2, 3, 4, 5]);
  });

  it("is off at 0", () => {
    expect(
      structuralChurn({ roundPaths: churning(1, 6) }, { rounds: 0 }),
    ).toBeNull();
  });
});

describe("structuralChurn: oscillation", () => {
  const abA = [
    round(1, ["a.ts"], { severe: true, blobs: { "a.ts": 10 } }),
    round(2, ["a.ts"], { severe: true, blobs: { "a.ts": 11 } }),
    round(3, ["a.ts"], { severe: true, blobs: { "a.ts": 10 } }),
  ];

  it("trips when a file returns to an earlier content, severe rounds included", () => {
    expect(structuralChurn({ roundPaths: abA }, { rounds: 4 })).toEqual({
      kind: "oscillation",
      paths: ["a.ts"],
      rounds: [1, 2, 3],
    });
  });

  it("does not trip on a file that only moves forward", () => {
    const roundPaths = abA.map((e) =>
      e.round === 3 ? { ...e, blobs: { "a.ts": blob(12) } } : e,
    );
    expect(structuralChurn({ roundPaths }, { rounds: 4 })).toBeNull();
  });

  it("does not trip on a file left unchanged", () => {
    const roundPaths = abA.map((e) => ({ ...e, blobs: { "a.ts": blob(10) } }));
    expect(structuralChurn({ roundPaths }, { rounds: 4 })).toBeNull();
  });

  it("finds the return across rounds the file was not recorded in", () => {
    const roundPaths = [
      abA[0] as RoundPaths,
      round(2, ["b.ts"], { severe: false, blobs: { "b.ts": 1 } }),
      round(3, ["a.ts"], { severe: false, blobs: { "a.ts": 11 } }),
      round(4, ["a.ts"], { severe: false, blobs: { "a.ts": 10 } }),
    ];
    expect(structuralChurn({ roundPaths }, { rounds: 4 })).toEqual({
      kind: "oscillation",
      paths: ["a.ts"],
      rounds: [1, 3, 4],
    });
  });

  it("judges a return only among the rounds the file drew a finding in", () => {
    const roundPaths = [
      round(1, ["a.ts"], { severe: false, blobs: { "a.ts": 10 } }),
      round(2, ["b.ts"], { severe: false, blobs: { "b.ts": 1 } }),
      round(3, ["a.ts"], { severe: false, blobs: { "a.ts": 10 } }),
    ];
    expect(structuralChurn({ roundPaths }, { rounds: 4 })).toBeNull();
  });

  it("is consumed by churnAckRound and off at 0", () => {
    expect(
      structuralChurn({ roundPaths: abA, churnAckRound: 1 }, { rounds: 4 }),
    ).toBeNull();
    expect(structuralChurn({ roundPaths: abA }, { rounds: 0 })).toBeNull();
  });
});

describe("churnDecision", () => {
  const trip: ChurnTrip = {
    kind: "same-file",
    paths: ["a.ts"],
    rounds: [3, 4, 5, 6],
  };

  it("passes the parked-decision check under structural-churn", () => {
    const d = churnDecision(trip, "999", 6, 4);
    expect(checkParkedDecision(d, "structural-churn")).toEqual([]);
    expect(d.class).toBe("structural-churn");
    expect(d.call.options.map((o) => o.id)).toEqual([
      "defer",
      "narrow",
      "continue",
    ]);
    expect(d.call.recommended).toBe("defer");
    expect(d.call.question).toContain("`a.ts`");
    expect(d.call.question).toContain("rounds 3, 4, 5, 6");
    expect(d.alreadyDone).toContain("round 6");
    const cont = d.call.options.find((o) => o.id === "continue");
    expect(cont?.summary).toContain("restarts after round 6");
    expect(cont?.summary).toContain("same-file streak needs 4 more rounds");
    expect(cont?.summary).toContain("three");
  });

  it("fits the park's byte limit for long multibyte paths", () => {
    const paths = Array.from(
      { length: 5 },
      (_, i) => `${"界".repeat(160)}${i}.ts`,
    );
    const d = churnDecision({ ...trip, paths }, "999", 6, 4);
    expect(checkParkedDecision(d, "structural-churn")).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThan(
      DECISION_BYTE_LIMIT,
    );
  });

  it("says why for an oscillation in its own words", () => {
    const d = churnDecision(
      { kind: "oscillation", paths: ["a.ts"], rounds: [1, 2, 3] },
      "999",
      3,
      4,
    );
    expect(checkParkedDecision(d, "structural-churn")).toEqual([]);
    expect(d.call.why).toContain("earlier round had replaced");
  });

  it("stays under the byte limit with many long paths", () => {
    const paths = Array.from(
      { length: 200 },
      (_, i) => `${"deep/".repeat(90)}file-${i}.ts`,
    );
    const d = churnDecision(
      {
        kind: "same-file",
        paths,
        rounds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      },
      "999",
      12,
      12,
    );
    expect(checkParkedDecision(d, "structural-churn")).toEqual([]);
    expect(
      new TextEncoder().encode(JSON.stringify(d)).length,
    ).toBeLessThanOrEqual(DECISION_BYTE_LIMIT);
    expect(d.call.question).toMatch(/and \d+ more/);
  });

  it("keys the park by its round", () => {
    expect(churnKey(6)).toBe("structural-churn-r6");
  });
});

describe("the stored state", () => {
  const withRounds = (
    paths: RoundPaths[],
    extra: Partial<DriveState> = {},
  ) => ({
    ...freshState(999),
    rounds: 6,
    roundPaths: paths,
    ...extra,
  });

  it("still loads a state written without the brake's fields", () => {
    expect(isUsableState(withRounds([round(1, ["a.ts"])]), 999)).toBe(true);
  });

  it("loads the per-round facts and the acknowledgment", () => {
    expect(
      isUsableState(withRounds(churning(1, 4), { churnAckRound: 4 }), 999),
    ).toBe(true);
  });

  it("refuses malformed facts and acknowledgments", () => {
    const bad: Array<Record<string, unknown>> = [
      { severe: "yes" },
      { blobs: ["x"] },
      { blobs: { "a.ts": "not-a-blob" } },
      { blobs: { "other.ts": blob(1) } },
    ];
    for (const facts of bad)
      expect(
        isUsableState(
          withRounds([{ ...round(1, ["a.ts"]), ...facts } as RoundPaths]),
          999,
        ),
      ).toBe(false);
    for (const churnAckRound of [-1, 1.5, 7])
      expect(isUsableState(withRounds([], { churnAckRound }), 999)).toBe(false);
  });

  it("folds a round's facts, keeping blobs only for its paths", () => {
    expect(
      foldRoundPaths([], 1, ["a.ts", "a.ts"], 0, {
        severe: false,
        blobs: { "a.ts": blob(1), "z.ts": blob(2), "b.ts": "bad" },
      }),
    ).toEqual([
      { round: 1, paths: ["a.ts"], severe: false, blobs: { "a.ts": blob(1) } },
    ]);
    expect(foldRoundPaths([], 1, ["a.ts"])).toEqual([
      { round: 1, paths: ["a.ts"] },
    ]);
  });
});

describe("churnRoundsSetting", () => {
  const read = (value?: string) =>
    churnRoundsSetting({ DRIVE_PR_CHURN_ROUNDS: value });

  it("defaults to 4 and takes 0 or 2 to 12 from the environment", () => {
    expect(read()).toEqual({ ok: true, value: 4 });
    for (const n of [0, 2, 12])
      expect(read(String(n))).toEqual({ ok: true, value: n });
  });

  it("refuses any other value rather than turning the brake off", () => {
    for (const raw of ["1", "13", "-1", "four", "2.5"]) {
      const r = read(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.code).toBe("churn-rounds-invalid");
    }
  });
});

describe("parseRoundInput", () => {
  const input = (value: unknown) => parseRoundInput(JSON.stringify(value));

  it("reads paths, severity and blobs", () => {
    expect(
      input({ paths: ["a.ts"], severe: false, blobs: { "a.ts": blob(1) } }),
    ).toEqual({
      paths: ["a.ts"],
      facts: { severe: false, blobs: { "a.ts": blob(1) } },
    });
  });

  it("refuses a blob that is not an object id or names a path not recorded", () => {
    for (const blobs of [{ "a.ts": "not-a-blob" }, { "z.ts": blob(1) }]) {
      const r = input({ paths: ["a.ts"], blobs });
      expect("problem" in r).toBe(true);
    }
  });
});
