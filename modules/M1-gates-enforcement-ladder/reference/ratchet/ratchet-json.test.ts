import { describe, expect, test } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { parseCountsJson } from "./ratchet.ts";
import {
  defaultWiring,
  expectApproved,
  repo,
  todoCounter,
} from "./ratchet-test-support.ts";

// A counting command: every "X" in a tracked Markdown file, per file, under
// the rule "x". Skipping a file stands in for a check that finds less.
const countScript = `
import { readFileSync } from "node:fs";
const skip = process.argv[2] === "--skip" ? process.argv[3] : undefined;
const files = Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard", "*.md"])
  .stdout.toString().split("\\n").filter((f) => f && f !== skip);
const x = {};
for (const f of files) {
  const n = (readFileSync(f, "utf8").match(/X/g) ?? []).length;
  if (n) x[f] = n;
}
console.log(JSON.stringify({ counts: { x } }));
`;
const counter = {
  name: "authoring",
  format: "json",
  command: [process.execPath, "count.ts"],
  per: "file",
};
const wiring = (c: object = counter) => ({
  ...defaultWiring,
  counters: [c],
  support: ["count.ts"],
});
const base = { "count.ts": countScript, "a.md": "X X\n", "b.md": "none\n" };

function check(r: ReturnType<typeof repo>, expected: number): string {
  const result = r.ratchet();
  expectSpawnExit(
    { exitCode: result.code, stdout: result.out, stderr: "" },
    expected,
  );
  return result.out;
}

describe("a counting command's JSON", () => {
  test("rule → file → count is read, zero counts dropped", () => {
    const counts = parseCountsJson(
      JSON.stringify({ counts: { x: { "a.md": 2, "b.md": 0 }, y: {} } }),
    );
    expect([...counts].map(([rule, files]) => [rule, [...files]])).toEqual([
      ["x", [["a.md", 2]]],
    ]);
  });

  test("anything but a counts object of whole numbers is refused", () => {
    for (const text of [
      "{}",
      '{"counts":[]}',
      '{"counts":{"x":[1]}}',
      '{"counts":{"x":{"a.md":1.5}}}',
      '{"counts":{"x":{"a.md":-1}}}',
      '{"counts":{"x":{"a.md":"1"}}}',
    ])
      expect(() => parseCountsJson(text)).toThrow();
  });
});

describe("a json counter compared per file", () => {
  test("growth in one file fails and names it", () => {
    const r = repo(base, wiring());
    check(r, 0);
    r.write("b.md", "X\n");
    expect(check(r, 1)).toContain("b.md (0 → 1)");
  });

  test("moving a finding to another file fails per file, and passes on totals", () => {
    const moved = { "a.md": "X\n", "b.md": "X\n" };
    const perFile = repo(base, wiring());
    for (const [path, text] of Object.entries(moved)) perFile.write(path, text);
    perFile.commit("move");
    expect(check(perFile, 1)).toContain("authoring x: 2 → 2");
    const totals = repo(base, wiring({ ...counter, per: undefined }));
    for (const [path, text] of Object.entries(moved)) totals.write(path, text);
    totals.commit("move");
    check(totals, 0);
  });

  test("a rule brought to zero passes without asking for a promotion", () => {
    const r = repo(base, wiring());
    r.write("a.md", "none\n");
    r.commit("fix");
    expect(check(r, 0)).not.toContain("promote to error");
  });

  test("a counter new in this change is measured in the base with the head's command", () => {
    const r = repo({ "a.md": "X X\n" });
    r.write("count.ts", countScript);
    r.write(
      "ratchet.json",
      JSON.stringify({ ...wiring(), counters: [todoCounter, counter] }),
    );
    r.commit("wire the counter");
    check(r, 0);
    r.write("a.md", "X X X\n");
    expect(check(r, 1)).toContain("a.md (2 → 3)");
  });

  test("the base is measured with RATCHET_HISTORICAL=1, so a folder it predates can count as none", () => {
    // Refuses a missing input unless it measures a merge base.
    const strictScript = `
import { existsSync } from "node:fs";
if (!existsSync("docs") && process.env.RATCHET_HISTORICAL !== "1") process.exit(2);
console.log(JSON.stringify({ counts: {} }));
`;
    const r = repo({ "a.md": "none\n" });
    r.write("count.ts", strictScript);
    r.write("docs/a.md", "none\n");
    r.write(
      "ratchet.json",
      JSON.stringify({ ...wiring(), counters: [todoCounter, counter] }),
    );
    r.commit("add docs and their counter together");
    check(r, 0);
  });

  test("a command that fails or prints no counts could not be checked", () => {
    for (const script of [
      "process.exit(3);\n",
      "console.log('{}');\n",
      "console.log('not json');\n",
    ]) {
      const r = repo({ ...base, "count.ts": script }, wiring());
      check(r, 2);
    }
  });

  test("dropping per-file comparison from the wiring fails without a trailer", () => {
    const r = repo(base, wiring());
    r.write(
      "ratchet.json",
      JSON.stringify(wiring({ ...counter, per: undefined })),
    );
    r.commit("compare totals");
    const out = check(r, 1);
    expect(out).toContain("ratchet wiring: counter authoring");
    expectApproved(r, out);
  });

  test("a head command that finds less in the base fails without a trailer", () => {
    const r = repo(base, wiring());
    r.write(
      "count.ts",
      countScript.replace(
        'const skip = process.argv[2] === "--skip" ? process.argv[3] : undefined;',
        'const skip = "a.md";',
      ),
    );
    r.commit("the check skips a file");
    const out = check(r, 1);
    expect(out).toContain(
      "authoring x a.md: 2 → 0 in the base under this change's configuration",
    );
    expectApproved(r, out);
  });

  test("a head command that moves the base's findings to another file fails without a trailer", () => {
    const r = repo({ ...base, "b.md": "X\n" }, wiring());
    r.write(
      "count.ts",
      countScript.replace(
        "if (n) x[f] = n;",
        'if (n) x["a.md"] = (x["a.md"] ?? 0) + n;',
      ),
    );
    r.commit("the check charges every finding to a.md");
    const out = check(r, 1);
    expect(out).toContain(
      "authoring x b.md: 1 → 0 in the base under this change's configuration",
    );
    expectApproved(r, out);
  });
});
