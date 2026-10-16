import { expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { coverageFindings, parseNames } from "./check-generator-coverage.ts";

const gate = join(import.meta.dir, "check-generator-coverage.ts"),
  fixtures = join(import.meta.dir, "fixtures");
const fixture = (name: string) => join(fixtures, name);

function run(args: string[], stdin?: string) {
  const result = Bun.spawnSync([process.execPath, gate, ...args], {
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
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
  ["existing.txt", "reached-all.txt", 0],
  ["existing-repeated.txt", "reached-all.txt", 0],
  ["existing.txt", "reached-missing-one.txt", 1],
  ["existing.txt", "reached-stale.txt", 1],
  ["existing.txt", "reached-both.txt", 1],
  ["existing.txt", "empty.txt", 2],
  ["empty.txt", "reached-all.txt", 2],
  ["existing.txt", "comments-only.txt", 2],
  ["existing.txt", "no-such-file.txt", 2],
];
for (const [existing, reached, code] of cases)
  test(`${existing} vs ${reached} exits ${code}`, () =>
    expectSpawnExit(run([fixture(existing), fixture(reached)]), code));

test("an unreached input and a stale entry are both findings, naming the generator", () => {
  const result = run([
    "--generator",
    "generate-spec.ts",
    fixture("existing.txt"),
    fixture("reached-both.txt"),
  ]);
  expectSpawnExit(result, 1);
  const lines = result.stderr.trim().split("\n");
  expect(lines).toHaveLength(6);
  expect(lines[0]).toContain(
    'generate-spec.ts does not reach the input "internal-queues"',
  );
  expect(lines[1]).toContain('add "internal-queues" to the inputs');
  expect(lines[2]).toContain('does not reach the input "users"');
  expect(lines[4]).toContain(
    'generate-spec.ts reads the input "reports", which does not exist',
  );
  expect(lines[5]).toContain('remove "reports" from the inputs');
});

test("a pass counts the inputs", () =>
  expect(
    run([fixture("existing.txt"), fixture("reached-all.txt")]).stdout,
  ).toContain("OK — the generator reaches every one of 3 input(s)"));

test("one list may come from standard input, not both", () => {
  expectSpawnExit(
    run([fixture("existing.txt"), "-"], "orders\nusers\ninternal-queues\n"),
    0,
  );
  expectSpawnExit(run([fixture("existing.txt"), "-"], "orders\n"), 1);
  expectSpawnExit(run(["-", "-"]), 2);
});

test("an empty list could not be checked, with the reason", () => {
  const result = run([fixture("existing.txt"), fixture("empty.txt")]);
  expectSpawnExit(result, 2);
  expect(result.stderr).toContain("could not check");
  expect(result.stderr).toContain("holds no name");
});

test("usage errors never pass", () => {
  expectSpawnExit(run([fixture("existing.txt")]), 2);
  expectSpawnExit(
    run(["--bogus", fixture("existing.txt"), fixture("reached-all.txt")]),
    2,
  );
  expectSpawnExit(run(["--generator"]), 2);
});

test("parseNames drops comments, blanks and repeats", () => {
  expect([...parseNames("  a  \nb # why\n\n# only\nb\n")]).toEqual(["a", "b"]);
  expect(parseNames("# nothing\n\n").size).toBe(0);
  expect([...parseNames("route#old\nroute#new # why\n")]).toEqual([
    "route#old",
    "route#new",
  ]);
});

test("coverageFindings reports both directions in name order", () => {
  const findings = coverageFindings(
    new Set(["b", "a"]),
    new Set(["b", "z"]),
    "g",
  );
  expect(findings.map((f) => f.problem)).toEqual([
    'g does not reach the input "a": its output omits it and the freshness check cannot tell',
    'g reads the input "z", which does not exist',
  ]);
  expect(coverageFindings(new Set(["a"]), new Set(["a"]), "g")).toEqual([]);
});

test("a list path that is not a regular file is refused before it is read", () => {
  const result = run([fixture("existing.txt"), import.meta.dir]);
  expectSpawnExit(result, 2);
  expect(result.stderr).toContain("not a regular file");
});
