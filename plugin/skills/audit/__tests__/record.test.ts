import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadModules,
  MODULE_IDS,
  type Module,
  parseModule,
} from "../scripts/lib/criteria.ts";
import {
  type AuditRecord,
  checkRecord,
  compare,
  declinedData,
  declinedEntryLines,
  parseRecord,
  renderPortfolio,
} from "../scripts/lib/record.ts";
import { parseSchema } from "../scripts/lib/schema.ts";
import { recordData } from "../scripts/report/data.ts";
import { runScript } from "./helpers.ts";

const scratch = mkdtempSync(join(tmpdir(), "jig-record-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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
