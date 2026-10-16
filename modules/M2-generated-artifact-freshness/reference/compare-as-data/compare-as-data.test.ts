import { expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { differences, firstUnfaithful, parseData } from "./compare-as-data.ts";

const gate = join(import.meta.dir, "compare-as-data.ts"),
  fixtures = join(import.meta.dir, "fixtures");
const fixture = (name: string) => join(fixtures, name);

function run(args: string[]) {
  const result = Bun.spawnSync([process.execPath, gate, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const cases: [string, string, number][] = [
  ["committed.json", "fresh-reformatted.json", 0],
  ["committed.json", "fresh-same.yaml", 0],
  ["fresh-same.yaml", "committed.json", 0],
  ["committed.json", "fresh-differs.json", 1],
  ["committed.json", "not-json.json", 2],
  ["committed.json", "empty.json", 2],
  ["committed.json", "fresh.txt", 2],
  ["committed.json", "no-such-file.json", 2],
  ["comments-only.yaml", "comments-only.yaml", 2],
  ["marker-only.yaml", "marker-only.yaml", 2],
  ["bom-marker.yaml", "bom-marker.yaml", 2],
  ["null.yaml", "null.yaml", 0],
  ["date-a.yaml", "date-b.yaml", 1],
  ["date-a.yaml", "date-a.yaml", 0],
  ["committed.json", ".", 2],
];
for (const [committed, fresh, code] of cases)
  test(`${committed} vs ${fresh} exits ${code}`, () =>
    expectSpawnExit(run([fixture(committed), fixture(fresh)]), code));

test("every difference is named by its path, with the regenerate command as the fix", () => {
  const result = run([
    "--command",
    "bun tools/generate-spec.ts",
    fixture("committed.json"),
    fixture("fresh-differs.json"),
  ]);
  expectSpawnExit(result, 1);
  const lines = result.stderr.trim().split("\n");
  expect(lines).toHaveLength(6);
  expect(lines[0]).toContain(
    '$.info.version: "1.0.0" committed, "1.1.0" fresh',
  );
  expect(lines[1]).toContain(
    "regenerate it with bun tools/generate-spec.ts; never edit it to match",
  );
  expect(lines[2]).toContain(
    "$.paths./orders.get.tags: a list of 1 committed, 2 fresh",
  );
  expect(lines[4]).toContain(
    "$.paths./reports: fresh has it, committed does not",
  );
});

test("a pass names both files", () =>
  expect(
    run([fixture("committed.json"), fixture("fresh-reformatted.json")]).stdout,
  ).toContain("encode the same data"));

test("an unparsable or empty file could not be checked, with the reason", () => {
  const broken = run([fixture("committed.json"), fixture("not-json.json")]);
  expectSpawnExit(broken, 2);
  expect(broken.stderr).toContain(
    "could not check: cannot parse the fresh file",
  );
  const empty = run([fixture("empty.json"), fixture("committed.json")]);
  expectSpawnExit(empty, 2);
  expect(empty.stderr).toContain("the committed file");
  expect(empty.stderr).toContain("is empty");
});

test("usage errors never pass", () => {
  expectSpawnExit(run([fixture("committed.json")]), 2);
  expectSpawnExit(
    run(["--bogus", fixture("committed.json"), fixture("fresh-same.yaml")]),
    2,
  );
  expectSpawnExit(run(["--command"]), 2);
});

test("parseData reads either syntax by extension and refuses others", () => {
  expect(parseData('{"a": 1}', "x.json")).toEqual({ a: 1 });
  expect(parseData("a: 1\n", "x.yml")).toEqual({ a: 1 });
  expect(() => parseData("a: 1", "x.txt")).toThrow("not .json, .yaml or .yml");
});

test("differences ignores key order and names kinds, lengths, missing and extra keys", () => {
  expect(differences({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toEqual([]);
  expect(differences({ a: 1 }, { a: "1" })).toEqual([
    "$.a: number committed, string fresh",
  ]);
  expect(differences({ a: [1] }, { a: [1, 2] })).toEqual([
    "$.a: a list of 1 committed, 2 fresh",
  ]);
  expect(differences({ a: { b: null } }, { a: {} })).toEqual([
    "$.a.b: committed has it, fresh does not",
  ]);
  expect(differences({}, { c: true })).toEqual([
    "$.c: fresh has it, committed does not",
  ]);
  expect(differences([1, { x: 2 }], [1, { x: 3 }])).toEqual([
    "$[1].x: 2 committed, 3 fresh",
  ]);
  expect(differences({ a: Number.NaN }, { a: Number.NaN })).toEqual([]);
  expect(differences({ a: Number.NaN }, { a: 1 })).toEqual([
    "$.a: NaN committed, 1 fresh",
  ]);
});

test("a list of another length still names every changed shared element", () => {
  expect(differences({ a: [1, 2] }, { a: [1, 3, 4] })).toEqual([
    "$.a: a list of 2 committed, 3 fresh",
    "$.a[1]: 2 committed, 3 fresh",
  ]);
});

test("an integer past 2^53 cannot be compared faithfully", () => {
  expect(firstUnfaithful({ ids: [1, 9007199254740992] })).toContain(
    "the integer at $.ids[1] is past 2^53",
  );
  expect(firstUnfaithful({ id: 9007199254740991, x: 1.5 })).toBeUndefined();
  expect(() => parseData('{"id":9007199254740993}', "b.json")).toThrow(
    "the integer at $.id is past 2^53",
  );
  expect(() => parseData("id: 9007199254740993", "b.yaml")).toThrow(
    "the integer 9007199254740993 is past 2^53",
  );
  const lossy = run([fixture("big-a.json"), fixture("big-b.json")]);
  expectSpawnExit(lossy, 2);
  expect(lossy.stderr).toContain("the integer at $.id is past 2^53");
});

test("a mapping key past 2^53 is refused before it becomes a string", () => {
  expect(() => parseData("9007199254740992: x", "a.yaml")).toThrow(
    "the integer 9007199254740992 is past 2^53",
  );
  expect(() => parseData("? [9007199254740993]\n: x", "a.yaml")).toThrow(
    "is past 2^53",
  );
  expect(parseData("9007199254740991: x", "a.yaml")).toEqual({
    "9007199254740991": "x",
  });
  const lossy = run([fixture("big-key-a.yaml"), fixture("big-key-b.yaml")]);
  expectSpawnExit(lossy, 2);
  expect(lossy.stderr).toContain("is past 2^53");
});

test("a text with no document parses to undefined, an explicit null or tag to a value", () => {
  for (const text of [
    "# only a comment\n",
    "---\n",
    "\uFEFF---\n",
    "%YAML 1.2\n---\n...\n",
  ])
    expect(parseData(text, "a.yaml")).toBeUndefined();
  expect(parseData("~", "a.yaml")).toBeNull();
  expect(parseData("--- !!null\n", "a.yaml")).toBeNull();
  expect(parseData("--- !!str\n", "a.yaml")).toBe("");
});

test("a list or a mapping used as a mapping key is refused", () => {
  for (const text of [
    "? [a, b]\n: x",
    "? {a: 1}\n: x",
    "[a, b]: x",
    "list: &k [a, b]\n? *k\n: x",
    "? &k [a]\n: x\nagain: *k",
    "outer:\n  ? {a: 1}\n  : x",
    "- ? [a]\n  : x",
    "&a { ? *a : x }",
    "&a\n? *a\n: x",
    "outer: &a\n  ? *a\n  : x",
  ])
    expect(() => parseData(text, "a.yaml")).toThrow(
      "which parsing turns into a string",
    );
  expect(parseData("list: &k [a, b]\nagain: *k\n'a,b': x", "a.yaml")).toEqual({
    list: ["a", "b"],
    again: ["a", "b"],
    "a,b": "x",
  });
  for (const [text, data] of [
    ["{a: 1}", { a: 1 }],
    ["[1, 2]", [1, 2]],
    ["--- !!map {a: [b]}", { a: ["b"] }],
    ["a:\n  {b: 1}\nc:\n  [d]", { a: { b: 1 }, c: ["d"] }],
    ["- {a: 1}\n- [b]", [{ a: 1 }, ["b"]]],
    ["? a\n: {b: [c]}", { a: { b: ["c"] } }],
    ["a: &k {b: 1}\nc:\n  *k", { a: { b: 1 }, c: { b: 1 } }],
  ] as const)
    expect(parseData(text, "a.yaml")).toEqual(data);
  expect(parseData("1: x\nnested: {m: [{n: []}]}", "a.yaml")).toEqual({
    "1": "x",
    nested: { m: [{ n: [] }] },
  });
});

test("a number past the range of a double is refused, and YAML's own infinity is not", () => {
  expect(() => parseData('{"n":[1,1e400]}', "a.json")).toThrow(
    "the number at $.n[1] is past the range of a double",
  );
  expect(() => parseData("n: -1e400", "a.yaml")).toThrow(
    "the number -1e400 is past the range of a double",
  );
  expect(() => parseData(`n: ${"9".repeat(400)}`, "a.yml")).toThrow(
    "is past the range of a double",
  );
  expect(() => parseData("n: !!float 2e400", "a.yaml")).toThrow(
    "the number 2e400 is past the range of a double",
  );
  expect(parseData("n: .inf\nm: -.Inf\nk: .NaN\nx: 0x1F", "a.yaml")).toEqual({
    n: Number.POSITIVE_INFINITY,
    m: Number.NEGATIVE_INFINITY,
    k: Number.NaN,
    x: 31,
  });
  const result = run([fixture("overflow-a.json"), fixture("overflow-b.json")]);
  expectSpawnExit(result, 2);
  expect(result.stderr).toContain("is past the range of a double");
});

test("a path that is not a regular file is refused before it is read", () => {
  const result = run([fixture("committed.json"), fixtures]);
  expectSpawnExit(result, 2);
  expect(result.stderr).toContain("not a regular file");
});
