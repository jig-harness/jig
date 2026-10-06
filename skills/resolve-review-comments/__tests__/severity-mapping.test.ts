/**
 * severity-mapping.test.ts — the ONE severity mapping (TASK-7492).
 *
 * Severity vocabularies coexist in this repo (reviewer
 * `low|medium|high|blocker`, /epic-acceptance-review's `Minor|Major|Blocker`,
 * and Linear's priority field). `.config/review-triage.yaml`'s
 * `severity_mapping` block publishes the correspondence once; this file is
 * what makes "once" true rather than aspirational.
 *
 * It gates:
 *
 *   1. The shipped file HAS the block. `loadLadder` deliberately treats an
 *      absent `severity_mapping` as `null` rather than a config error (see
 *      `LadderConfig.severityMapping`), so nothing else in the repo notices
 *      if it is deleted. This does.
 *   2. `defer-batch.ts`'s executable `SEVERITY_TO_PRIORITY` agrees with it,
 *      token for token. That map stays hand-written — its VALUES have no
 *      derivable relationship to severity tokens — so agreement is a thing to
 *      check, not a thing to assume.
 *   3. The acceptance -> priority direction the acceptance skill quotes is the
 *      DERIVED one (`acceptancePriority`), not a third hand-kept table.
 */

import { describe, expect, it } from "bun:test";
import { SEVERITY_TO_PRIORITY } from "../scripts/defer-batch.ts";
import {
  ACCEPTANCE_TIERS,
  acceptancePriority,
  CANONICAL_SEVERITIES,
  defaultConfigPath,
  type LadderConfig,
  loadLadder,
  SEVERITY_UNKNOWN,
  type SeverityMapping,
  validateLadder,
} from "../scripts/lib/ladder.ts";

async function shippedMapping(): Promise<SeverityMapping> {
  const loaded = await loadLadder(defaultConfigPath());
  expect(loaded.anomaly).toBe("");
  const mapping = loaded.config?.severityMapping ?? null;
  if (mapping === null) {
    throw new Error(
      ".config/review-triage.yaml carries no `severity_mapping` block — the published mapping is the only thing binding the reviewer, acceptance and Linear-priority vocabularies together (TASK-7492)",
    );
  }
  return mapping;
}

/** The shipped config with one surgical edit, re-validated. */
async function mutated(
  edit: (doc: Record<string, unknown>) => void,
): Promise<() => LadderConfig> {
  const { readFileSync } = await import("node:fs");
  const { load } = await import("js-yaml");
  const doc = load(readFileSync(defaultConfigPath(), "utf8")) as Record<
    string,
    unknown
  >;
  edit(doc);
  return () => validateLadder(doc);
}

describe("the shipped severity_mapping", () => {
  it("exists and covers exactly the severity vocabulary plus unknown", async () => {
    const mapping = await shippedMapping();
    expect(Object.keys(mapping).sort()).toEqual(
      [...CANONICAL_SEVERITIES, SEVERITY_UNKNOWN].sort(),
    );
  });

  it("agrees with defer-batch.ts's SEVERITY_TO_PRIORITY on every token", async () => {
    const mapping = await shippedMapping();
    const published = Object.fromEntries(
      Object.entries(mapping).map(([token, e]) => [token, e.linearPriority]),
    );
    // Whole-object equality, not a per-key loop: a loop over one side's keys
    // passes while the other side carries an extra token nothing checks.
    expect(published).toEqual(SEVERITY_TO_PRIORITY);
  });

  it("gives every ranked severity an acceptance tier, and unknown none", async () => {
    const mapping = await shippedMapping();
    for (const token of CANONICAL_SEVERITIES) {
      const acceptance = mapping[token]?.acceptance;
      // Separate assertions, not one: `toContain` on a nullable would also
      // pass a token that is simply absent from the mapping if `null` ever
      // joined ACCEPTANCE_TIERS. Pin the type first, then membership.
      expect(typeof acceptance).toBe("string");
      expect(ACCEPTANCE_TIERS).toContain(acceptance as string);
    }
    expect(mapping[SEVERITY_UNKNOWN]?.acceptance).toBeNull();
  });

  it("derives the acceptance -> priority direction the acceptance skill uses", async () => {
    const mapping = await shippedMapping();
    // These numbers are what /epic-acceptance-review Phase 5b files a
    // gap at when it has an acceptance tier but no reviewer token. They are
    // asserted here so the skill can cite the derivation instead of restating
    // a table that would drift.
    expect(acceptancePriority(mapping, "Blocker")).toBe(1);
    expect(acceptancePriority(mapping, "Major")).toBe(2);
    expect(acceptancePriority(mapping, "Minor")).toBe(4);
  });
});

describe("severity_mapping validation", () => {
  it("accepts a config with no block at all — absence must not disarm the ladder", async () => {
    const run = await mutated((doc) => {
      delete doc.severity_mapping;
    });
    expect(run().severityMapping).toBeNull();
  });

  it("refuses a row missing from the vocabulary", async () => {
    const run = await mutated((doc) => {
      delete (doc.severity_mapping as Record<string, unknown>).medium;
    });
    expect(run).toThrow(/missing: medium/);
  });

  it("refuses a row the vocabulary does not have", async () => {
    const run = await mutated((doc) => {
      (doc.severity_mapping as Record<string, unknown>).critical = {
        linear_priority: 1,
        acceptance: "Blocker",
      };
    });
    expect(run).toThrow(/unexpected: critical/);
  });

  it("refuses a RANKED severity mapped outside 1-4", async () => {
    const run = await mutated((doc) => {
      (doc.severity_mapping as Record<string, Record<string, unknown>>).low = {
        linear_priority: 5,
        acceptance: "Minor",
      };
    });
    expect(run).toThrow(/linear_priority must be an integer 1-4/);
  });

  it('refuses a RANKED severity mapped to priority 0 — "No priority" is not a rank (round 29)', async () => {
    // Token-aware validation, not a single shared 0-4 range: `0` ("No
    // priority") is legal only for `unknown`. TASK-7491 exists precisely
    // because an unprioritized ranked follow-up is the measured failure
    // this mapping is supposed to prevent, so a ranked severity mapped to
    // 0 must be refused, not silently accepted as in-range.
    const run = await mutated((doc) => {
      (doc.severity_mapping as Record<string, Record<string, unknown>>).low = {
        linear_priority: 0,
        acceptance: "Minor",
      };
    });
    expect(run).toThrow(/linear_priority must be an integer 1-4/);
  });

  it("refuses `unknown` mapped to a nonzero priority — the absence of a severity is never an urgency (round 29)", async () => {
    // The opposite direction of the probe above: `unknown` must be
    // EXACTLY 0, not merely "0 or more" — letting it take priority 1
    // would invent an urgency for a finding nothing ranked at all.
    const run = await mutated((doc) => {
      (
        doc.severity_mapping as Record<string, Record<string, unknown>>
      ).unknown = { linear_priority: 1 };
    });
    expect(run).toThrow(
      /linear_priority must be 0 .* 'unknown' is the absence of a severity, never an urgency/,
    );
  });

  it("refuses an acceptance tier outside the skill's vocabulary", async () => {
    const run = await mutated((doc) => {
      (doc.severity_mapping as Record<string, Record<string, unknown>>).low = {
        linear_priority: 4,
        acceptance: "Cosmetic",
      };
    });
    expect(run).toThrow(/acceptance must be one of Minor, Major, Blocker/);
  });

  it("refuses an acceptance tier on unknown", async () => {
    const run = await mutated((doc) => {
      (
        doc.severity_mapping as Record<string, Record<string, unknown>>
      ).unknown = { linear_priority: 0, acceptance: "Minor" };
    });
    expect(run).toThrow(/must not carry an acceptance tier/);
  });

  it("refuses a stronger severity filed at a less urgent priority", async () => {
    const run = await mutated((doc) => {
      (
        doc.severity_mapping as Record<string, Record<string, unknown>>
      ).blocker = { linear_priority: 4, acceptance: "Blocker" };
    });
    expect(run).toThrow(/not monotonic/);
  });

  it("refuses a stronger severity mapped to a weaker acceptance tier", async () => {
    const run = await mutated((doc) => {
      (
        doc.severity_mapping as Record<string, Record<string, unknown>>
      ).blocker = { linear_priority: 1, acceptance: "Minor" };
    });
    expect(run).toThrow(/not monotonic/);
  });

  it("refuses an unknown key inside a row", async () => {
    const run = await mutated((doc) => {
      (doc.severity_mapping as Record<string, Record<string, unknown>>).low = {
        linear_priority: 4,
        acceptance: "Minor",
        label: "cosmetic",
      };
    });
    expect(run).toThrow(/unknown key\(s\): label/);
  });

  it("refuses a non-numeric linear_priority", async () => {
    const run = await mutated((doc) => {
      (doc.severity_mapping as Record<string, Record<string, unknown>>).low = {
        linear_priority: "4",
        acceptance: "Minor",
      };
    });
    expect(run).toThrow(/linear_priority must be an integer 1-4/);
  });

  it("refuses a ranked severity with no acceptance tier key at all", async () => {
    const run = await mutated((doc) => {
      (doc.severity_mapping as Record<string, Record<string, unknown>>).low = {
        linear_priority: 4,
      };
    });
    expect(run).toThrow(/acceptance must be a string/);
  });

  it("refuses a config that leaves an acceptance tier with no reviewer token behind it (round 25)", async () => {
    // Row coverage is checked severity-token -> row, one-directional. Two
    // severities can both map to the same acceptance tier (non-strict
    // monotonicity permits it) while leaving a STRONGER tier uncarried —
    // `acceptancePriority()` then returns null for it, and
    // /epic-acceptance-review Phase 5b files that gap with no priority at
    // all, the exact failure TASK-7491 exists to prevent.
    const run = await mutated((doc) => {
      const mapping = doc.severity_mapping as Record<
        string,
        Record<string, unknown>
      >;
      (mapping.high as Record<string, unknown>).acceptance = "Major";
      (mapping.blocker as Record<string, unknown>).acceptance = "Major";
    });
    expect(run).toThrow(
      /leaves acceptance tier\(s\) with no reviewer token behind them: Blocker/,
    );
  });
});

describe("acceptancePriority", () => {
  it("returns null for a config with no mapping", () => {
    expect(acceptancePriority(null, "Blocker")).toBeNull();
  });

  it("returns null for a tier no row carries", () => {
    // Hand-built rather than the shipped config: `validateLadder`'s own
    // surjectivity check (added above) now refuses any config that leaves a
    // tier uncarried, so this null-return path is only reachable from a
    // SeverityMapping object built directly, not from a config that passed
    // validation.
    const mapping: SeverityMapping = {
      low: { linearPriority: 4, acceptance: "Minor" },
      unknown: { linearPriority: 0, acceptance: null },
    };
    expect(acceptancePriority(mapping, "Blocker")).toBeNull();
  });
});
