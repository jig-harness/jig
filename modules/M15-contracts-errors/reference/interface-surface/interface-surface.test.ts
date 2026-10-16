import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../../../plugin/shared/guarded-git-spawn.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  catalogTags,
  internalMarks,
  tagsOf,
} from "./check-no-internal-in-published.ts";
import {
  type Count,
  countContract,
  walkSchema,
} from "./count-unbounded-inputs.ts";
import {
  InputError,
  operations,
  readContract,
  resolvePointer,
} from "./shared.ts";

const dir = import.meta.dir;
const fixtures = join(dir, "fixtures");
const internalGate = join(dir, "check-no-internal-in-published.ts");
const countGate = join(dir, "count-unbounded-inputs.ts");

// Every spawn gets the ambient environment without the variables a hook
// exports to point git at the real repository, a fixed identity, and no
// global or system git configuration, so the scratch repositories below
// are isolated from the machine.
const leaky = new Set<string>(LEAKY_GIT_ENV);
const env: Record<string, string | undefined> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !leaky.has(key.toUpperCase()),
    ),
  ),
  GIT_AUTHOR_NAME: "Jig Test",
  GIT_AUTHOR_EMAIL: "jig-test@example.invalid",
  GIT_COMMITTER_NAME: "Jig Test",
  GIT_COMMITTER_EMAIL: "jig-test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function run(script: string, args: string[], cwd = fixtures) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    stdio: "pipe",
  });
  return {
    exitCode: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const scratch = mkdtempSync(join(tmpdir(), "interface-surface-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A contract written to the scratch directory, its absolute path. */
function contractFile(name: string, doc: unknown): string {
  const path = join(scratch, "contracts", `${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

/** A contract of one `POST /orders` whose request body is `schema`. */
function bodyContract(schema: unknown, components: object = {}) {
  return {
    openapi: "3.1.0",
    info: { title: "Orders", version: "1.0.0" },
    paths: {
      "/orders": {
        post: {
          requestBody: { content: { "application/json": { schema } } },
          responses: { "201": { description: "Created" } },
        },
      },
    },
    components,
  };
}

const internal = (...args: string[]) => run(internalGate, args);
const count = (...args: string[]) => run(countGate, args);

// --- no internal operation in the published contract --------------------

test("a published contract with no internal operation passes", () => {
  const result = internal("published/clean.yaml");
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain("OK — 2 operation(s)");
});

test("each mark of the internal kind is a finding with the operation it marks", () => {
  const result = internal("published/leak.yaml");
  expectSpawnExit(result, 1);
  const findings = result.stderr
    .split("\n")
    .filter((line) => line.includes("[internal-in-published]"));
  expect(findings).toHaveLength(5);
  expect(result.stderr).toContain(
    'GET /jobs is internal (the tag "Jobs (Internal)")',
  );
  expect(result.stderr).toContain(
    "GET /internal/health is internal (a path matching",
  );
  expect(result.stderr).toContain(
    "POST /preview is internal (x-internal: true)",
  );
  expect(result.stderr).toContain(
    "POST /agents/ingest is internal (x-internal: true on its path item)",
  );
  expect(result.stderr).toContain('the tag catalog lists "Jobs (Internal)"');
  expect(result.stderr).not.toContain("GET /orders is internal");
});

test("the marks are options: a tag pattern of its own, and a path pattern", () => {
  expectSpawnExit(internal("--tag", "^Orders$", "published/clean.yaml"), 1);
  expectSpawnExit(internal("--path", "^/orders$", "published/clean.yaml"), 1);
  expectSpawnExit(
    internal(
      "--tag",
      "^Internal$",
      "--path",
      "^/never$",
      "--extension",
      "x-hidden",
      "published/leak.yaml",
    ),
    0,
  );
});

test("tags that are not an array of strings cannot be classified: could not check", () => {
  const result = internal("published/malformed-tags.yaml");
  expectSpawnExit(result, 2);
  expect(result.stderr).toContain(
    "GET /orders: `tags` is not an array of strings",
  );
});

test("a document with no operation, an empty file, and a missing file are could not check", () => {
  expectSpawnExit(internal("published/no-paths.yaml"), 2);
  expectSpawnExit(internal("published/empty.yaml"), 2);
  expectSpawnExit(internal("published/missing.yaml"), 2);
});

test("a bad option, a bad pattern and a bad extension name are could not check", () => {
  expectSpawnExit(internal("--tag", "(", "published/clean.yaml"), 2);
  expectSpawnExit(
    internal("--extension", "internal", "published/clean.yaml"),
    2,
  );
  expectSpawnExit(internal("--nope", "published/clean.yaml"), 2);
  expectSpawnExit(internal(), 2);
  expectSpawnExit(internal("published/clean.yaml", "published/leak.yaml"), 2);
});

test("the classification reads tags, the path and the extension on the operation or its path item", () => {
  const doc = readContract(join(fixtures, "published/leak.yaml"));
  const found = operations(doc);
  const options = {
    tag: /\(Internal\)$/,
    path: /^\/internal(\/|$)/,
    extension: "x-internal",
  };
  const marks = Object.fromEntries(
    found.map((op) => [`${op.method} ${op.path}`, internalMarks(op, options)]),
  );
  expect(marks["GET /orders"]).toEqual([]);
  expect(marks["GET /jobs"]).toEqual(['the tag "Jobs (Internal)"']);
  expect(marks["POST /agents/ingest"]).toEqual([
    "x-internal: true on its path item",
  ]);
  expect(catalogTags(doc)).toEqual(["Orders", "Jobs (Internal)"]);
  const malformed = operations(
    readContract(join(fixtures, "published/malformed-tags.yaml")),
  )[0];
  expect(() => tagsOf(malformed as NonNullable<typeof malformed>)).toThrow(
    "not an array of strings",
  );
});

// --- every request input declares a bound ---------------------------------

test("a contract whose every input is bounded passes, counting the accepted exception", () => {
  const result = count("inputs/bounded.json");
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain(
    "OK — 0 unbounded input field(s) across 2 operation(s)",
  );
  expect(result.stdout).toContain("1 accepted with a reason");
});

test("each unbounded field is a finding at its place, responses are not counted", () => {
  const result = count("inputs/unbounded.yaml");
  expectSpawnExit(result, 1);
  const findings = result.stderr
    .split("\n")
    .filter((line) => line.includes("[unbounded-input]"));
  expect(findings).toHaveLength(8);
  expect(result.stderr).toContain(
    "GET /orders query:q: a string with no maxLength",
  );
  expect(result.stderr).toContain(
    "GET /orders query:page: an integer with no maximum",
  );
  expect(result.stderr).toContain(
    "GET /orders query:ids: an array with no maxItems",
  );
  expect(result.stderr).toContain("GET /orders header:trace: no schema at all");
  expect(result.stderr).toContain(
    "POST /orders body.meta: an object with additionalProperties open",
  );
  expect(result.stderr).toContain("POST /orders body.anything: no type");
  expect(result.stderr).toContain(
    "POST /orders body.lines[].count: a number with no maximum",
  );
  expect(result.stderr).toContain(
    "POST /orders body.raw: x-unbounded carries no reason",
  );
  expect(result.stderr).toContain("the count must not exceed 0");
  expect(result.stderr).toContain(
    "1 field(s) carry x-unbounded without a reason",
  );
});

test("a ceiling holds the count: at it passes, above it fails", () => {
  const loose = contractFile(
    "ceiling",
    bodyContract({
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" }, b: { type: "integer" } },
    }),
  );
  const at = count("--max", "2", loose);
  expectSpawnExit(at, 0);
  expect(at.stdout).toContain("within a ceiling of 2");
  const above = count("--max", "1", loose);
  expectSpawnExit(above, 1);
  expect(above.stderr).toContain("must not exceed a ceiling of 1");
});

test("an exception without a reason fails at any ceiling", () => {
  const result = count("--max", "8", "inputs/unbounded.yaml");
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain(
    "POST /orders body.raw: x-unbounded carries no reason",
  );
  expect(result.stderr).not.toContain("must not exceed");
  expect(result.stderr).not.toContain("GET /orders query:q");
  const blank = contractFile(
    "blank-reason",
    bodyContract({ type: "string", "x-unbounded": "  " }),
  );
  expectSpawnExit(count("--max", "100", blank), 1);
});

test("a reference the gate cannot follow, a bad ceiling and a bad option are could not check", () => {
  const dangling = count("inputs/dangling-ref.yaml");
  expectSpawnExit(dangling, 2);
  expect(dangling.stderr).toContain("a reference to nothing");
  expectSpawnExit(count("--max", "many", "inputs/bounded.json"), 2);
  expectSpawnExit(count("--nope", "inputs/bounded.json"), 2);
  expectSpawnExit(count("inputs/missing.yaml"), 2);
});

test("the schema walk follows local references once, so a recursive schema ends", () => {
  const doc = readContract(join(fixtures, "inputs/bounded.json"));
  const total: Count = { unbounded: [], accepted: 0, invalid: [] };
  walkSchema(
    doc,
    { $ref: "#/components/schemas/OrderPatch" },
    "body",
    total,
    "x-unbounded",
  );
  expect(total).toEqual({ unbounded: [], accepted: 1, invalid: [] });
  expect(resolvePointer(doc, "#/components/schemas/Pickup")).toHaveProperty(
    "properties.store.maxLength",
    16,
  );
});

/** The places of the unbounded fields `schema` holds, in `doc`. */
function unboundedIn(schema: unknown, doc: Record<string, unknown> = {}) {
  const total: Count = { unbounded: [], accepted: 0, invalid: [] };
  walkSchema({ paths: {}, ...doc }, schema, "f", total, "x-unbounded");
  return total.unbounded.map((f) => `${f.location}: ${f.problem}`);
}

test("every non-null type of a type list is bounded; a oneOf or anyOf part is judged with the keywords around it", () => {
  expect(unboundedIn({ type: ["string", "null"] })).toEqual([
    "f: a string with no maxLength, pattern, format or enum",
  ]);
  expect(unboundedIn({ type: ["null", "integer"], maximum: 3 })).toEqual([]);
  expect(unboundedIn({ type: ["boolean", "string"] })).toEqual([
    "f: a string with no maxLength, pattern, format or enum",
  ]);
  expect(unboundedIn({ type: ["string", "integer"], maxLength: 3 })).toEqual([
    "f: an integer with no maximum, exclusiveMaximum or enum",
  ]);
  expect(
    unboundedIn({
      anyOf: [{ type: "string", maxLength: 3 }, { type: "number" }],
    }),
  ).toEqual([
    "f<anyOf[1]>: a number with no maximum, exclusiveMaximum or enum",
  ]);
  const alternatives = { anyOf: [{ pattern: "^a" }, { pattern: "^b" }] };
  expect(
    unboundedIn({ allOf: [{ type: "string", maxLength: 5 }, alternatives] }),
  ).toEqual([]);
  expect(unboundedIn({ type: "string", ...alternatives })).toEqual([]);
  expect(
    unboundedIn({
      maxLength: 5,
      oneOf: [{ type: "string" }, { type: "null" }],
    }),
  ).toEqual([]);
  expect(
    unboundedIn({ type: "string", oneOf: [{ pattern: "^a" }, true] }),
  ).toEqual([
    "f<oneOf[1]>: a string with no maxLength, pattern, format or enum",
  ]);
  expect(
    unboundedIn({ type: "string", oneOf: [{ pattern: "^a" }, false] }),
  ).toEqual([]);
});

test("the keywords beside a recursive reference are still walked", () => {
  const doc = {
    components: {
      schemas: {
        Node: {
          type: "object",
          properties: {
            next: {
              $ref: "#/components/schemas/Node",
              properties: { extra: { type: "string" } },
            },
          },
        },
      },
    },
  };
  const open =
    "f: an object with additionalProperties open (neither false nor a schema)";
  expect(unboundedIn({ $ref: "#/components/schemas/Node" }, doc)).toEqual([
    "f.next.extra: a string with no maxLength, pattern, format or enum",
    open,
  ]);
  expect(
    unboundedIn(
      {
        allOf: [
          { $ref: "#/components/schemas/Node" },
          { properties: { tail: { type: "integer" } } },
        ],
      },
      doc,
    ),
  ).toEqual([
    "f.next.extra: a string with no maxLength, pattern, format or enum",
    "f.tail: an integer with no maximum, exclusiveMaximum or enum",
    open,
  ]);
});

test("a reference met again beside itself at one field is judged, not taken for recursion", () => {
  const doc = {
    components: { schemas: { Text: { type: "string" } } },
  };
  const text = { $ref: "#/components/schemas/Text" };
  expect(
    unboundedIn({ ...text, anyOf: [{ maxLength: 10 }, text] }, doc),
  ).toEqual([
    "f<anyOf[1]>: a string with no maxLength, pattern, format or enum",
  ]);
  expect(
    unboundedIn(
      { ...text, anyOf: [{ maxLength: 10 }, { ...text, maxLength: 3 }] },
      doc,
    ),
  ).toEqual([]);
});

test("a reference absorbed beside a parent is not recursion in the parent's fields", () => {
  const doc = {
    components: {
      schemas: {
        Audited: { type: "object", properties: { by: { type: "string" } } },
      },
    },
  };
  const audited = { $ref: "#/components/schemas/Audited" };
  expect(
    unboundedIn(
      {
        allOf: [
          audited,
          {
            additionalProperties: false,
            properties: {
              child: { allOf: [audited, { additionalProperties: false }] },
            },
          },
        ],
      },
      doc,
    ),
  ).toEqual([
    "f.by: a string with no maxLength, pattern, format or enum",
    "f.child.by: a string with no maxLength, pattern, format or enum",
  ]);
});

test("each oneOf or anyOf group holds: a value satisfies one alternative of every group", () => {
  expect(
    unboundedIn({
      type: "string",
      allOf: [
        { anyOf: [{ maxLength: 5 }, { maxLength: 10 }] },
        { anyOf: [{}, { pattern: "^x$" }] },
      ],
    }),
  ).toEqual([]);
  expect(
    unboundedIn({
      type: "string",
      oneOf: [{ maxLength: 5 }, {}],
      anyOf: [{}, { description: "any" }],
    }),
  ).toEqual([
    "f<oneOf[1]><anyOf[0]>: a string with no maxLength, pattern, format or enum",
  ]);
});

test("a field reached through several alternatives is one finding", () => {
  const shared = {
    type: "object",
    additionalProperties: false,
    properties: { q: { type: "string" } },
  };
  const once = [
    "f<anyOf[0]>.q: a string with no maxLength, pattern, format or enum",
  ];
  expect(
    unboundedIn({
      ...shared,
      anyOf: [{ description: "a" }, { description: "b" }],
    }),
  ).toEqual(once);
  expect(
    unboundedIn({
      ...shared,
      anyOf: [{ description: "a" }, { description: "b" }, { description: "c" }],
    }),
  ).toEqual(once);
  expect(
    unboundedIn({ anyOf: [{ type: "string" }, { type: "number" }] }),
  ).toEqual([
    "f<anyOf[0]>: a string with no maxLength, pattern, format or enum; at f<anyOf[1]>: a number with no maximum, exclusiveMaximum or enum",
  ]);
});

test("two fields that render alike are two findings", () => {
  const string = { type: "string" };
  // The property `a.b`, and the property `b` inside `a`.
  expect(
    unboundedIn({
      type: "object",
      additionalProperties: false,
      properties: {
        "a.b": string,
        a: {
          type: "object",
          additionalProperties: false,
          properties: { b: string },
        },
      },
    }),
  ).toHaveLength(2);
  // Two property names that look like alternative labels.
  expect(
    unboundedIn({
      type: "object",
      additionalProperties: false,
      properties: { "a<1>": string, "a<2>": string },
    }),
  ).toHaveLength(2);
});

test("alternatives that multiply past the budget stop the walk", () => {
  const group = { anyOf: [{ maxLength: 1 }, { maxLength: 2 }] };
  expect(() =>
    unboundedIn({ type: "string", allOf: Array(30).fill(group) }),
  ).toThrow("100000 steps");
  // A few groups are judged in full.
  expect(unboundedIn({ type: "string", allOf: Array(4).fill(group) })).toEqual(
    [],
  );
});

test("references that expand each other twice per level stop the walk", () => {
  /** `S0` is a bounded string; each `Si` is the intersection of two `S(i-1)`. */
  const chain = (levels: number) => {
    const schemas: Record<string, unknown> = {
      S0: { type: "string", maxLength: 8 },
    };
    for (let i = 1; i <= levels; i++) {
      const previous = { $ref: `#/components/schemas/S${i - 1}` };
      schemas[`S${i}`] = { allOf: [previous, previous] };
    }
    return { components: { schemas } };
  };
  const top = (levels: number) => ({
    $ref: `#/components/schemas/S${levels}`,
  });
  expect(() => unboundedIn(top(30), chain(30))).toThrow("100000 steps");
  // A few levels are expanded in full.
  expect(unboundedIn(top(4), chain(4))).toEqual([]);
});

test("an object is bounded only when its additional properties are closed or bounded", () => {
  const named = { a: { type: "boolean" } };
  const open =
    "f: an object with additionalProperties open (neither false nor a schema)";
  expect(unboundedIn({ type: "object", properties: named })).toEqual([open]);
  expect(
    unboundedIn({
      type: "object",
      properties: named,
      additionalProperties: true,
    }),
  ).toEqual([open]);
  expect(
    unboundedIn({
      type: "object",
      properties: named,
      additionalProperties: false,
    }),
  ).toEqual([]);
  expect(
    unboundedIn({ type: "object", additionalProperties: { type: "string" } }),
  ).toEqual(["f.*: a string with no maxLength, pattern, format or enum"]);
});

test("allOf is one intersection: a bound in any part, or beside them, bounds the field", () => {
  expect(
    unboundedIn({ allOf: [{ type: "string" }, { maxLength: 5 }] }),
  ).toEqual([]);
  expect(unboundedIn({ allOf: [{ type: "string" }], pattern: "^a$" })).toEqual(
    [],
  );
  expect(
    unboundedIn({
      allOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { properties: { a: { maxLength: 3 } }, additionalProperties: false },
      ],
    }),
  ).toEqual([]);
  expect(
    unboundedIn({ allOf: [{ type: "string" }, { description: "a name" }] }),
  ).toEqual(["f: a string with no maxLength, pattern, format or enum"]);
  expect(
    unboundedIn({ allOf: [{ type: "string" }, { type: "integer" }] }),
  ).toEqual([]);
});

test("a reference is read together with the keywords beside it", () => {
  const doc = {
    components: {
      schemas: {
        Text: { type: "string" },
        Shape: { type: "object", additionalProperties: false },
      },
    },
  };
  expect(
    unboundedIn({ $ref: "#/components/schemas/Text", maxLength: 10 }, doc),
  ).toEqual([]);
  expect(
    unboundedIn(
      {
        $ref: "#/components/schemas/Shape",
        properties: { extra: { type: "string" } },
      },
      doc,
    ),
  ).toEqual(["f.extra: a string with no maxLength, pattern, format or enum"]);
  const total: Count = { unbounded: [], accepted: 0, invalid: [] };
  walkSchema(
    { paths: {}, ...doc },
    { $ref: "#/components/schemas/Text", "x-unbounded": "an opaque token" },
    "f",
    total,
    "x-unbounded",
  );
  expect(total).toEqual({ unbounded: [], accepted: 1, invalid: [] });
});

test("a false schema accepts nothing and is bounded; a true schema and no schema are not", () => {
  expect(unboundedIn(false)).toEqual([]);
  expect(
    unboundedIn({
      type: "object",
      properties: { never: false },
      additionalProperties: false,
    }),
  ).toEqual([]);
  expect(unboundedIn({ allOf: [{ type: "string" }, false] })).toEqual([]);
  expect(unboundedIn(true)).toEqual([
    "f: a `true` schema, which accepts anything",
  ]);
  expect(unboundedIn(undefined)).toEqual(["f: no schema at all"]);
});

test("a keyword present in a shape the gate cannot read is could not check", () => {
  const unreadable = [
    { type: "string", maxLength: null },
    { type: "string", maxLength: -1 },
    { type: "number", maximum: null },
    { type: "array", maxItems: "many", items: false },
    { enum: null },
    { enum: [] },
    { type: "string", pattern: "" },
    { type: "string", pattern: "(" },
    { type: "string", format: "" },
    { allOf: [] },
    { oneOf: {} },
    { type: "file" },
    { type: [] },
    { type: "object", properties: [] },
    { type: "object", additionalProperties: "no" },
    { $ref: 7 },
    {
      type: "array",
      maxItems: 1,
      prefixItems: [{ type: "string" }],
      items: false,
    },
    { type: "object", additionalProperties: false, patternProperties: {} },
    { type: "object", unevaluatedProperties: true },
    null,
    "string",
  ];
  for (const schema of unreadable)
    expect(() => unboundedIn(schema)).toThrow(InputError);
  const result = count(
    contractFile(
      "null-bound",
      bodyContract({ type: "string", maxLength: null }),
    ),
  );
  expectSpawnExit(result, 2);
  expect(result.stderr).toContain("`maxLength` is not a non-negative integer");
});

/** A contract of one `GET /orders` operation with `fields` added to it. */
function operationContract(fields: object, pathFields: object = {}) {
  return {
    openapi: "3.1.0",
    paths: {
      "/orders": {
        ...pathFields,
        get: { ...fields, responses: { "200": { description: "ok" } } },
      },
    },
  };
}

test("a request container present in a shape the gate cannot read is could not check", () => {
  const limit = {
    name: "limit",
    in: "query",
    schema: { type: "integer", maximum: 9 },
  };
  const unreadable = [
    operationContract({ parameters: { limit } }),
    operationContract({}, { parameters: "limit" }),
    operationContract({ parameters: [limit, limit] }),
    operationContract({ parameters: [{ in: "query", schema: {} }] }),
    operationContract({ parameters: [{ name: "a", in: "body" }] }),
    operationContract({
      parameters: [{ name: "a", in: "query", content: {} }],
    }),
    operationContract({
      parameters: [{ name: "a", in: "query", content: { "a/b": 1 } }],
    }),
    operationContract({ requestBody: "a body" }),
    operationContract({ requestBody: {} }),
    operationContract({ requestBody: { content: {} } }),
    operationContract({ requestBody: { content: [] } }),
    operationContract({ requestBody: { content: { "application/json": 1 } } }),
  ];
  for (const doc of unreadable)
    expect(() => countContract(doc, "x-unbounded")).toThrow(InputError);
  const overridden = countContract(
    operationContract(
      { parameters: [limit] },
      { parameters: [{ ...limit, schema: { type: "integer" } }] },
    ),
    "x-unbounded",
  );
  expect(overridden.unbounded).toEqual([]);
  const result = count(
    contractFile("twice", operationContract({ parameters: [limit, limit] })),
  );
  expectSpawnExit(result, 2);
  expect(result.stderr).toContain("query:limit is declared twice");
});

test("a path item reference is read by both gates; one the gate cannot read is could not check", () => {
  const hidden = {
    openapi: "3.1.0",
    paths: {
      "x-generator": { name: "a generator" },
      "/hidden": { $ref: "#/components/pathItems/Hidden" },
    },
    components: {
      pathItems: {
        Hidden: {
          "x-internal": true,
          get: {
            parameters: [
              { name: "q", in: "query", schema: { type: "string" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    },
  };
  expect(operations(hidden).map((op) => `${op.method} ${op.path}`)).toEqual([
    "GET /hidden",
  ]);
  const file = contractFile("path-item-ref", hidden);
  const leak = internal(file);
  expectSpawnExit(leak, 1);
  expect(leak.stderr).toContain(
    "GET /hidden is internal (x-internal: true on its path item)",
  );
  const loose = count(file);
  expectSpawnExit(loose, 1);
  expect(loose.stderr).toContain("GET /hidden query:q: a string");

  const unreadable = [
    { paths: { "/a": { $ref: "#/components/pathItems/Missing" } } },
    { paths: { "/a": { $ref: "other.yaml#/Orders" } } },
    { paths: { "/a": { $ref: "#/paths/~1a" } } },
    { paths: { "/a": "an item" } },
    { paths: { "/a": { get: "an operation" } } },
    {
      paths: { "/a": { $ref: "#/components/pathItems/A", get: {} } },
      components: { pathItems: { A: { get: {} } } },
    },
  ];
  for (const doc of unreadable)
    expect(() => operations(doc)).toThrow(InputError);
  expectSpawnExit(
    internal(contractFile("dangling-path-item", unreadable[0])),
    2,
  );
});

// --- the count against the merge base -------------------------------------

const BOUNDED = `openapi: 3.1.0
info: { title: Orders, version: "1.0.0" }
paths:
  /orders:
    get:
      parameters:
        - { name: limit, in: query, schema: { type: integer, maximum: 100 } }
      responses: { "200": { description: ok } }
`;
const ONE_LOOSE = BOUNDED.replace(
  "{ type: integer, maximum: 100 }",
  "{ type: integer }",
);
const TWO_LOOSE = ONE_LOOSE.replace(
  "      responses:",
  "        - { name: q, in: query, schema: { type: string } }\n      responses:",
);

/**
 * A scratch repository: `main` holds `base` (a contract, or none), and
 * `feature` branches from it and holds `head`.
 */
function scenario(name: string, base: string | null, head: string): string {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, env, stdio: "pipe" });
    expectSpawnExit(
      { exitCode: result.status, stdout: result.stdout, stderr: result.stderr },
      0,
      `git ${args.join(" ")}`,
    );
  };
  const commit = (content: string, message: string) => {
    const path = join(root, "api/openapi.yaml");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    git("add", "-A");
    // Allowed empty: a head identical to its base is one of the scenarios.
    git("commit", "-q", "--allow-empty", "-m", message);
  };
  git("init", "-q", "-b", "main");
  if (base === null) {
    writeFileSync(join(root, "README.md"), "a repository\n");
    git("add", "-A");
    git("commit", "-q", "-m", "start");
  } else commit(base, "the contract");
  git("checkout", "-q", "-b", "feature");
  commit(head, "the change");
  return root;
}

test("against the base, a count that stays or falls passes and one that rises fails", () => {
  const same = scenario("same", ONE_LOOSE, ONE_LOOSE);
  const stays = run(countGate, ["--base", "main", "api/openapi.yaml"], same);
  expectSpawnExit(stays, 0);
  expect(stays.stdout).toContain("1 unbounded input field(s)");
  expect(stays.stdout).toContain("within 1 at the base");

  const fell = scenario("fell", ONE_LOOSE, BOUNDED);
  expectSpawnExit(
    run(countGate, ["--base", "main", "api/openapi.yaml"], fell),
    0,
  );

  const rose = scenario("rose", ONE_LOOSE, TWO_LOOSE);
  const result = run(countGate, ["--base", "main", "api/openapi.yaml"], rose);
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("GET /orders query:q");
  expect(result.stderr).toContain("must not exceed 1 at the base");
});

test("--repo points at the repository, and the ceiling and the base both hold", () => {
  const root = scenario("both", ONE_LOOSE, ONE_LOOSE);
  const ok = count(
    "--repo",
    root,
    "--base",
    "main",
    "--max",
    "1",
    "api/openapi.yaml",
  );
  expectSpawnExit(ok, 0);
  expect(ok.stdout).toContain("within 1 at the base and a ceiling of 1");
  expectSpawnExit(
    count("--repo", root, "--base", "main", "--max", "0", "api/openapi.yaml"),
    1,
  );
});

test("a contract absent at the base, a base that names no commit, and a path outside the repository are could not check", () => {
  const fresh = scenario("fresh", null, ONE_LOOSE);
  const absent = run(countGate, ["--base", "main", "api/openapi.yaml"], fresh);
  expectSpawnExit(absent, 2);
  expect(absent.stderr).toContain("absent at the merge base");
  expect(absent.stderr).toContain("use --max");

  const noCommit = run(
    countGate,
    ["--base", "nowhere", "api/openapi.yaml"],
    fresh,
  );
  expectSpawnExit(noCommit, 2);
  expect(noCommit.stderr).toContain("no merge base");

  const outside = run(
    countGate,
    ["--base", "main", join(fixtures, "inputs/bounded.json")],
    fresh,
  );
  expectSpawnExit(outside, 2);
  expect(outside.stderr).toContain("outside the repository");
});
