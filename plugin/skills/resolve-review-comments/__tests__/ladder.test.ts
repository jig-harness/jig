/**
 * ladder.test.ts — the escalating decline ladder (TASK-7494).
 *
 * What this covers:
 *
 *   1. The SHIPPED config. `.config/review-triage.yaml` is the single source
 *      for every weight, and nothing else in the repo parses it, so a typo
 *      there sends the ladder permanently (and quietly) inert. These probes
 *      are the census a gate owes its input: assert the parsed population
 *      rather than letting "read nothing" read as "all clear".
 *   2. The mechanism, over PURPOSE-BUILT configs — so the behavioural probes
 *      still mean something after somebody retunes the shipped weights, which
 *      is the whole point of the config.
 *   3. The entry script, spawned, for the fail-open and usage contracts a
 *      caller actually depends on.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  bandFor,
  defaultConfigPath,
  type LadderInput,
  type LoadResult,
  ladderDeclinePatterns,
  loadLadder,
  resolveStance,
  validateLadder,
} from "../scripts/lib/ladder.ts";
import { interpretRoundResult } from "../scripts/triage-ladder.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "triage-ladder.ts");

/** A finding that clears nothing on its own — the decline baseline. */
const PLAIN: LadderInput = {
  round: 5,
  severity: "low",
  category: "style",
  tier: 3,
  selfInflicted: false,
};

async function loadFixture(
  yaml: string,
  /**
   * Overrides the config's FILE NAME — the part of the resolved path a test
   * controls (the parent dir comes from `mkdtempSync`). Used by the
   * render-pass probes to put placeholder-shaped text into the `{config}`
   * value itself.
   */
  fileName = "review-triage.yaml",
): Promise<LoadResult> {
  const dir = mkdtempSync(join(tmpdir(), "ladder-"));
  try {
    const p = join(dir, fileName);
    writeFileSync(p, yaml);
    return await loadLadder(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A minimal, VALID config with one baseline band and one escalated band. Every
 * mechanism probe mutates a copy of this rather than the shipped file.
 */
const FIXTURE = `
version: 1
severity_order: [low, medium, high, blocker]
categories: [correctness, data-integrity, security, style]
fail_open:
  inert_when_unknown: [severity]
bands:
  - id: base
    from_round: 1
    through_round: 3
    minimal_diff: false
    accept_if:
      unconditional: true
  - id: strict
    from_round: 4
    through_round: null
    minimal_diff: true
    accept_if:
      min_severity: high
      categories: [data-integrity, security]
      max_tier: 2
      self_inflicted: true
reply:
  marker: "test ladder"
  wont_fix: >-
    **wont-fix** — {marker} band {band} round {round} sev {severity} cat
    {category} tier {tier} clauses {clauses}

    <!-- {marker} -->
  deferred: >-
    **deferred** — {marker} band {band} round {round}

    <!-- {marker} -->
`;

describe("the shipped .config/review-triage.yaml", () => {
  it("parses and validates", async () => {
    const loaded = await loadLadder(defaultConfigPath());
    expect(loaded.anomaly).toBe("");
    expect(loaded.config).not.toBeNull();
  });

  it("attributes the canonical path to the shipped file", async () => {
    const loaded = await loadLadder(defaultConfigPath());
    expect(loaded.configLabel.endsWith("review-triage.yaml")).toBe(true);
  });

  it("covers every round from 1 upward with no gap and no overlap", async () => {
    const { config } = await loadLadder(defaultConfigPath());
    if (config === null) throw new Error("config did not load");
    // Not a hand-written tally of the bands — walk the rounds and assert each
    // resolves to exactly one band, which is the property that matters.
    expect(config.bands.length).toBeGreaterThan(0);
    for (let round = 1; round <= 40; round++) {
      expect(bandFor(config, round)).not.toBeNull();
    }
    expect(bandFor(config, 0)).toBeNull();
    expect(config.bands.at(-1)?.throughRound).toBeNull();
  });

  it("keeps round 1 unconditional — the Boy Scout row survives untouched", async () => {
    const loaded = await loadLadder(defaultConfigPath());
    const v = resolveStance(loaded, { ...PLAIN, round: 1 }, false);
    expect(v.stance).toBe("accepted");
    expect(v.armed).toBe(true);
    expect(v.minimalDiff).toBe(false);
  });

  it("declines a low/style tier-3 finding past the first escalated band", async () => {
    const loaded = await loadLadder(defaultConfigPath());
    for (const round of [4, 7, 12]) {
      const v = resolveStance(loaded, { ...PLAIN, round }, false);
      expect(v.stance).toBe("declined");
      expect(v.minimalDiff).toBe(true);
      expect(v.reply).toContain("**wont-fix**");
    }
  });

  it("keeps a tier-1 gate defect in the escalated band, and a blocker anywhere", async () => {
    const loaded = await loadLadder(defaultConfigPath());
    const gate = resolveStance(loaded, { ...PLAIN, round: 5, tier: 1 }, false);
    expect(gate.stance).toBe("accepted");
    const blocker = resolveStance(
      loaded,
      { ...PLAIN, round: 20, severity: "blocker" },
      false,
    );
    expect(blocker.stance).toBe("accepted");
  });

  it("keeps a regression on this PR's own line accepted in every armed band", async () => {
    const loaded = await loadLadder(defaultConfigPath());
    for (const round of [5, 9]) {
      const v = resolveStance(
        loaded,
        { ...PLAIN, round, selfInflicted: true },
        false,
      );
      expect(v.stance).toBe("accepted");
      expect(v.admittedBy.join(" ")).toContain("self_inflicted");
    }
  });
});

describe("band selection", () => {
  it("never arms at round 0", async () => {
    const loaded = await loadFixture(FIXTURE);
    const v = resolveStance(loaded, { ...PLAIN, round: 0 }, false);
    expect(v.armed).toBe(false);
    expect(v.stance).toBe("accepted");
    expect(v.anomalies.join(" ")).toContain("round 0");
  });

  it("picks the band whose range contains the round", async () => {
    const { config } = await loadFixture(FIXTURE);
    if (config === null) throw new Error("fixture did not load");
    expect(bandFor(config, 3)?.id).toBe("base");
    expect(bandFor(config, 4)?.id).toBe("strict");
    expect(bandFor(config, 999)?.id).toBe("strict");
  });
});

describe("clause evaluation", () => {
  it("admits on severity at or above the floor", async () => {
    const loaded = await loadFixture(FIXTURE);
    expect(
      resolveStance(loaded, { ...PLAIN, severity: "high" }, false).stance,
    ).toBe("accepted");
    expect(
      resolveStance(loaded, { ...PLAIN, severity: "medium" }, false).stance,
    ).toBe("declined");
  });

  it("admits on category membership", async () => {
    const loaded = await loadFixture(FIXTURE);
    expect(
      resolveStance(loaded, { ...PLAIN, category: "security" }, false).stance,
    ).toBe("accepted");
    expect(
      resolveStance(loaded, { ...PLAIN, category: "correctness" }, false)
        .stance,
    ).toBe("declined");
  });

  it("admits on tier at or below the cap", async () => {
    const loaded = await loadFixture(FIXTURE);
    expect(resolveStance(loaded, { ...PLAIN, tier: 2 }, false).stance).toBe(
      "accepted",
    );
    expect(resolveStance(loaded, { ...PLAIN, tier: 3 }, false).stance).toBe(
      "declined",
    );
  });

  it("admits on self_inflicted true, and never on measured false", async () => {
    const loaded = await loadFixture(FIXTURE);
    expect(
      resolveStance(loaded, { ...PLAIN, selfInflicted: true }, false).stance,
    ).toBe("accepted");
    // A measured `false` must NOT admit — the equality-match bug this clause
    // used to have would treat `self_inflicted: true` in config as matching
    // every finding measured non-self-inflicted, which is the opposite of
    // what the clause is for.
    expect(
      resolveStance(loaded, { ...PLAIN, selfInflicted: false }, false).stance,
    ).toBe("declined");
  });

  it("picks the deferred macro for obligatory work", async () => {
    const loaded = await loadFixture(FIXTURE);
    const v = resolveStance(loaded, PLAIN, true);
    expect(v.stance).toBe("declined");
    expect(v.reply?.startsWith("**deferred**")).toBe(true);
  });

  it("interpolates the marker and the band into the reply", async () => {
    const loaded = await loadFixture(FIXTURE);
    const v = resolveStance(loaded, PLAIN, false);
    expect(v.reply).toContain("test ladder");
    expect(v.reply).toContain("band strict");
    expect(v.reply).toContain("round 5");
    expect(v.reply).not.toContain("{");
  });

  // A checked-out fixture is never the canonical file, so the verdict's own
  // `config` field — what a real template's `{config}` placeholder
  // interpolates, per the shipped config's `reply.wont_fix`/`reply.deferred`
  // — must attribute the fixture's own path. Attributing the canonical
  // `.config/review-triage.yaml` here would credit weights the fixture, not
  // the shipped file, actually decided.
  it("attributes an override config to its own path, not the canonical one", async () => {
    const loaded = await loadFixture(FIXTURE);
    expect(loaded.configLabel).not.toBe(".config/review-triage.yaml");
    expect(loaded.configLabel.endsWith("review-triage.yaml")).toBe(true);
    const v = resolveStance(loaded, PLAIN, false);
    expect(v.config).toBe(loaded.configLabel);
  });

  // `render()` used to substitute one placeholder per pass, so text a value
  // INSERTED was re-read as template syntax by every later pass. `{config}` is
  // the reachable vector: its value is an operator-supplied path.
  //
  // The fixture path is built by `loadFixture` from `mkdtempSync`, so these
  // write the placeholder-shaped segment into the config's own FILE NAME —
  // the part of the label this test controls. FIXTURE's own templates omit
  // `{config}` (they predate this probe), so these use a variant that
  // interpolates it — otherwise the value under test never reaches the reply
  // and the assertion would pass vacuously.
  const CONFIG_FIXTURE = FIXTURE.replace(
    "**wont-fix** — {marker} band",
    "**wont-fix** — {marker} cfg {config} band",
  );

  it("never re-reads a value it just substituted as more template syntax", async () => {
    // `{round}` inside the config path: a second pass would rewrite it to the
    // finding's round (5), misattributing the decline to a file that does not
    // exist.
    const loaded = await loadFixture(
      CONFIG_FIXTURE,
      "a{round}b-review-triage.yaml",
    );
    const v = resolveStance(loaded, PLAIN, false);
    expect(v.stance).toBe("declined");
    expect(v.reply).toContain("a{round}b-review-triage.yaml");
    // The literal `5` must appear only as the ROUND, never as a rewrite of the
    // path's own `{round}`.
    expect(v.reply).not.toContain("a5b-review-triage.yaml");
  });

  it("does not let an unknown brace token in the config path make a valid decline inert", async () => {
    // `{trial}` is not a TEMPLATE_PLACEHOLDER, so a multi-pass render left it
    // in place and `resolveStance`'s leftover-placeholder guard then refused
    // to post — turning a VALID decline into a silent accept.
    const loaded = await loadFixture(
      CONFIG_FIXTURE,
      "a{trial}b-review-triage.yaml",
    );
    const v = resolveStance(loaded, PLAIN, false);
    expect(v.stance).toBe("declined");
    expect(v.reply).toContain("a{trial}b-review-triage.yaml");
    expect(v.anomalies.join(" ")).not.toContain("unrendered");
  });

  it("treats `$&` in a substituted value as a literal, not replacement syntax", async () => {
    // A string replacement expands `$&`/`$1`; a function replacer does not.
    const loaded = await loadFixture(CONFIG_FIXTURE, "a$&b-review-triage.yaml");
    const v = resolveStance(loaded, PLAIN, false);
    expect(v.reply).toContain("a$&b-review-triage.yaml");
  });
});

describe("ladderDeclinePatterns — boundary-aware match, not a bare marker substring", () => {
  async function loadPatterns(
    yaml: string,
  ): ReturnType<typeof ladderDeclinePatterns> {
    const dir = mkdtempSync(join(tmpdir(), "ladder-patterns-"));
    try {
      const p = join(dir, "review-triage.yaml");
      writeFileSync(p, yaml);
      return await ladderDeclinePatterns(p);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("matches an actual ladder-generated wont-fix reply", async () => {
    const loaded = await loadFixture(FIXTURE);
    const v = resolveStance(loaded, PLAIN, false);
    const { patterns } = await loadPatterns(FIXTURE);
    expect(patterns).not.toBeNull();
    expect(patterns?.some((p) => p.test(v.reply ?? ""))).toBe(true);
  });

  it("matches an actual ladder-generated deferred reply", async () => {
    const loaded = await loadFixture(FIXTURE);
    const v = resolveStance(loaded, PLAIN, true);
    const { patterns } = await loadPatterns(FIXTURE);
    expect(patterns?.some((p) => p.test(v.reply ?? ""))).toBe(true);
  });

  it("does NOT match ordinary prose that merely mentions the marker", async () => {
    const { patterns } = await loadPatterns(FIXTURE);
    // Contains the marker substring "test ladder", exactly what the old
    // `.includes(marker)` check matched on — but not in the template's own
    // shape, so a boundary-aware match must reject it.
    const decoy =
      "**wont-fix** — this predates the test ladder, unrelated to any band.";
    expect(patterns?.some((p) => p.test(decoy))).toBe(false);
  });

  // The gap this closes: `defect-escape.ts --ladder-only` tests a pattern
  // against the COMPLETE settled reply, not just the reply's opening line.
  // An unanchored pattern therefore matches an ordinary, non-ladder decline
  // that merely embeds a ladder-shaped example LATER in its body — exactly
  // the false positive that contaminates the `--ladder-only` calibration
  // sample with declines the ladder never made. The earlier decoy test above
  // only exercised a BARE marker mention and could not catch this.
  it("does NOT match a decline that embeds a ladder-shaped example later in its body", async () => {
    const { patterns } = await loadPatterns(FIXTURE);
    // The template's own literal skeleton ("**wont-fix** — test ladder band
    // ... round ... sev ... cat ... tier ... clauses ...") appears verbatim,
    // but only AFTER unrelated preamble — an unanchored pattern matches this
    // regardless of position; only an anchored one requires it to start the
    // reply.
    const decoy =
      "**wont-fix** — unrelated rationale, nothing to do with the ladder. " +
      "Example generated response: **wont-fix** — test ladder band base " +
      "round 1 sev low cat style tier 3 clauses none";
    expect(patterns?.some((p) => p.test(decoy))).toBe(false);
  });

  // The gap: matching the whole rendered template tied every match to
  // the templates' own prose, so rewording `wont_fix`/`deferred` — with
  // `reply.marker` unchanged — silently orphaned every reply already posted
  // under the old wording, contradicting the config's own documented
  // contract that only changing the marker does that.
  it("still matches a reply generated under an EARLIER, reworded template — only the marker line matters", async () => {
    const reworded = FIXTURE.replace(
      "**wont-fix** — {marker} band {band} round {round} sev {severity} cat\n    {category} tier {tier} clauses {clauses}",
      "**wont-fix** — completely different wording for the same decline, {marker} says so, band {band}",
    );
    expect(reworded).not.toBe(FIXTURE);
    const historicalReply =
      "**wont-fix** — test ladder band base round 1 sev low cat style tier 3 clauses none\n\n<!-- test ladder -->";
    const { patterns } = await loadPatterns(reworded);
    expect(patterns?.some((p) => p.test(historicalReply))).toBe(true);
  });

  // Changing the marker itself is the ONE thing the config documents as
  // orphaning the sample — still true under the new mechanism.
  it("does NOT match a reply carrying a DIFFERENT marker", async () => {
    const retitled = FIXTURE.replace(
      'marker: "test ladder"',
      'marker: "renamed ladder"',
    );
    const historicalReply =
      "**wont-fix** — test ladder band base round 1 sev low cat style tier 3 clauses none\n\n<!-- test ladder -->";
    const { patterns } = await loadPatterns(retitled);
    expect(patterns?.some((p) => p.test(historicalReply))).toBe(false);
  });

  // Targets the new mechanism's own decision boundary — the earlier decoys
  // above lack HTML-comment syntax entirely and would pass vacuously against
  // almost any comment-based implementation (a decoy must exercise what
  // actually distinguishes the two behaviours). Here the marker comment IS
  // present, but mid-body rather than as the reply's own trailing line —
  // quoting a real ladder reply as an illustrative example, the same shape
  // `hasLeaveOpenMarker` defends against for its own marker.
  it("does NOT match a marker comment quoted mid-body rather than as the trailing line", async () => {
    const { patterns } = await loadPatterns(FIXTURE);
    const decoy =
      "For reference, a real ladder decline reads:\n\n" +
      "**wont-fix** — test ladder band base round 1 sev low cat style tier 3 clauses none\n\n" +
      "<!-- test ladder -->\n\n" +
      "This one is different and was not declined by the ladder.";
    expect(patterns?.some((p) => p.test(decoy))).toBe(false);
  });

  it("fails closed (null patterns) on an unresolvable config", async () => {
    const { patterns, marker, anomaly } = await ladderDeclinePatterns(
      join(tmpdir(), "no-such-review-triage-patterns.yaml"),
    );
    expect(patterns).toBeNull();
    expect(marker).toBeNull();
    expect(anomaly).not.toBe("");
  });
});

describe("fail-open polarity", () => {
  it("goes inert on an unknown input listed in inert_when_unknown", async () => {
    const loaded = await loadFixture(FIXTURE);
    const v = resolveStance(loaded, { ...PLAIN, severity: "unknown" }, false);
    expect(v.armed).toBe(false);
    expect(v.stance).toBe("accepted");
    expect(v.anomalies.join(" ")).toContain("severity is unknown");
  });

  it("merely abstains on an unknown input NOT listed — a clause can only admit", async () => {
    const loaded = await loadFixture(FIXTURE);
    const v = resolveStance(loaded, { ...PLAIN, category: "unknown" }, false);
    expect(v.armed).toBe(true);
    expect(v.stance).toBe("declined");
    expect(v.abstained.join(" ")).toContain("categories");
    // …and the same finding is still rescued by any OTHER clause, which is
    // what makes an unreadable category safe to ignore rather than fatal.
    expect(
      resolveStance(loaded, { ...PLAIN, category: "unknown", tier: 1 }, false)
        .stance,
    ).toBe("accepted");
  });

  it("treats an unmeasured self-inflicted anchor as null, not false, and says so", async () => {
    const loaded = await loadFixture(FIXTURE);
    const v = resolveStance(loaded, { ...PLAIN, selfInflicted: null }, false);
    expect(v.stance).toBe("declined");
    expect(v.abstained.join(" ")).toContain("self_inflicted");
    expect(v.anomalies.join(" ")).toContain("self-inflicted was not measured");
  });

  // The gap this closes: `self_inflicted` is one of `strict`'s disjunctive
  // accept_if clauses specifically to keep a regression from this PR's own
  // earlier round accepted — the exact case an UNMEASURED anchor cannot rule
  // out. Left merely abstaining (the test above), a low-severity, out-of-
  // vocabulary-category, high-tier finding with no other admitting clause
  // fell through to a decline anyway, contradicting the ladder's own
  // documented "fails open in every uncertain case".
  it("goes inert — not declined — on an unmeasured self-inflicted anchor when self_inflicted is listed in inert_when_unknown", async () => {
    const loaded = await loadFixture(
      FIXTURE.replace(
        "inert_when_unknown: [severity]",
        "inert_when_unknown: [severity, self_inflicted]",
      ),
    );
    const v = resolveStance(loaded, { ...PLAIN, selfInflicted: null }, false);
    expect(v.armed).toBe(false);
    expect(v.stance).toBe("accepted");
    expect(v.anomalies.join(" ")).toContain("self_inflicted is unknown");
  });

  it("the shipped config lists self_inflicted in inert_when_unknown", async () => {
    const loaded = await loadLadder(defaultConfigPath());
    if (loaded.config === null) throw new Error("shipped config did not load");
    expect(loaded.config.inertWhenUnknown).toContain("self_inflicted");
  });

  it("goes inert — never declines — on a config it cannot read", async () => {
    const v = resolveStance(
      { config: null, anomaly: "no such file", configLabel: "" },
      PLAIN,
      false,
    );
    expect(v.armed).toBe(false);
    expect(v.stance).toBe("accepted");
    expect(v.reply).toBeNull();
    expect(v.anomalies.join(" ")).toContain("no such file");
  });

  it("goes inert on a config it cannot parse", async () => {
    const loaded = await loadFixture("version: 1\n  bands: [\n");
    expect(loaded.config).toBeNull();
    expect(resolveStance(loaded, PLAIN, false).stance).toBe("accepted");
  });

  it("refuses to post — goes inert — if a template somehow still leaves a placeholder after render", async () => {
    // assertKnownPlaceholders (config-load time) makes this unreachable through
    // the public loader; this exercises resolveStance's own defense-in-depth
    // directly, on a hand-built config that bypasses validateLadder.
    const loaded = await loadFixture(FIXTURE);
    if (loaded.config === null) throw new Error("fixture did not load");
    const tampered = {
      ...loaded.config,
      wontFixTemplate: "**wont-fix** — {marker} {bogus}",
    };
    const v = resolveStance(
      { config: tampered, anomaly: "", configLabel: "" },
      PLAIN,
      false,
    );
    expect(v.stance).toBe("accepted");
    expect(v.reply).toBeNull();
    expect(v.anomalies.join(" ")).toContain("{bogus}");
  });

  it("catches a leftover placeholder using a digit or hyphen too", async () => {
    // Same bypass path as above, with a leftover shape the old
    // `[a-zA-Z_]+` guard would not have recognised as placeholder-shaped at
    // all — it would have posted the literal `{min-severity}` verbatim.
    const loaded = await loadFixture(FIXTURE);
    if (loaded.config === null) throw new Error("fixture did not load");
    const tampered = {
      ...loaded.config,
      wontFixTemplate: "**wont-fix** — {marker} {min-severity}",
    };
    const v = resolveStance(
      { config: tampered, anomaly: "", configLabel: "" },
      PLAIN,
      false,
    );
    expect(v.stance).toBe("accepted");
    expect(v.reply).toBeNull();
    expect(v.anomalies.join(" ")).toContain("{min-severity}");
  });

  it("refuses to post — goes inert — if the rendered rationale has no letter or digit even though the raw template does", async () => {
    // asTemplate (config-load time) validates the RAW template text, and
    // `{marker}` itself contains letters — so `wont_fix: "**wont-fix**
    // {marker}"` passes that check regardless of what `reply.marker` renders
    // to. A marker of plain punctuation (`"---"`, not placeholder-shaped, so
    // it clears reply.marker's own guard too) renders a rationale with no
    // letter or digit in it, which validateOutcomeBody rejects at POST time —
    // this bypasses the public loader to exercise resolveStance's render-time
    // re-check directly, the same way the leftover-placeholder tests above do.
    const loaded = await loadFixture(FIXTURE);
    if (loaded.config === null) throw new Error("fixture did not load");
    const tampered = {
      ...loaded.config,
      marker: "---",
      wontFixTemplate: "**wont-fix** {marker}",
    };
    const v = resolveStance(
      { config: tampered, anomaly: "", configLabel: "" },
      PLAIN,
      false,
    );
    expect(v.stance).toBe("accepted");
    expect(v.reply).toBeNull();
    expect(v.anomalies.join(" ")).toContain("outcome-reply grammar");
  });
});

describe("config validation refuses what would invert the polarity", () => {
  // Mutations are applied to the YAML TEXT and re-parsed with the SAME parser
  // the loader uses — not to a hand-built object literal, which could satisfy
  // the validator in a shape the real file can never take.
  const bad = (mutate: (s: string) => string): (() => unknown) => {
    return () => validateLadder(loadYaml(mutate(FIXTURE)));
  };

  it("refuses a band with no accept clause — it would decline everything", () => {
    expect(
      bad((s) =>
        s.replace(
          "    accept_if:\n      unconditional: true",
          "    accept_if: {}",
        ),
      ),
    ).toThrow(/declares no clause/);
  });

  it("refuses a gap between bands", () => {
    expect(bad((s) => s.replace("from_round: 4", "from_round: 6"))).toThrow(
      /rounds must resume at 4/,
    );
  });

  it("refuses two bands sharing the same id — both would be indistinguishable in a reply", () => {
    expect(bad((s) => s.replace("  - id: strict", "  - id: base"))).toThrow(
      /bands\[\]\.id must be unique — 'base' is used by more than one band/,
    );
  });

  // The gap this closes: `band.id` is substituted into every decline reply
  // via `{band}`. A placeholder-shaped id (e.g. `{round}`) reappears in the
  // rendered text looking like an unrendered placeholder, and — worse — a
  // SEQUENTIAL substitution order means the later `{round}` substitution
  // then overwrites the id's own text with the round ordinal, misattributing
  // the decision to the wrong band. Same check, and same reason, as
  // `reply.marker` below.
  it("refuses a band id shaped like a placeholder", () => {
    expect(
      bad((s) => s.replace("  - id: strict", '  - id: "{round}"')),
    ).toThrow(/must not contain placeholder-shaped text/);
  });

  it("accepts a band id containing a brace that is not placeholder-shaped", () => {
    // A stray, unpaired brace is not a leftover-placeholder risk — only a
    // full `{...}` pair is, exactly like the marker check below.
    expect(
      bad((s) => s.replace("  - id: strict", '  - id: "strict}"')),
    ).not.toThrow();
  });

  it("refuses a whitespace-only band id", () => {
    // A bare `id === ''` check let `id: "   "` through, interpolating an
    // apparently blank band name into decline replies — the marker and
    // category validators already trim before checking non-emptiness.
    expect(bad((s) => s.replace("  - id: strict", '  - id: "   "'))).toThrow(
      /bands\[\d+\]\.id must be a non-empty string/,
    );
  });

  it("refuses a last band that is not open-ended", () => {
    expect(
      bad((s) =>
        s.replace(
          "    from_round: 4\n    through_round: null",
          "    from_round: 4\n    through_round: 9",
        ),
      ),
    ).toThrow(/must be open-ended/);
  });

  it("refuses a severity floor outside severity_order", () => {
    expect(
      bad((s) => s.replace("min_severity: high", "min_severity: urgent")),
    ).toThrow(/not in severity_order/);
  });

  it("refuses a category outside the vocabulary", () => {
    expect(
      bad((s) =>
        s.replace(
          "categories: [data-integrity, security]",
          "categories: [flakiness]",
        ),
      ),
    ).toThrow(/not in the categories vocabulary/);
  });

  // A padded token parses fine but never equals the clean value a real
  // caller passes (`--category security`), so a padded `categories:` entry
  // silently creates an unusable vocabulary member instead of failing at
  // config-load time.
  it("refuses a top-level category padded with whitespace", () => {
    expect(
      bad((s) =>
        s.replace(
          "categories: [correctness, data-integrity, security, style]",
          'categories: [correctness, data-integrity, " security", style]',
        ),
      ),
    ).toThrow(/must not contain leading\/trailing whitespace/);
  });

  it("refuses a padded severity_order entry", () => {
    expect(
      bad((s) =>
        s.replace(
          "severity_order: [low, medium, high, blocker]",
          'severity_order: [low, medium, "high ", blocker]',
        ),
      ),
    ).toThrow(/must not contain leading\/trailing whitespace/);
  });

  // Same defect class as the band-id and marker checks above: a category is
  // substituted into a declined reply via `{category}`, and a
  // placeholder-shaped category (e.g. `{tier}`) reappears in the rendered
  // text looking like an unrendered placeholder — the later `{tier}`
  // substitution then overwrites it with the numeric tier, corrupting the
  // audit trail instead of failing open.
  it("refuses a top-level category shaped like a placeholder", () => {
    expect(
      bad((s) =>
        s.replace(
          "categories: [correctness, data-integrity, security, style]",
          'categories: [correctness, data-integrity, security, style, "{tier}"]',
        ),
      ),
    ).toThrow(/must not contain placeholder-shaped text/);
  });

  it("refuses a max_tier above the tier domain — it would admit every possible tier", () => {
    expect(bad((s) => s.replace("max_tier: 2", "max_tier: 5"))).toThrow(
      /max_tier must be an integer 1-4/,
    );
  });

  it("refuses a max_tier below the tier domain", () => {
    expect(bad((s) => s.replace("max_tier: 2", "max_tier: 0"))).toThrow(
      /max_tier must be an integer 1-4/,
    );
  });

  it("refuses a marker containing placeholder-shaped text", () => {
    expect(
      bad((s) => s.replace('marker: "test ladder"', 'marker: "{bogus}"')),
    ).toThrow(/must not contain placeholder-shaped text/);
  });

  it("accepts a marker containing a brace that is not placeholder-shaped", () => {
    // A lone `}` with no matching `{` is not the shape that defeats the
    // leftover-placeholder guard — only a full `{...}` pair is.
    const loaded = loadYaml(
      FIXTURE.replace('marker: "test ladder"', 'marker: "test } ladder"'),
    );
    expect(() => validateLadder(loaded)).not.toThrow();
  });

  it("refuses a marker shaped like a placeholder with a hyphen or digit", () => {
    // The placeholder shape is ANY brace-delimited content, not just
    // `[a-zA-Z_]+` — a charset restricted to that would miss exactly these.
    expect(
      bad((s) =>
        s.replace('marker: "test ladder"', 'marker: "{min-severity}"'),
      ),
    ).toThrow(/must not contain placeholder-shaped text/);
    expect(
      bad((s) => s.replace('marker: "test ladder"', 'marker: "{round2}"')),
    ).toThrow(/must not contain placeholder-shaped text/);
  });

  it("refuses accept_if.self_inflicted: false rather than equality-matching it", () => {
    // `false` here would otherwise admit every finding MEASURED as
    // not-self-inflicted — the opposite of what a maintainer following the
    // shipped config's own comment ("set it to false to get the literal spec
    // back") would expect. There is no meaningful "admit when NOT
    // self-inflicted" clause, so it is presence-only, like `unconditional`.
    expect(
      bad((s) => s.replace("self_inflicted: true", "self_inflicted: false")),
    ).toThrow(/self_inflicted must be true or absent/);
  });

  it("refuses severity_order missing a canonical token", () => {
    expect(
      bad((s) =>
        s.replace(
          "severity_order: [low, medium, high, blocker]",
          "severity_order: [low, medium, hi, blocker]",
        ),
      ),
    ).toThrow(/severity_order must be exactly/);
  });

  it("refuses severity_order with the canonical tokens out of order", () => {
    // Same set as CANONICAL_SEVERITIES, but not weakest-first — a
    // permutation-only check would pass this, yet resolveStance's
    // `severityOrder.indexOf(severity) >= severityOrder.indexOf(minSeverity)`
    // comparison would then invert which findings a `min_severity` clause
    // admits: with this reversed order, `min_severity: high` would admit
    // `medium`/`low` and decline `blocker`.
    expect(
      bad((s) =>
        s.replace(
          "severity_order: [low, medium, high, blocker]",
          "severity_order: [blocker, high, medium, low]",
        ),
      ),
    ).toThrow(
      /severity_order must be exactly \[low, medium, high, blocker\], weakest first/,
    );
  });

  it("refuses severity_order with a duplicate token", () => {
    expect(
      bad((s) =>
        s.replace(
          "severity_order: [low, medium, high, blocker]",
          "severity_order: [low, low, medium, high, blocker]",
        ),
      ),
    ).toThrow(/duplicate token/);
  });

  it("refuses an unknown top-level key", () => {
    expect(
      bad((s) => s.replace("version: 1", "version: 1\nbogus: true")),
    ).toThrow(/unknown key\(s\): bogus/);
  });

  it("allows the documentation-only `calibration` top-level key", async () => {
    const loaded = await loadFixture(
      `${FIXTURE}\ncalibration:\n  cadence: monthly\n`,
    );
    expect(loaded.anomaly).toBe("");
    expect(loaded.config).not.toBeNull();
  });

  it("refuses an unknown fail_open key", () => {
    expect(
      bad((s) =>
        s.replace(
          "fail_open:\n  inert_when_unknown: [severity]",
          "fail_open:\n  inert_when_unknown: [severity]\n  bogus: true",
        ),
      ),
    ).toThrow(/unknown key\(s\): bogus/);
  });

  it("accepts self_inflicted as an inert_when_unknown token", async () => {
    const loaded = await loadFixture(
      FIXTURE.replace(
        "inert_when_unknown: [severity]",
        "inert_when_unknown: [severity, self_inflicted]",
      ),
    );
    expect(loaded.anomaly).toBe("");
    expect(loaded.config?.inertWhenUnknown).toEqual([
      "severity",
      "self_inflicted",
    ]);
  });

  it("still refuses an out-of-vocabulary inert_when_unknown token", () => {
    expect(
      bad((s) =>
        s.replace(
          "inert_when_unknown: [severity]",
          "inert_when_unknown: [severity, bogus]",
        ),
      ),
    ).toThrow(/inert_when_unknown must be a list drawn from/);
  });

  it("refuses an unknown band-level key", () => {
    expect(
      bad((s) => s.replace("  - id: base", "  - id: base\n    bogus: true")),
    ).toThrow(/bands\[0\] has unknown key\(s\): bogus/);
  });

  it("refuses an unknown accept_if key — a typo like min_severty does not silently vanish", () => {
    expect(
      bad((s) =>
        s.replace(
          "min_severity: high",
          "min_severity: high\n      min_severty: high",
        ),
      ),
    ).toThrow(/accept_if has unknown key\(s\): min_severty/);
  });

  it("refuses a reply template referencing an unknown placeholder", () => {
    expect(
      bad((s) => s.replace("sev {severity}", "sev {severity} {severity_typo}")),
    ).toThrow(/unknown placeholder \{severity_typo\}/);
  });

  it("refuses a reply template placeholder using a digit, hyphen, or space", () => {
    // Same finding as the marker test above: the shape is ANY brace-delimited
    // content, so a typo outside the old `[a-zA-Z_]+` charset is still caught.
    expect(
      bad((s) => s.replace("sev {severity}", "sev {severity} {round2}")),
    ).toThrow(/unknown placeholder \{round2\}/);
    expect(
      bad((s) => s.replace("sev {severity}", "sev {severity} {min-severity}")),
    ).toThrow(/unknown placeholder \{min-severity\}/);
    expect(
      bad((s) => s.replace("sev {severity}", "sev {severity} {min severity}")),
    ).toThrow(/unknown placeholder \{min severity\}/);
  });

  it("refuses a reply macro missing its trailing marker line — the calibration sample would be unfindable", () => {
    // Removing the {marker} mention from the PROSE alone is no longer enough
    // to break this: `ladderDeclinePatterns` matches on the trailing
    // `<!-- {marker} -->` line alone, so validation checks that line
    // specifically rather than "{marker} appears somewhere".
    expect(
      bad((s) =>
        s.replace("**wont-fix** — {marker} band", "**wont-fix** — band"),
      ),
    ).not.toThrow();
    expect(bad((s) => s.replace("\n\n    <!-- {marker} -->", ""))).toThrow(
      /must end with its own `<!-- \{marker\} -->` line/,
    );
  });

  it("refuses a macro that does not open with its outcome token", () => {
    expect(
      bad((s) => s.replace("**wont-fix** — {marker}", "declined: {marker}")),
    ).toThrow(/must open with \*\*wont-fix\*\*/);
  });
});

describe("interpretRoundResult", () => {
  it("reads a clean success as the printed ordinal with no anomaly", () => {
    const [round, why] = interpretRoundResult({
      code: 0,
      stdout: "4\n",
      stderr: "",
      timedOut: false,
    });
    expect(round).toBe(4);
    expect(why).toBe("");
  });

  it("forces round 0 and names the reason on a nonzero exit", () => {
    const [round, why] = interpretRoundResult({
      code: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
    expect(round).toBe(0);
    expect(why).toContain("exited 1");
    expect(why).toContain("reading round 0");
  });

  it("forces round 0 and names the timeout on a timed-out call", () => {
    const [round, why] = interpretRoundResult({
      code: 124,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    expect(round).toBe(0);
    expect(why).toContain("timed out");
  });

  it("forces round 0 when stdout is not a bare ordinal, even on exit 0", () => {
    const [round, why] = interpretRoundResult({
      code: 0,
      stdout: "not-a-number",
      stderr: "",
      timedOut: false,
    });
    expect(round).toBe(0);
    expect(why).toContain("not an ordinal");
  });

  // The defect this whole function exists to close: current-round.ts can
  // exit 0 with a genuine ordinal (it takes the max of two counters) while
  // reporting on stderr that ONE of those counters was corrupt or
  // unreadable. A wrapper that only looked at stderr after a nonzero exit
  // never saw this, so a real ordinal from the other counter could arm the
  // ladder and decline a finding with no trace of the unreadable state.
  it("relays a successful exit's stderr anomaly WITHOUT forcing round 0", () => {
    const [round, why] = interpretRoundResult({
      code: 0,
      stdout: "4\n",
      stderr:
        "current-round: counter ... is unreadable (EACCES) — reading 0, so the round-indexed cutoff does not arm this pass\n",
      timedOut: false,
    });
    expect(round).toBe(4);
    expect(why).not.toBe("");
    expect(why).toContain("round 4 still used");
    expect(why).toContain("EACCES");
    // The relayed anomaly must never claim round 0, since round is 4 here —
    // that was exactly the earlier wrapper's blind spot.
    expect(why).not.toContain("reading round 0");
  });

  it("collapses a multi-line relayed anomaly onto one line", () => {
    const [round, why] = interpretRoundResult({
      code: 0,
      stdout: "2\n",
      stderr: "first anomaly line\nsecond anomaly line\n",
      timedOut: false,
    });
    expect(round).toBe(2);
    expect(why).not.toContain("\n");
    expect(why).toContain("first anomaly line");
    expect(why).toContain("second anomaly line");
  });
});

describe("triage-ladder.ts entry script", () => {
  const runScript = (
    args: string[],
  ): { code: number; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
    });
    return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
  };

  it("prints a JSON verdict and exits 0", () => {
    const r = runScript([
      "--round",
      "5",
      "--severity",
      "low",
      "--tier",
      "3",
      "--category",
      "style",
      "--self-inflicted",
      "false",
    ]);
    expect(r.code).toBe(0);
    const v = JSON.parse(r.stdout);
    expect(v.stance).toBe("declined");
    expect(v.reply).toContain("**wont-fix**");
  });

  it("exits 2 on an out-of-domain --severity value", () => {
    const r = runScript([
      "--round",
      "5",
      "--severity",
      "urgent",
      "--tier",
      "3",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--severity must be one of");
  });

  it("exits 2 on an out-of-domain --tier value", () => {
    const r = runScript(["--round", "5", "--severity", "low", "--tier", "99"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--tier must be an integer 1-4");
  });

  it("exits 2 without --severity, rather than defaulting to unknown", () => {
    const r = runScript(["--round", "5", "--tier", "3"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--severity is required");
  });

  it("exits 2 without --tier", () => {
    const r = runScript(["--round", "5", "--severity", "low"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--tier is required");
  });

  it("exits 2 when --round and --pr are both given", () => {
    const r = runScript([
      "--round",
      "5",
      "--pr",
      "1",
      "--severity",
      "low",
      "--tier",
      "3",
      "--self-inflicted",
      "unknown",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("exclusive");
  });

  it("exits 2 without --self-inflicted, rather than defaulting to unknown", () => {
    const r = runScript(["--round", "5", "--severity", "low", "--tier", "3"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--self-inflicted is required");
  });

  it("exits 2 without --category, rather than defaulting to unknown", () => {
    const r = runScript([
      "--round",
      "5",
      "--severity",
      "low",
      "--tier",
      "3",
      "--self-inflicted",
      "unknown",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--category is required");
  });

  it("exits 0 and stays inert on a config path that does not exist", () => {
    const r = runScript([
      "--round",
      "9",
      "--severity",
      "low",
      "--tier",
      "4",
      "--category",
      "unknown",
      "--self-inflicted",
      "unknown",
      "--config",
      join(tmpdir(), "no-such-review-triage.yaml"),
    ]);
    expect(r.code).toBe(0);
    const v = JSON.parse(r.stdout);
    expect(v.armed).toBe(false);
    expect(v.stance).toBe("accepted");
  });

  describe("--category validated against the loaded config", () => {
    const withFixtureConfig = (
      args: string[],
    ): { code: number; stdout: string; stderr: string } => {
      const dir = mkdtempSync(join(tmpdir(), "ladder-cli-"));
      try {
        const configPath = join(dir, "review-triage.yaml");
        writeFileSync(configPath, FIXTURE);
        return runScript([...args, "--config", configPath]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it("exits 2 on a --category not in the config vocabulary — a typo, not `unknown`", () => {
      const r = withFixtureConfig([
        "--round",
        "5",
        "--severity",
        "low",
        "--tier",
        "3",
        "--self-inflicted",
        "unknown",
        "--category",
        "securty",
      ]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--category must be");
      expect(r.stderr).toContain("security");
    });

    it("accepts a --category the config vocabulary lists", () => {
      const r = withFixtureConfig([
        "--round",
        "5",
        "--severity",
        "low",
        "--tier",
        "3",
        "--self-inflicted",
        "unknown",
        "--category",
        "security",
      ]);
      expect(r.code).toBe(0);
    });

    it("accepts the explicit `unknown` token without checking it against the vocabulary", () => {
      const r = withFixtureConfig([
        "--round",
        "5",
        "--severity",
        "low",
        "--tier",
        "3",
        "--self-inflicted",
        "unknown",
        "--category",
        "unknown",
      ]);
      expect(r.code).toBe(0);
    });

    it("does not flag an out-of-vocabulary --category when the config itself is unusable", () => {
      // The ladder is already inert for the unreadable-config reason; there is
      // no vocabulary to validate against, so this must not ALSO exit 2.
      const r = runScript([
        "--round",
        "5",
        "--severity",
        "low",
        "--tier",
        "3",
        "--self-inflicted",
        "unknown",
        "--category",
        "securty",
        "--config",
        join(tmpdir(), "no-such-review-triage.yaml"),
      ]);
      expect(r.code).toBe(0);
      const v = JSON.parse(r.stdout);
      expect(v.armed).toBe(false);
    });
  });

  describe("--round rejects an unsafe-integer digit string", () => {
    it("exits 2 on a round too large to represent safely", () => {
      const r = runScript([
        "--round",
        "9".repeat(400),
        "--severity",
        "low",
        "--tier",
        "3",
        "--self-inflicted",
        "unknown",
      ]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--round must be a whole number");
    });

    it("exits 2 one past MAX_SAFE_INTEGER", () => {
      const r = runScript([
        "--round",
        `${Number.MAX_SAFE_INTEGER + 2}`,
        "--severity",
        "low",
        "--tier",
        "3",
        "--self-inflicted",
        "unknown",
      ]);
      expect(r.code).toBe(2);
    });

    it("accepts MAX_SAFE_INTEGER itself", () => {
      const r = runScript([
        "--round",
        `${Number.MAX_SAFE_INTEGER}`,
        "--severity",
        "low",
        "--tier",
        "3",
        "--category",
        "unknown",
        "--self-inflicted",
        "unknown",
      ]);
      expect(r.code).toBe(0);
      const v = JSON.parse(r.stdout);
      expect(v.round).toBe(Number.MAX_SAFE_INTEGER);
    });
  });
});
