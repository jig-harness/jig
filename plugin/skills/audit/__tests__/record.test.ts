import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadModules,
  MODULE_IDS,
  type Module,
  parseModule,
} from "../scripts/lib/criteria.ts";
import { loadProfiles } from "../scripts/lib/profiles.ts";
import {
  type AuditRecord,
  checkRecord,
  compare,
  declinedData,
  declinedEntryLines,
  evidencePaths,
  parseRecord,
  renderComparison,
  renderPortfolio,
} from "../scripts/lib/record.ts";
import { parseSchema } from "../scripts/lib/schema.ts";
import { recordData } from "../scripts/report/data.ts";
import { commitFiles, git, runScript, scratchRepo } from "./helpers.ts";

const scratch = mkdtempSync(join(tmpdir(), "jig-record-"));
const repos: string[] = [];
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});
const repo = (files: Record<string, string>) => {
  const r = scratchRepo(files);
  repos.push(r);
  return r;
};

const modules: Module[] = [
  parseModule(
    `module: M1
name: gates
purpose: P.
criteria:
  - { id: fixed, level: lite, requires: convention, statement: F., observe: [f] }
  - { id: slipped, level: lite, requires: convention, statement: S., observe: [s] }
  - { id: weakened, level: standard, requires: convention, statement: W., observe: [w] }
  - { id: open, level: standard, requires: mechanical, statement: O., observe: [o] }
  - { id: dropped, level: standard, requires: mechanical, statement: D., observe: [d] }
  - { id: unscored-before, level: strict, requires: convention, statement: U., observe: [u] }
  - { id: brand-new, level: strict, requires: convention, statement: N., observe: [n], since: 0.14.0 }
`,
    "M1.yaml",
  ),
];

const schema = parseSchema({
  version: 1,
  strict: [],
  refused: {},
  fields: {
    "gates.command": { type: "command", read_by: ["drive-pr"] },
    "audit.new_field": { type: "string", read_by: ["audit"], since: "0.14.0" },
  },
});

function record(criteria: Record<string, string>, extra = ""): AuditRecord {
  const lines = Object.entries(criteria).map(
    ([k, s]) => `  ${k}: { score: ${s}, evidence: "path/${k}" }`,
  );
  return parseRecord(
    `version: 1\nplugin_version: 0.13.0\ndate: 2026-01-02\ncommit: abc\ncriteria:\n${lines.join("\n")}\n${extra}`,
    "record.yaml",
  );
}

describe("parsing", () => {
  test("reads an unquoted YAML date as a date", () => {
    expect(record({}).date).toBe("2026-01-02");
  });
  test.each([
    [
      "a wrong version",
      "version: 2\nplugin_version: 0.13.0\ndate: 2026-01-02\ncommit: a\ncriteria: {}\n",
    ],
    [
      "a bad plugin version",
      "version: 1\nplugin_version: next\ndate: 2026-01-02\ncommit: a\ncriteria: {}\n",
    ],
    [
      "a bad date",
      "version: 1\nplugin_version: 0.13.0\ndate: January\ncommit: a\ncriteria: {}\n",
    ],
    [
      "a bad score",
      "version: 1\nplugin_version: 0.13.0\ndate: 2026-01-02\ncommit: a\ncriteria: { M1/x: { score: great } }\n",
    ],
    [
      "a bad key",
      "version: 1\nplugin_version: 0.13.0\ndate: 2026-01-02\ncommit: a\ncriteria: { x: { score: absent } }\n",
    ],
    [
      "a decline without a condition",
      "version: 1\nplugin_version: 0.13.0\ndate: 2026-01-02\ncommit: a\ncriteria: {}\ndeclined: [{ refs: [M1/x], reason: r }]\n",
    ],
    [
      "an impossible date",
      'version: 1\nplugin_version: 0.13.0\ndate: "2026-99-99"\ncommit: a\ncriteria: {}\n',
    ],
    [
      "an impossible revisit date",
      'version: 1\nplugin_version: 0.13.0\ndate: 2026-01-02\ncommit: a\ncriteria: {}\ndeclined: [{ refs: [M1/x], reason: r, revisit_when: w, revisit_after: "2026-02-30" }]\n',
    ],
    [
      "a decline of an unknown kind",
      "version: 1\nplugin_version: 0.13.0\ndate: 2026-01-02\ncommit: a\ncriteria: {}\ndeclined: [{ refs: [x], reason: r, revisit_when: w }]\n",
    ],
  ])("refuses %s", (_, text) => {
    expect(() => parseRecord(text, "r.yaml")).toThrow();
  });

  test("check names what is missing, unscored, unevidenced or unknown", () => {
    const r = parseRecord(
      `version: 1
plugin_version: 0.13.0
date: 2026-01-02
commit: abc
criteria:
  M1/fixed: { score: convention, evidence: "x" }
  M1/slipped: { score: null }
  M1/weakened: { score: convention }
  M1/gone: { score: absent, evidence: "y" }
declined:
  - { refs: [M1/vanished], reason: r, revisit_when: w }
`,
      "r.yaml",
    );
    const problems = checkRecord(r, modules);
    expect(problems).toContain("M1/slipped: not scored");
    expect(problems).toContain("M1/weakened: no evidence");
    expect(problems).toContain("M1/open: missing");
    expect(problems).toContain(
      "M1/gone: not a criterion of this plugin version",
    );
    expect(problems).toContain(
      "declined M1/vanished: not a criterion of this plugin version",
    );
  });
});

test("a configuration finding whose id holds spaces can be declined", () => {
  const r = record(
    {},
    'declined:\n  - { refs: ["config/derivation:required-check:CI / gates"], reason: r, revisit_when: w }\n',
  );
  expect(r.declined[0]?.refs).toEqual([
    "config/derivation:required-check:CI / gates",
  ]);
});

test("a declined entry is written back with every key it was read with", () => {
  const r = record(
    {},
    'declined:\n  - { refs: [M1/x], reason: r, revisit_when: w, owner: maintainers, "see also": [M1/y] }\n',
  );
  const lines = declinedEntryLines(
    r.declined[0] as AuditRecord["declined"][number],
  );
  const again = record({}, `declined:\n${lines.join("\n")}\n`);
  expect(again.declined).toEqual(r.declined);
  expect(r.declined[0]?.other).toEqual({
    owner: "maintainers",
    "see also": ["M1/y"],
  });
});

test("a declined entry's kept keys are embedded beside its defined ones and read back unchanged", () => {
  const r = record(
    {},
    "declined:\n  - { refs: [M1/x], reason: r, revisit_when: w, revisit_after: 2026-03-01, owner: maintainers }\n",
  );
  const data = r.declined.map(declinedData);
  expect(data[0]).toEqual({
    refs: ["M1/x"],
    reason: "r",
    revisit_when: "w",
    revisit_after: "2026-03-01",
    owner: "maintainers",
  });
  expect(recordData(r).declined).toEqual(data);
  const again = record({}, `declined: ${JSON.stringify(data)}\n`);
  expect(again.declined).toEqual(r.declined);
});

test.each([
  ["an unquoted date", "reviewed_on: 2026-10-01"],
  ["an infinite number", "weight: .inf"],
  ["a date inside a list", "seen: [2026-10-01]"],
])("a declined entry's kept key holding %s is refused", (_, field) => {
  expect(() =>
    record(
      {},
      `declined:\n  - { refs: [M1/x], reason: r, revisit_when: w, ${field} }\n`,
    ),
  ).toThrow(/quote a date/);
});

test.each([
  ["a cycle", "loop: &l [1, *l]"],
  ["a shared node", "a: &n [1], b: [*n, *n]"],
  [
    "an exponential expansion",
    `n0: &n0 [x], ${Array.from({ length: 40 }, (_, i) => `n${i + 1}: &n${i + 1} [*n${i}, *n${i}]`).join(", ")}`,
  ],
])(
  "a declined entry's kept key repeating %s through an alias is refused",
  (_, field) => {
    expect(() =>
      record(
        {},
        `declined:\n  - { refs: [M1/x], reason: r, revisit_when: w, ${field} }\n`,
      ),
    ).toThrow(/YAML alias/);
  },
);

test.each([
  ["a scalar alias", "a: &s text, b: *s", { a: "text", b: "text" }],
  ["an alias to refs", "see_also: *r", { see_also: ["M1/x"] }],
])("a declined entry's kept key holding %s is kept", (_, field, kept) => {
  const r = record(
    {},
    `declined:\n  - { refs: &r [M1/x], reason: r, revisit_when: w, ${field} }\n`,
  );
  expect(r.declined[0]?.other).toEqual(kept);
});

test("moving into or out of expected-absent is a reclassification, not a fix or regression", () => {
  const m = [
    parseModule(
      "module: M1\nname: g\npurpose: P.\ncriteria:\n  - { id: a, level: lite, requires: mechanical, statement: A., observe: [a] }\n  - { id: b, level: lite, requires: mechanical, statement: B., observe: [b] }\n",
      "M1.yaml",
    ),
  ];
  const result = compare(
    record({ "M1/a": "expected-absent", "M1/b": "absent" }),
    record({ "M1/a": "mechanical", "M1/b": "expected-absent" }),
    m,
    schema,
    "2026-10-12",
  );
  expect(result.criteria.map((c) => c.change)).toEqual([
    "reclassified",
    "reclassified",
  ]);
});

test("a criterion newer than the prior audit's plugin is added by Jig even when the prior record scores it", () => {
  const m = [
    parseModule(
      "module: M1\nname: g\npurpose: P.\ncriteria:\n  - { id: a, level: lite, requires: mechanical, statement: A., observe: [a], since: 0.14.0 }\n  - { id: b, level: lite, requires: mechanical, statement: B., observe: [b], since: 0.13.0 }\n",
      "M1.yaml",
    ),
  ];
  const result = compare(
    record({ "M1/a": "absent", "M1/b": "absent" }),
    record({ "M1/a": "absent", "M1/b": "absent" }),
    m,
    schema,
    "2026-10-12",
  );
  expect(result.criteria.map((c) => c.change)).toEqual([
    "added-by-jig",
    "still-open",
  ]);
});

describe("comparing two audits", () => {
  const prior = record(
    {
      "M1/fixed": "absent",
      "M1/slipped": "convention",
      "M1/weakened": "mechanical",
      "M1/open": "advisory",
      "M1/dropped": "advisory",
      "M1/retired": "convention",
    },
    `declined:
  - { refs: [M1/open], reason: r, revisit_when: "the team grows" }
  - { refs: [M1/open], reason: r, revisit_when: w, revisit_after: "2026-06-01" }
  - { refs: [M1/fixed], reason: r, revisit_when: w }
  - { refs: [M1/retired], reason: r, revisit_when: w }
  - { refs: [config/suggestion:gates.command], reason: r, revisit_when: w }
  - { refs: [M1/fixed, config/suggestion:gates.command], reason: r, revisit_when: w }
`,
  );
  const current = record({
    "M1/fixed": "convention",
    "M1/slipped": "absent",
    "M1/weakened": "convention",
    "M1/open": "advisory",
    "M1/dropped": "absent",
    "M1/unscored-before": "convention",
    "M1/brand-new": "absent",
  });
  const result = compare(prior, current, modules, schema, "2026-10-12");
  const change = (key: string) =>
    result.criteria.find((c) => c.key === key)?.change;

  test("each criterion is fixed, regressed, still open, new, added by Jig or removed", () => {
    expect(change("M1/fixed")).toBe("fixed");
    expect(change("M1/slipped")).toBe("regressed");
    // Still met, but a rung lower: drift worth reporting.
    expect(change("M1/weakened")).toBe("regressed");
    expect(change("M1/open")).toBe("still-open");
    // Below the bar both times, but a rung lower: enforcement was lost.
    expect(change("M1/dropped")).toBe("regressed");
    expect(change("M1/unscored-before")).toBe("new");
    expect(change("M1/brand-new")).toBe("added-by-jig");
    expect(change("M1/retired")).toBe("removed");
  });

  test("declines are held, due, resolved or stale", () => {
    expect(result.declined.map((d) => d.status)).toEqual([
      "held",
      "due",
      "resolved",
      "stale",
      "held",
      // A configuration ref is not settled by criterion scores.
      "held",
    ]);
    expect(result.declined[0]?.why).toContain("the team grows");
  });

  test("configuration fields added after the prior audit are listed", () => {
    expect(result.newFields).toEqual(["audit.new_field (since 0.14.0)"]);
  });

  test("levels are compared", () => {
    expect(result.levels).toEqual([
      { module: "M1 gates", prior: "none", current: "none" },
    ]);
  });

  test("a module the prior plugin version did not have attains nothing then", () => {
    const later = parseModule(
      `module: M9
name: later
purpose: P.
criteria:
  - { id: only, level: lite, requires: mechanical, statement: O., observe: [o], since: 0.14.0 }
`,
      "M9.yaml",
    );
    const levels = compare(
      record({}),
      record({ "M9/only": "absent" }),
      [later],
      schema,
      "2026-10-12",
    ).levels;
    expect(levels).toEqual([
      { module: "M9 later", prior: null, current: "none" },
    ]);
  });
});

describe("the command line", () => {
  const complete = `version: 1
plugin_version: 0.13.0
date: 2026-01-02
commit: abc
shape: library
criteria: {}
`;
  test("check fails an incomplete record and summary reports levels", () => {
    const path = join(scratch, "r.yaml");
    writeFileSync(path, complete);
    const check = runScript("record.ts", ["check", path], scratch);
    expect(check.code).toBe(1);
    expect(check.out).toContain("M0/universal-instruction-file: missing");
    const summary = runScript("record.ts", ["summary", path], scratch);
    expect(summary.code).toBe(0);
    expect(summary.out).toContain(
      "| M0 instruction-architecture | incomplete |",
    );
  });

  test("compare and portfolio read records from paths", () => {
    const a = join(scratch, "a.yaml");
    const b = join(scratch, "b.yaml");
    const scored = loadModules()
      .flatMap((m) => m.criteria)
      .map((c) => `  ${c.key}: { score: absent, evidence: "none" }`)
      .join("\n");
    writeFileSync(a, complete);
    writeFileSync(b, complete.replace("2026-01-02", "2026-02-03"));
    const incomplete = runScript("record.ts", ["compare", a, b], scratch);
    expect(incomplete.code).toBe(1);
    expect(incomplete.err).toContain("is incomplete");
    writeFileSync(
      b,
      complete
        .replace("2026-01-02", "2026-02-03")
        .replace("criteria: {}", `criteria:\n${scored}`),
    );
    const cmp = runScript("record.ts", ["compare", a, b], scratch);
    expect(cmp.code).toBe(0);
    expect(cmp.out).toContain(
      "# Changes since the audit of 2026-01-02 (plugin 0.13.0)",
    );
    const json = JSON.parse(
      runScript("record.ts", ["compare", a, b, "--json"], scratch).out,
    );
    expect(json.levels).toHaveLength(MODULE_IDS.length);
    const portfolio = runScript(
      "record.ts",
      ["portfolio", `web=${a}`, `api=${b}`],
      scratch,
    );
    expect(portfolio.code).toBe(0);
    expect(portfolio.out).toContain("| Criterion | Requires | web | api |");
    writeFileSync(
      b,
      complete
        .replace("shape: library", "shape: library\nprofile: enterprise")
        .replace("criteria: {}", `criteria:\n${scored}`),
    );
    const unknownProfile = runScript("record.ts", ["compare", a, b], scratch);
    expect(unknownProfile.code).toBe(1);
    expect(unknownProfile.err).toContain("profile: enterprise is not one of");
  });

  test("usage errors exit 2", () => {
    expect(runScript("record.ts", [], scratch).code).toBe(2);
    expect(runScript("record.ts", ["compare", "one"], scratch).code).toBe(2);
    expect(runScript("record.ts", ["portfolio", "one=x"], scratch).code).toBe(
      2,
    );
    expect(
      runScript("record.ts", ["check", join(scratch, "missing.yaml")], scratch)
        .code,
    ).toBe(2);
  });
});

test("portfolio marks what meets the bar", () => {
  const a = record({ "M1/fixed": "convention", "M1/open": "advisory" });
  const out = renderPortfolio(
    [
      { name: "a", record: a },
      { name: "b", record: a },
    ],
    modules,
  );
  expect(out).toContain("| fixed | convention | convention ✓ | convention ✓ |");
  expect(out).toContain("| open | mechanical | advisory | advisory |");
});

describe("a criterion left not examined", () => {
  const m = [
    parseModule(
      "module: M1\nname: g\npurpose: P.\ncriteria:\n  - { id: a, level: lite, requires: mechanical, statement: A., observe: [a] }\n  - { id: b, level: lite, requires: mechanical, statement: B., observe: [b] }\n  - { id: c, level: lite, requires: mechanical, statement: C., observe: [c] }\n  - { id: d, level: lite, requires: mechanical, statement: D., observe: [d] }\n",
      "M1.yaml",
    ),
    parseModule(
      "module: M2\nname: h\npurpose: P.\ncriteria:\n  - { id: a, level: lite, requires: mechanical, statement: A., observe: [a] }\n",
      "M2.yaml",
    ),
  ];
  const prior = record({
    "M1/a": "not-examined",
    "M1/b": "mechanical",
    "M1/c": "not-examined",
    "M1/d": "absent",
    "M2/a": "not-examined",
  });
  const current = record({
    "M1/a": "mechanical",
    "M1/b": "not-examined",
    "M1/c": "not-examined",
    "M1/d": "not-examined",
    "M2/a": "not-examined",
  });
  const result = compare(prior, current, m, schema, "2026-10-12");

  test("is examined since, no longer examined, or unexamined both times: never fixed, regressed or new", () => {
    expect(result.criteria.map((c) => [c.key, c.change])).toEqual([
      ["M1/a", "examined-since"],
      ["M1/b", "no-longer-examined"],
      ["M1/c", "not-examined"],
      ["M1/d", "no-longer-examined"],
      ["M2/a", "not-examined"],
    ]);
  });

  test("is reported in groups of its own, and a module none of whose criteria were examined says so", () => {
    const text = renderComparison(result, prior);
    expect(text).toContain(
      "## examined since (1)\n\n- M1/a: not-examined → mechanical",
    );
    expect(text).toContain("## no longer examined (2)");
    expect(text).toContain("Not examined: 2.");
    expect(text).not.toContain("## fixed");
    expect(text).not.toContain("## regressed");
    expect(text).toContain("| M2 h | not examined | not examined |");
  });

  test("against a prior audit that examined everything, is counted in one line rather than listed", () => {
    const everything = record({
      "M1/a": "mechanical",
      "M1/b": "mechanical",
      "M1/c": "absent",
      "M1/d": "absent",
      "M2/a": "mechanical",
    });
    const scoped = record({
      "M1/a": "mechanical",
      "M1/b": "not-examined",
      "M1/c": "not-examined",
      "M1/d": "not-examined",
      "M2/a": "not-examined",
    });
    const narrowed = compare(everything, scoped, m, schema, "2026-10-12");
    // The comparison itself, and so --json, still names each one.
    expect(
      narrowed.criteria.filter((c) => c.change === "no-longer-examined"),
    ).toHaveLength(4);
    const text = renderComparison(narrowed, everything);
    expect(text).not.toContain("## no longer examined");
    expect(text).not.toContain("- M1/b:");
    expect(text).toContain(
      "No longer examined: 4 criteria the prior audit scored lie beyond the new target and were not examined; the prior record keeps their scores (the draft carries each as a comment), and score.ts --draft --examine-all examines them again.",
    );
  });

  describe("under a declared profile", () => {
    const real = loadModules();
    const profiles = loadProfiles(real);
    const all = real.flatMap((x) => x.criteria);
    const scored = (
      header: string,
      unexamined: readonly string[],
    ): AuditRecord =>
      parseRecord(
        `version: 1\nplugin_version: 0.13.0\ndate: 2026-01-02\ncommit: abc\n${header}criteria:\n${all
          .map((c) =>
            unexamined.includes(c.key)
              ? `  ${c.key}: { score: not-examined, evidence: "not examined: beyond the target" }`
              : `  ${c.key}: { score: absent, evidence: "none" }`,
          )
          .join("\n")}\n`,
        "r.yaml",
      );
    const problems = (header: string, unexamined: readonly string[]) =>
      checkRecord(scored(header, unexamined), real, profiles);

    test("may leave a criterion beyond its target unexamined, and none within", () => {
      expect(
        problems("profile: solo-lite\n", ["M0/per-directory-instructions"]),
      ).toEqual([]);
      expect(
        problems("profile: solo-lite\n", ["M0/universal-instruction-file"]),
      ).toEqual([
        "M0/universal-instruction-file: not examined, but within the Solo/Lite target (lite): score it",
      ]);
      // Without a declared profile, any criterion may be left.
      expect(problems("", ["M0/universal-instruction-file"])).toEqual([]);
    });

    test("counts a condition and the heading-to profile's targets", () => {
      const port = "M12/branch-reuse-and-footgun-bans-written";
      expect(problems("profile: team-standard\n", [port])).toEqual([]);
      expect(
        problems("profile: team-standard\nprofile_conditions: [M12]\n", [port]),
      ).toHaveLength(1);
      const owned = "M0/instruction-set-owned";
      expect(problems("profile: team-standard\n", [owned])).toEqual([]);
      expect(
        problems("profile: team-standard\nheading_to: regulated-strict\n", [
          owned,
        ]),
      ).toEqual([
        `${owned}: not examined, but within the Team/Standard or Regulated/Strict target (strict): score it`,
      ]);
    });
  });
});

test("evidence names a path only where it reads unmistakably as one, and not where it says it is missing", () => {
  const paths = evidencePaths(
    "@AGENTS.md:12 and (docs/adr/0001-x.md:3-9), `.github/workflows/ci.yml`; .editorconfig, Makefile, ./scripts/gates.ts. See https://example.com/a.md, example.com/b/c.md, src/**/*.ts, M1/ci-runs-gates-on-pr, config/suggestion:gates.command, e.g. Node.js 22, CI/CD, and/or, version 0.13.0, every .ts file, repos/o/r/branches/main/protection; no lefthook.yml or .husky/; ci.yml runs it",
  );
  expect(paths.map((p) => p.token)).toEqual([
    "AGENTS.md:12",
    "docs/adr/0001-x.md:3-9",
    ".github/workflows/ci.yml",
    ".editorconfig",
    "Makefile",
    "scripts/gates.ts",
    "ci.yml",
  ]);
  expect(paths[1]).toEqual({
    token: "docs/adr/0001-x.md:3-9",
    path: "docs/adr/0001-x.md",
    line: 3,
    end: 9,
  });
});

test.each([
  [
    "a file of the audit's scratch folder",
    "read from fit.json, jig-audit.json, jig-audit.next.yaml and m3.draft.yaml",
  ],
  [
    "a code identifier",
    "the store uses Bun.SQL, sets .exitCode and reads rules[].paths",
  ],
  ["a fragment of a name", "files named <area>-template.md"],
  [
    "a file the evidence proposes",
    "would add docs/runbook.md; proposed .github/CODEOWNERS; missing docs/adr/README.md",
  ],
])("evidence names no path in %s", (_, evidence) => {
  expect(evidencePaths(evidence)).toEqual([]);
});

test("names joined by a slash that each read as a file are alternatives", () => {
  expect(
    evidencePaths("AGENTS.md/CLAUDE.md:3 at the root, docs/a.md").map(
      (p) => p.token,
    ),
  ).toEqual(["AGENTS.md", "CLAUDE.md:3", "docs/a.md"]);
});

test("a path a word for the plugin shortly precedes is marked as possibly the plugin's", () => {
  const [plugin, own] = evidencePaths(
    "replies through the plugin's scripts/reply-to-thread.ts; scripts/reply-to-thread.ts",
  );
  expect(plugin).toEqual({
    token: "scripts/reply-to-thread.ts",
    path: "scripts/reply-to-thread.ts",
    plugin: true,
  });
  expect(own?.plugin).toBeUndefined();
  // A word for the plugin elsewhere in the clause does not claim the repository's own path.
  const [, script] = evidencePaths(
    "Jig is configured in .config/jig.yaml and the repository's scripts/score.ts runs its checks",
  );
  expect(script).toEqual({
    token: "scripts/score.ts",
    path: "scripts/score.ts",
  });
  // A skill may be the repository's own: only the plugin or Jig claims a path.
  expect(
    evidencePaths("the repository's skill runs scripts/score.ts")[0]?.plugin,
  ).toBeUndefined();
  // The plugin near a path is not the plugin owning it: only a possessive is.
  expect(
    evidencePaths("the plugin calls repository scripts/score.ts")[0]?.plugin,
  ).toBeUndefined();
  expect(evidencePaths("Jig's own scripts/score.ts")[0]?.plugin).toBe(true);
});

test("add or create after a program is a command, and the paths after it are read", () => {
  expect(
    evidencePaths(
      "CI runs git add docs/generated.md and scripts/gone.ts validates the output",
    ).map((p) => p.path),
  ).toEqual(["docs/generated.md", "scripts/gone.ts"]);
  expect(evidencePaths("add docs/runbook.md and create docs/x.md")).toEqual([]);
  // A program's options between it and its command keep it a command.
  expect(
    evidencePaths(
      "CI runs git -C tools add docs/generated.md and scripts/gone.ts validates the output",
    ).map((p) => p.path),
  ).toEqual(["docs/generated.md", "scripts/gone.ts"]);
  // A proposal covers the path it names, not the rest of the clause.
  expect(
    evidencePaths("add docs/runbook.md beside docs/real.md").map((p) => p.path),
  ).toEqual(["docs/real.md"]);
  // It covers a list of paths, joined by commas, `and` or `or`.
  for (const evidence of [
    "add docs/a.md and docs/b.md",
    "add docs/a.md, docs/b.md",
    "create docs/a.md, docs/b.md or docs/c.md",
  ])
    expect(evidencePaths(evidence)).toEqual([]);
  expect(
    evidencePaths("add docs/a.md and docs/b.md beside docs/real.md").map(
      (p) => p.path,
    ),
  ).toEqual(["docs/real.md"]);
  // Every path after a comma in the list is proposed, whatever follows it:
  // the words after cannot tell a proposal from a claim. A path to check
  // starts a clause of its own.
  for (const evidence of [
    "add docs/a.md, docs/b.md beside docs/real.md",
    "add docs/a.md, docs/b.md, docs/c.md beside docs/real.md",
  ])
    expect(evidencePaths(evidence).map((p) => p.path)).toEqual([
      "docs/real.md",
    ]);
  for (const evidence of [
    "add docs/new.md, scripts/gone.ts validates the result",
    "add docs/a.md, docs/b.md, scripts/gone.ts validates the result",
  ])
    expect(evidencePaths(evidence)).toEqual([]);
  expect(
    evidencePaths("add docs/new.md; scripts/gone.ts validates the result").map(
      (p) => p.path,
    ),
  ).toEqual(["scripts/gone.ts"]);
  for (const evidence of [
    "add docs/a.md, docs/b.md, and docs/c.md",
    "add docs/a.md, docs/b.md and docs/c.md",
  ])
    expect(evidencePaths(evidence)).toEqual([]);
});

test("a file name in capitals is a path, a member in capitals is code", () => {
  expect(
    evidencePaths("README.MD, CONFIG.YAML and PACKAGE.JSON; Bun.SQL").map(
      (p) => p.path,
    ),
  ).toEqual(["README.MD", "CONFIG.YAML", "PACKAGE.JSON"]);
});

describe("records run against the repository they audit", () => {
  const recordFor = (commit: string, criteria = "{}", extra = "") =>
    `version: 1\nplugin_version: 0.13.0\ndate: 2026-01-02\ncommit: ${commit}\n${extra}criteria: ${criteria}\n`;

  test("check, compare (either record) and summary refuse another repository's record", () => {
    const dir = repo({ "AGENTS.md": "# Agents\n" });
    const other = repo({ "README.md": "# Other\n" });
    const foreign = join(scratch, "foreign.yaml");
    writeFileSync(foreign, recordFor(git(other, "rev-parse", "HEAD")));
    const own = join(scratch, "own.yaml");
    writeFileSync(own, recordFor(git(dir, "rev-parse", "HEAD")));
    for (const args of [
      ["check", foreign],
      ["compare", foreign, own],
      ["compare", own, foreign],
      ["summary", foreign],
    ]) {
      const run = runScript("record.ts", args, dir);
      expect([args.join(" "), run.code]).toEqual([args.join(" "), 1]);
      expect(run.err).toContain(`${foreign} audits commit`);
    }
    expect(runScript("record.ts", ["summary", own], dir).code).toBe(0);
  });

  test("check warns about evidence naming a path or line the commit does not hold, without failing", () => {
    const dir = repo({
      "docs/a.md": "one\ntwo\nthree\n",
      ".github/workflows/ci.yml": "on: push\n",
    });
    const head = git(dir, "rev-parse", "HEAD");
    // A file added after the audited commit is not evidence of it.
    commitFiles(dir, { "docs/later.md": "later\n" });
    const scored = loadModules()
      .flatMap((x) => x.criteria)
      .map((c, i) =>
        i === 0
          ? `  ${c.key}: { score: convention, evidence: "docs/a.md:2-3, docs/a.md:9, docs/later.md, docs/, src/**/*.ts, ci.yml:1, workflows/ci.yml:4; no lefthook.yml" }`
          : i === 1
            ? `  ${c.key}: { score: absent, evidence: "probe: no tracked file matches gone/x.md" }`
            : `  ${c.key}: { score: absent, evidence: "none" }`,
      )
      .join("\n");
    const path = join(scratch, "evidence.yaml");
    writeFileSync(path, recordFor(head, `\n${scored}`));
    const run = runScript("record.ts", ["check", path], dir);
    expect(run.code).toBe(0);
    const warnings = run.out
      .split("\n")
      .filter((l) => l.startsWith("warning: "));
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain(
      "docs/a.md:9 cites a line past the end of docs/a.md (3 lines",
    );
    // A shortened name is read as the one path it ends.
    expect(warnings[2]).toContain(
      "workflows/ci.yml:4 cites a line past the end of .github/workflows/ci.yml (1 lines",
    );
    expect(warnings[1]).toContain(
      `docs/later.md is not in commit ${head.slice(0, 12)}`,
    );
    expect(run.out).toContain("3 evidence warning(s) to look at");
  });

  test("check warns of a stale path beside evidence that names none, and not of the plugin's own scripts", () => {
    const dir = repo({ "AGENTS.md": "# Agents\n" });
    const head = git(dir, "rev-parse", "HEAD");
    const scored = loadModules()
      .flatMap((x) => x.criteria)
      .map((c, i) =>
        i === 0
          ? `  ${c.key}: { score: convention, evidence: "AGENTS.md/CLAUDE.md; Bun.SQL and .exitCode in fit.json; <x>-template.md; would add docs/runbook.md; the jig plugin's scripts/await-round.ts waits on reviews; docs/gone.md lists it; scripts/reply-to-thread.ts; the repository's skill runs scripts/score.ts; scripts/record.ts; the plugin's scripts/record.ts; the plugin's scripts/report.ts; scripts/report.ts" }`
          : `  ${c.key}: { score: absent, evidence: "none" }`,
      )
      .join("\n");
    const path = join(scratch, "false-positives.yaml");
    writeFileSync(path, recordFor(head, `\n${scored}`));
    const run = runScript("record.ts", ["check", path], dir);
    expect(run.code).toBe(0);
    const warnings = run.out
      .split("\n")
      .filter((l) => l.startsWith("warning: "));
    const short = head.slice(0, 12);
    expect(warnings.map((w) => w.replace(/^warning: \S+: /, ""))).toEqual([
      `CLAUDE.md is not in commit ${short}`,
      `docs/gone.md is not in commit ${short}`,
      // A plugin script not said to be the plugin's is the repository's, and missing.
      `scripts/reply-to-thread.ts is not in commit ${short}`,
      `scripts/score.ts is not in commit ${short}`,
      // Cited as the repository's too, before or after the plugin's: missing either way.
      `scripts/record.ts is not in commit ${short}`,
      `scripts/report.ts is not in commit ${short}`,
    ]);
  });

  test("summary shows the targets of a profile the record does not declare, without editing it", () => {
    const path = join(scratch, "explore.yaml");
    const text = recordFor(
      "abc",
      "{ M1/ci-runs-gates-on-pr: { score: mechanical, evidence: x } }",
    );
    writeFileSync(path, text);
    const run = runScript(
      "record.ts",
      ["summary", path, "--profile", "team-standard", "--conditions", "M12"],
      scratch,
    );
    expect(run.code).toBe(0);
    expect(run.out).toContain(
      "Profile: Team/Standard (from --profile; the record declares none)",
    );
    expect(run.out).toContain(
      "| M12 parallel-agent-ergonomics | incomplete | lite |",
    );
    expect(readFileSync(path, "utf8")).toBe(text);
    const refused = runScript(
      "record.ts",
      ["summary", path, "--profile", "solo-lite", "--conditions", "M12"],
      scratch,
    );
    expect(refused.code).toBe(2);
    expect(refused.err).toContain(
      "Solo/Lite has no conditional target for M12",
    );
  });

  test("summary counts criteria left not-examined apart from the ones to go", () => {
    /** The M5 row of the summary under Team/Standard, with the first criterion scored `first`. */
    const m5Row = (first: string) => {
      const path = join(scratch, `unexamined-${first}.yaml`);
      writeFileSync(
        path,
        recordFor(
          "abc",
          `{ M5/adrs-exist-numbered-from-template: { score: ${first}, evidence: "not examined: beyond the Solo/Lite target" } }`,
        ),
      );
      const run = runScript(
        "record.ts",
        ["summary", path, "--profile", "team-standard"],
        scratch,
      );
      expect(run.code).toBe(0);
      return run.out.split("\n").find((l) => l.startsWith("| M5 ")) ?? "";
    };
    const toGo = (row: string) => Number(/(\d+) to go/.exec(row)?.[1] ?? 0);
    const unexamined = m5Row("not-examined");
    const absent = m5Row("absent");
    expect(unexamined).toContain("1 not examined");
    expect(absent).not.toContain("not examined");
    expect(toGo(unexamined)).toBe(toGo(absent) - 1);
  });
});

describe("filling a draft", () => {
  /** A draft written by score.ts in a fresh repository. */
  const draftOf = (name: string) => {
    const dir = repo({ "AGENTS.md": "# Agents\n" });
    const path = join(scratch, name);
    const run = runScript(
      "score.ts",
      ["--draft", path, "--date", "2026-10-12", "--profile", "solo-lite"],
      dir,
    );
    expect(run.code).toBe(0);
    return { dir, path };
  };
  const probed = (path: string) =>
    [...parseRecord(readFileSync(path, "utf8"), path).criteria].find(
      ([, e]) => e.evidence?.startsWith("probe: ") ?? false,
    )?.[0] ?? "";

  test("writes each answer, keeping the draft's comments, and lists what is still null", () => {
    const { dir, path } = draftOf("fill.yaml");
    const before = readFileSync(path, "utf8");
    const answers = join(scratch, "answers.txt");
    writeFileSync(
      answers,
      [
        "# scored by hand",
        "",
        'M0/universal-instruction-file: convention | AGENTS.md: "the root file" # 1 | of 2',
        "M0/glossary-exists: absent | no glossary: checked docs/",
        "M0/per-directory-instructions: mechanical | docs/AGENTS.md",
      ].join("\n"),
    );
    const run = runScript("record.ts", ["fill", path, answers], dir);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(run.out).toContain(`filled 3 criteria into ${path}`);
    expect(run.out).toMatch(/\d+ still null: M0\//);
    const after = readFileSync(path, "utf8");
    const comments = (t: string) =>
      t.split("\n").filter((l) => l.trim().startsWith("#"));
    expect(comments(after)).toEqual(comments(before));
    const record = parseRecord(after, path);
    expect(record.criteria.get("M0/universal-instruction-file")).toEqual({
      score: "convention",
      evidence: 'AGENTS.md: "the root file" # 1 | of 2',
    });
    // A criterion the draft left unexamined can be examined after all.
    expect(record.criteria.get("M0/per-directory-instructions")?.score).toBe(
      "mechanical",
    );
  });

  test("reads answers as JSON and writes them where --into says", () => {
    const { dir, path } = draftOf("fill-json.yaml");
    const before = readFileSync(path, "utf8");
    const answers = join(scratch, "answers.json");
    writeFileSync(
      answers,
      JSON.stringify({
        "M0/glossary-exists": { score: "expected-absent", evidence: "a\nb" },
      }),
    );
    const into = join(scratch, "fill-json-next.yaml");
    const run = runScript(
      "record.ts",
      ["fill", path, answers, "--into", into],
      dir,
    );
    expect(run.code).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(
      parseRecord(readFileSync(into, "utf8"), into).criteria.get(
        "M0/glossary-exists",
      ),
    ).toEqual({ score: "expected-absent", evidence: "a\nb" });
  });

  test.each([
    ["an unknown criterion", "M0/no-such-thing: absent | x", "not a criterion"],
    ["an invalid score", "M0/glossary-exists: great | x", "is not a score"],
    ["empty evidence", "M0/glossary-exists: absent |  ", "evidence is empty"],
    ["a line it cannot read", "M0/glossary-exists absent", "write <criterion>"],
    [
      "a criterion answered twice",
      "M0/glossary-exists: absent | x\nM0/glossary-exists: absent | y",
      "answered twice",
    ],
  ])("refuses %s and writes nothing", (_, line, message) => {
    const { dir, path } = draftOf("refused.yaml");
    const before = readFileSync(path, "utf8");
    const answers = join(scratch, "bad.txt");
    writeFileSync(
      answers,
      `M0/universal-instruction-file: convention | AGENTS.md\n${line}\n`,
    );
    const run = runScript("record.ts", ["fill", path, answers], dir);
    expect(run.code).toBe(1);
    expect(run.err).toContain(message);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("refuses an answer that changes one the draft already holds", () => {
    const { dir, path } = draftOf("refill.yaml");
    const answers = join(scratch, "refill.txt");
    const first = "M0/universal-instruction-file: convention | AGENTS.md\n";
    writeFileSync(answers, first);
    expect(runScript("record.ts", ["fill", path, answers], dir).code).toBe(0);
    // The same answer again changes nothing and is no disagreement.
    const again = runScript("record.ts", ["fill", path, answers], dir);
    expect(again.err).toBe("");
    expect(again.code).toBe(0);
    const before = readFileSync(path, "utf8");
    for (const line of [
      "M0/universal-instruction-file: mechanical | AGENTS.md",
      "M0/universal-instruction-file: convention | AGENTS.md and docs/",
    ]) {
      writeFileSync(answers, `${line}\n`);
      const run = runScript("record.ts", ["fill", path, answers], dir);
      expect(run.code).toBe(1);
      expect(run.err).toContain(
        "M0/universal-instruction-file: the draft already scores it convention (AGENTS.md)",
      );
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });

  test("refuses to change what a probe decided", () => {
    const { dir, path } = draftOf("probe.yaml");
    const key = probed(path);
    const answers = join(scratch, "probe.txt");
    writeFileSync(answers, `${key}: convention | it is there after all\n`);
    const run = runScript("record.ts", ["fill", path, answers], dir);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`${key}: its probe decided it`);
    // The repository's shape may rule the practice out.
    writeFileSync(
      answers,
      `${key}: expected-absent | a library has no deploy\n`,
    );
    const shaped = runScript("record.ts", ["fill", path, answers], dir);
    expect(shaped.code).toBe(0);
    expect(
      parseRecord(readFileSync(path, "utf8"), path).criteria.get(key),
    ).toEqual({
      score: "expected-absent",
      evidence: "a library has no deploy",
    });
  });

  test("holds a capped criterion to its probe's ceiling, in fill, merge and check", () => {
    const { dir, path } = draftOf("ceiling.yaml");
    const key = "M4/frontmatter-machine-validated";
    // The repository has no CI, which the mechanical rung needs.
    expect(
      parseRecord(readFileSync(path, "utf8"), path).criteria.get(key)?.at_most,
    ).toBe("advisory");
    const before = readFileSync(path, "utf8");
    const answers = join(scratch, "ceiling.txt");
    writeFileSync(
      answers,
      `${key}: mechanical | scripts/check-frontmatter.ts\n`,
    );
    const above = runScript("record.ts", ["fill", path, answers], dir);
    expect(above.code).toBe(1);
    expect(above.err).toContain(`${key}: its probe allows at most advisory`);
    expect(readFileSync(path, "utf8")).toBe(before);

    // A partial edited by hand past the ceiling is refused too.
    const partial = join(scratch, "ceiling-partial.yaml");
    writeFileSync(
      partial,
      before.replace(
        new RegExp(
          `(  ${key}:[^\\n]*\\n(?:    #[^\\n]*\\n)*)    score: [^\\n]*\\n    evidence: [^\\n]*`,
        ),
        '$1    score: mechanical\n    evidence: "scripts/check-frontmatter.ts"',
      ),
    );
    expect(readFileSync(partial, "utf8")).not.toBe(before);
    const merged = runScript("record.ts", ["merge", path, partial], dir);
    expect(merged.code).toBe(1);
    expect(merged.err).toContain(`${key}: its probe allows at most advisory`);
    // And `check` finds it in a record edited by hand.
    expect(
      checkRecord(
        parseRecord(readFileSync(partial, "utf8"), partial),
        loadModules(),
      ),
    ).toContain(
      `${key}: its probe allows at most advisory: what a higher rung needs is missing at the audited commit`,
    );

    writeFileSync(
      answers,
      `${key}: advisory | a pre-commit hook validates it\n`,
    );
    const within = runScript("record.ts", ["fill", path, answers], dir);
    expect(within.code).toBe(0);
    expect(
      parseRecord(readFileSync(path, "utf8"), path).criteria.get(key),
    ).toEqual({
      score: "advisory",
      evidence: "a pre-commit hook validates it",
      at_most: "advisory",
    });
  });
});

describe("merging partial drafts", () => {
  const setup = (name: string) => {
    const dir = repo({ "AGENTS.md": "# Agents\n" });
    const path = join(scratch, `${name}.yaml`);
    expect(
      runScript("score.ts", ["--draft", path, "--date", "2026-10-12"], dir)
        .code,
    ).toBe(0);
    /** A copy of the draft with `answers` filled, as one worker leaves it. */
    const partial = (suffix: string, answers: string) => {
      const into = join(scratch, `${name}-${suffix}.yaml`);
      const file = join(scratch, `${name}-${suffix}.txt`);
      writeFileSync(file, answers);
      expect(
        runScript("record.ts", ["fill", path, file, "--into", into], dir).code,
      ).toBe(0);
      return into;
    };
    return { dir, path, partial };
  };

  test("takes each score the partials set and lists what is still null", () => {
    const { dir, path, partial } = setup("merge");
    const a = partial(
      "a",
      "M0/universal-instruction-file: convention | AGENTS.md\n",
    );
    const b = partial(
      "b",
      "M2/hand-editing-forbidden: absent | none listed\nM0/universal-instruction-file: convention | AGENTS.md\n",
    );
    const into = join(scratch, "merged.yaml");
    const run = runScript(
      "record.ts",
      ["merge", path, a, b, "--into", into],
      dir,
    );
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(run.out).toContain("merged 2 criteria from 2 partial draft(s)");
    expect(run.out).toContain("still null");
    const merged = parseRecord(readFileSync(into, "utf8"), into);
    expect(merged.criteria.get("M0/universal-instruction-file")?.score).toBe(
      "convention",
    );
    expect(merged.criteria.get("M2/hand-editing-forbidden")?.score).toBe(
      "absent",
    );
  });

  test("refuses two partials that disagree, a partial of another draft, and a changed probe score", () => {
    const { dir, path, partial } = setup("conflict");
    const a = partial(
      "a",
      "M0/universal-instruction-file: convention | AGENTS.md\n",
    );
    const b = partial(
      "b",
      "M0/universal-instruction-file: mechanical | AGENTS.md\n",
    );
    const before = readFileSync(path, "utf8");
    const disagree = runScript("record.ts", ["merge", path, a, b], dir);
    expect(disagree.code).toBe(1);
    expect(disagree.err).toContain(
      `M0/universal-instruction-file: ${a} scores it convention, ${b} mechanical`,
    );
    const other = join(scratch, "conflict-other.yaml");
    writeFileSync(
      other,
      readFileSync(a, "utf8").replace(/^date: .*$/m, 'date: "2026-10-13"'),
    );
    const stranger = runScript("record.ts", ["merge", path, other], dir);
    expect(stranger.code).toBe(1);
    expect(stranger.err).toContain(
      "not a copy of the draft (its date differs)",
    );
    const probeKey =
      [...parseRecord(before, path).criteria].find(
        ([, e]) => e.evidence?.startsWith("probe: ") ?? false,
      )?.[0] ?? "";
    const changed = join(scratch, "conflict-probe.yaml");
    writeFileSync(
      changed,
      before.replace(
        new RegExp(
          `(  ${probeKey}:[^\\n]*\\n(?:    #[^\\n]*\\n)*)    score: absent\\n    evidence: [^\\n]*`,
        ),
        '$1    score: convention\n    evidence: "there"',
      ),
    );
    expect(readFileSync(changed, "utf8")).not.toBe(before);
    const probe = runScript("record.ts", ["merge", path, changed], dir);
    expect(probe.code).toBe(1);
    expect(probe.err).toContain(`${probeKey}: its probe decided it`);
    expect(readFileSync(path, "utf8")).toBe(before);
    const shaped = join(scratch, "conflict-shaped.yaml");
    writeFileSync(
      shaped,
      readFileSync(changed, "utf8").replace(
        '    score: convention\n    evidence: "there"',
        '    score: expected-absent\n    evidence: "ruled out by the shape"',
      ),
    );
    const accepted = runScript("record.ts", ["merge", path, shaped], dir);
    expect(accepted.err).toBe("");
    expect(accepted.code).toBe(0);
    expect(
      parseRecord(readFileSync(path, "utf8"), path).criteria.get(probeKey)
        ?.score,
    ).toBe("expected-absent");
  });
});
