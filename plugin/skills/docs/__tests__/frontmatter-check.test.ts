import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkFrontmatter,
  readSchema,
} from "../scripts/frontmatter-check/frontmatter-check";

const fixtures = join(import.meta.dir, "fixtures", "frontmatter-check");
const schema = join(fixtures, "schema.yaml");
// Temporary documents and schemas go outside the repository: other suites walk
// every file in it, and a file deleted between their listing and their read
// fails them.
const scratch = mkdtempSync(join(tmpdir(), "frontmatter-check-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(
  args: string[],
  options: {
    newDocs?: string;
    schema?: string;
    cwd?: string;
    env?: Record<string, string>;
  } = {},
) {
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(
        import.meta.dir,
        "../scripts/frontmatter-check/frontmatter-check.ts",
      ),
      ...args,
    ],
    {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        SCHEMA: options.schema ?? schema,
        NEW_DOCS: options.newDocs ?? "",
        ...options.env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return { code: result.exitCode, out: result.stdout.toString() };
}
const fix = (path: string) => join(fixtures, path);

const cases: [number, string, string[], string?][] = [
  [0, "valid architecture + adr docs pass", ["good/caching.md", "good/adr.md"]],
  [
    1,
    "bad enums/date/tags fail",
    ["bad/broken.md"],
    "did you mean 'approved'?",
  ],
  [
    1,
    "adr missing decision_date fails",
    ["bad/adr-missing.md"],
    "adr missing required field: decision_date",
  ],
  [
    1,
    "adr with an empty decision_date fails; ~ is a value only for supersession",
    ["bad/adr-empty-date.md"],
    "adr missing required field: decision_date",
  ],
  [
    1,
    "an ADR with a blank supersedes fails; only ~ means none",
    ["bad/adr-blank-supersedes.md"],
    "adr missing required field: supersedes",
  ],
  [
    1,
    "a date that is not on the calendar fails",
    ["bad/impossible-date.md"],
    "last_updated '2026-02-30' is not a YYYY-MM-DD date",
  ],
  [1, "missing frontmatter fails", ["bad/nofm.md"], "no frontmatter"],
  [0, "no-description doc passes when not new", ["good/nodesc.md"]],
  [
    0,
    "block-sequence tags, quoted '#', comments and a folded scalar pass",
    ["good/block-forms.md"],
  ],
];
for (const [want, label, files, output] of cases) {
  test(label, () => {
    const result = run(files.map(fix));
    expect(result.code).toBe(want);
    if (output) expect(result.out).toContain(output);
  });
}

test("only the generated index at its configured path is left out", () => {
  const index = join(import.meta.dir, "fixtures", "index", "docs", "INDEX.md");
  expect(run([index], { env: { OUT: index } }).code).toBe(0);
  // The same file is an ordinary document when the index is configured elsewhere.
  expect(run([index]).out).toContain("no frontmatter");
  const copied = join(scratch, "copied-marker.md");
  const moved = join(scratch, "moved-marker.md");
  writeFileSync(copied, readFileSync(index, "utf8"));
  writeFileSync(moved, `# Notes\n\n${readFileSync(index, "utf8")}`);
  try {
    // An authored document opening with the marker is checked like any other.
    expect(run([copied], { env: { OUT: index } }).out).toContain(
      "no frontmatter",
    );
    expect(run([moved], { env: { OUT: moved } }).out).toContain(
      "no frontmatter",
    );
  } finally {
    rmSync(copied, { force: true });
    rmSync(moved, { force: true });
  }
});

test("no-description doc fails when NEW", () => {
  const file = fix("good/nodesc.md");
  const result = run([file], { newDocs: file });
  expect(result.code).toBe(1);
  expect(result.out).toContain("new doc missing required field: description");
});

test("NEW_DOCS holds one path per line, so a name may contain spaces", () => {
  const spaced = join(scratch, "new doc.md");
  writeFileSync(spaced, readFileSync(fix("good/nodesc.md")));
  try {
    const files = [fix("good/caching.md"), spaced];
    const result = run(files, { newDocs: files.join("\n") });
    expect(result.code).toBe(1);
    expect(result.out).toContain("new doc missing required field: description");
    expect(result.out).not.toContain("is not among the files checked");
  } finally {
    rmSync(spaced, { force: true });
  }
});

test("a NEW_DOCS entry that names no checked file fails", () => {
  const files = [fix("good/caching.md"), fix("good/nodesc.md")];
  const result = run(files, { newDocs: files.join(" ") });
  expect(result.code).toBe(1);
  expect(result.out).toContain("is not among the files checked");
});

test("constructs outside the YAML subset are violations, with their line", () => {
  const result = run([fix("bad/subset.md")]);
  expect(result.code).toBe(1);
  expect(result.out).toContain(
    "unsupported YAML: line 2: anchors and aliases are not supported",
  );
  expect(result.out).toContain(
    "unsupported YAML: line 5: duplicate key 'status'",
  );
  expect(result.out).toContain(
    "unsupported YAML: line 10: a plain value cannot continue on the next line",
  );
  // An unreadable title is absent, so the required check reports it too.
  expect(result.out).toContain("missing required field: title");
});

const rules = fix("rules-schema.yaml");
const inFixtures = { cwd: fixtures, schema: rules };

test("the template's example path rules are commented out", () => {
  // Live, they would fail any tree without docs/runbooks/ and docs/archive/.
  const result = run([fix("good/caching.md")]);
  expect(result.code).toBe(0);
});

test("path rules: a conforming runbook passes, a fenced TODO is not a violation", () => {
  const result = run(
    ["docs/runbooks/restart-cache.md", "docs/archive/old-plan.md"],
    inFixtures,
  );
  expect(result.out).toContain("OK — frontmatter valid");
  expect(result.code).toBe(0);
});

test("path rules: required field, narrowed enum and body pattern are enforced", () => {
  const result = run(["docs/runbooks/rotate-keys.md"], inFixtures);
  expect(result.code).toBe(1);
  expect(result.out).toContain(
    "missing required field: service (path rule 'runbooks-name-their-service')",
  );
  expect(result.out).toContain(
    "type 'guide' is not allowed here (allowed: runbook)",
  );
  expect(result.out).toContain(
    "line 14: a runbook carries no TODO placeholder (pattern 'no-todo', path rule 'runbooks-name-their-service')",
  );
});

test("path rules: an archive document must be archived", () => {
  const result = run(["docs/archive/still-active.md"], inFixtures);
  expect(result.code).toBe(1);
  expect(result.out).toContain(
    "status 'active' is not allowed here (allowed: archived) (path rule 'archive-holds-archived-docs')",
  );
  expect(result.out).toContain("lifecycle 'permanent' is not allowed here");
});

test("path rules do not apply outside their prefix", () => {
  // A draft guide: both rules would reject it under their prefixes.
  const result = run(["good/block-forms.md"], inFixtures);
  expect(result.code).toBe(0);
});

test("a prefix that matches no document in the tree fails the check", () => {
  const typo = join(scratch, "typo-schema.yaml");
  writeFileSync(
    typo,
    readFileSync(rules, "utf8").replace("[docs/archive/]", "[docs/archvie/]"),
  );
  try {
    // Named files alone match the other rule; the tree on disk is still checked.
    const result = run(["docs/runbooks/restart-cache.md"], {
      cwd: fixtures,
      schema: typo,
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      "rule 'archive-holds-archived-docs': path 'docs/archvie/' matches no document in the tree",
    );
  } finally {
    rmSync(typo, { force: true });
  }
});

test("a path rule that cannot be evaluated fails the check (fail closed)", () => {
  const result = run(["docs/archive/old-plan.md"], {
    cwd: fixtures,
    schema: fix("rules-broken.yaml"),
  });
  expect(result.code).toBe(1);
  expect(result.out).toContain("the schema cannot be used as written");
  expect(result.out).toContain(
    "rule 'bad-pattern': forbidden_body_patterns[0] pattern does not compile",
  );
  expect(result.out).toContain(
    "rule 'widens': allowed_values 'status' lists 'retired'",
  );
  expect(result.out).toContain("rule 'typo-key': unknown key 'alowed_values'");
  expect(result.out).toContain(
    "rule 'typo-key': path './docs/archive/' is not a normalised repository-relative prefix",
  );
});

test("every YAML spelling of a schema list is enforced, flow form and trailing comment alike", () => {
  const flow = join(scratch, "flow-schema.yaml");
  writeFileSync(
    flow,
    readFileSync(schema, "utf8").replace(
      /^required:\n(?: {2}- .*\n)+/m,
      "required: [title, type] # every doc\n",
    ),
  );
  try {
    const result = run([fix("bad/nofm.md"), fix("good/caching.md")], {
      schema: flow,
    });
    expect(result.out).not.toContain("flow-schema.yaml");
    const missingTitle = join(scratch, "untitled.md");
    writeFileSync(
      missingTitle,
      readFileSync(fix("good/caching.md"), "utf8").replace(/^title:.*\n/m, ""),
    );
    try {
      const untitled = run([missingTitle], { schema: flow });
      expect(untitled.code).toBe(1);
      expect(untitled.out).toContain("missing required field: title");
    } finally {
      rmSync(missingTitle, { force: true });
    }
  } finally {
    rmSync(flow, { force: true });
  }
});

test("a schema section of the wrong shape fails the run instead of dropping its check", () => {
  const odd = join(scratch, "odd-schema.yaml");
  writeFileSync(
    odd,
    readFileSync(schema, "utf8").replace(
      /^required:\n/m,
      "required: title\nformer_required:\n",
    ),
  );
  try {
    const result = run([fix("good/caching.md")], { schema: odd });
    expect(result.code).toBe(1);
    expect(result.out).toContain("'required' must be a list of names");
  } finally {
    rmSync(odd, { force: true });
  }
});

test("a schema that is not valid YAML fails the run", () => {
  const broken = join(scratch, "broken-schema.yaml");
  writeFileSync(broken, "required: [title\n");
  try {
    const result = run([fix("good/caching.md")], { schema: broken });
    expect(result.code).toBe(1);
    expect(result.out).toContain("schema is not valid YAML");
  } finally {
    rmSync(broken, { force: true });
  }
});

test("without its YAML parser the checker refuses rather than reading the schema another way", async () => {
  const missing = async () => {
    throw new Error("shared/vendor/js-yaml.mjs did not load");
  };
  await expect(readSchema(schema, missing)).rejects.toThrow("did not load");
});

test("a missing schema exits 2", () => {
  const result = run([fix("good/caching.md")], { schema: fix("no-such.yaml") });
  expect(result.code).toBe(2);
});

test("checkFrontmatter returns its exit code to the caller", async () => {
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    expect(
      await checkFrontmatter([fix("good/caching.md")], { SCHEMA: schema }),
    ).toBe(0);
    expect(
      await checkFrontmatter([fix("bad/broken.md")], { SCHEMA: schema }),
    ).toBe(1);
  } finally {
    log.mockRestore();
  }
});

test("an explicit null section is a schema error, not an omitted one", () => {
  const nulled = join(scratch, "null-schema.yaml");
  const text = readFileSync(schema, "utf8");
  const variants: [RegExp, string, string][] = [
    [/^required:\n/m, "required: null\nformer_required:\n", "'required'"],
    [/^required_new:.*$/m, "required_new: null", "'required_new'"],
    [
      /^type_specific:\n/m,
      "type_specific: null\nformer_type_specific:\n",
      "'type_specific'",
    ],
    [/^ {2}adr:\n/m, "  adr: null\n  former_adr:\n", "'type_specific.adr'"],
  ];
  try {
    for (const [pattern, replacement, section] of variants) {
      expect(text).toMatch(pattern);
      writeFileSync(nulled, text.replace(pattern, replacement));
      const result = run([fix("good/caching.md")], { schema: nulled });
      expect(result.code).toBe(1);
      expect(result.out).toContain(section);
    }
  } finally {
    rmSync(nulled, { force: true });
  }
});

test("a value YAML loads as an object but not a mapping is a schema error", () => {
  const dated = join(scratch, "dated-schema.yaml");
  const text = readFileSync(schema, "utf8");
  const variants: [RegExp, string, string][] = [
    [
      /^type_specific:\n/m,
      "type_specific: 2026-01-01\nformer_type_specific:\n",
      "'type_specific'",
    ],
    [
      /^ {2}suggestions:\n/m,
      "  suggestions: 2026-01-01\n  former:\n",
      ".suggestions'",
    ],
  ];
  try {
    for (const [pattern, replacement, section] of variants) {
      expect(text).toMatch(pattern);
      writeFileSync(dated, text.replace(pattern, replacement));
      const result = run([fix("good/caching.md")], { schema: dated });
      expect(result.code).toBe(1);
      expect(result.out).toContain(section);
    }
  } finally {
    rmSync(dated, { force: true });
  }
});

test("a schema that cannot be read exits 2, not as a schema violation", () => {
  const result = run([fix("good/caching.md")], { schema: fixtures });
  expect(result.code).toBe(2);
});
