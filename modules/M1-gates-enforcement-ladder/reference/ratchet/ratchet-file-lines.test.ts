import { describe, expect, test } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { measure } from "./ratchet.ts";
import { repo } from "./ratchet-test-support.ts";

const counter = {
  name: "source-size",
  format: "file-lines" as const,
  limit: 3,
  files: "\\.(ts|tsx)$",
  exclude: "(^|/)(vendor|generated)/",
};
const wiring = { counters: [counter], configs: [] };
const lines = (n: number) => "export {};\n".repeat(n);
function check(r: ReturnType<typeof repo>, expected: number): string {
  const result = r.ratchet();
  expectSpawnExit(
    { exitCode: result.code, stdout: result.out, stderr: "" },
    expected,
  );
  return result.out;
}

describe("source file line ratchet", () => {
  test("counts excess physical lines per file under one rule, excluding prose and declared paths", () => {
    const r = repo(
      {
        "one.ts": lines(5),
        "two.tsx": lines(4).trimEnd(),
        "empty.ts": "",
        "boundary.ts": lines(3),
        "crlf.ts": "x\r\n".repeat(3),
        "notes.md": lines(20),
        "vendor/large.ts": lines(20),
        "generated/large.ts": lines(20),
      },
      wiring,
    );
    // The newline terminating a line does not create another physical line.
    const counts = measure(r.dir, [counter]).get(counter.name)?.ratcheted;
    expect(
      [...(counts ?? [])].map(([rule, files]) => [rule, [...files]]),
    ).toEqual([
      [
        "excess-lines",
        [
          ["one.ts", 2],
          ["two.tsx", 1],
        ],
      ],
    ]);
  });

  test("an unchanged oversized file passes, growth above the limit fails with its path", () => {
    const r = repo({ "large.ts": lines(5) }, wiring);
    check(r, 0);
    r.write("large.ts", lines(6));
    expect(check(r, 1)).toContain("large.ts (2 → 3)");
  });

  test("crossing the threshold adds excess even if the oversized-file count stays the same", () => {
    const r = repo({ "one.ts": lines(5), "two.ts": lines(3) }, wiring);
    r.write("two.ts", lines(4));
    expect(check(r, 1)).toContain("excess-lines: 2 → 3");
  });

  test("new untracked source is checked and staged source is counted once", () => {
    const r = repo({ "one.ts": lines(1) }, wiring);
    r.write("new.ts", lines(5));
    expect(check(r, 1)).toContain("new.ts (0 → 2)");
    r.commit("add oversized source");
    const counts = measure(r.dir, [counter]).get(counter.name)?.ratcheted;
    expect(counts?.get("excess-lines")?.get("new.ts")).toBe(2);
  });

  test("removing exclusions tightens the counter", () => {
    const r = repo({ "vendor/large.ts": lines(5) }, wiring);
    r.write(
      "ratchet.json",
      JSON.stringify({
        ...wiring,
        counters: [{ ...counter, exclude: undefined }],
      }),
    );
    check(r, 0);
  });

  test("splitting an oversized file removes its excess", () => {
    const r = repo({ "large.ts": lines(6) }, wiring);
    r.write("large.ts", lines(3));
    r.write("other.ts", lines(3));
    r.commit("split source");
    expect(check(r, 0)).not.toContain("promote to error");
  });

  test("raising the limit, narrowing scope, adding an exclusion or removing the counter fails at zero", () => {
    for (const changed of [
      { ...counter, limit: 4 },
      { ...counter, files: "^one\\.ts$" },
      { ...counter, exclude: "large" },
      { ...counter, exclude: "" },
      null,
    ]) {
      const r = repo({ "one.ts": lines(1) }, wiring);
      r.write(
        "ratchet.json",
        JSON.stringify({ ...wiring, counters: changed ? [changed] : [] }),
      );
      expect(check(r, 1)).toContain("ratchet wiring: counter source-size");
    }
  });

  test("lowering the limit tightens the rule without requiring a waiver", () => {
    const r = repo({ "large.ts": lines(5) }, wiring);
    r.write(
      "ratchet.json",
      JSON.stringify({ ...wiring, counters: [{ ...counter, limit: 2 }] }),
    );
    check(r, 0);
  });

  test("an invalid threshold or scope is a configuration error", () => {
    for (const changed of [
      { limit: 0 },
      { limit: 1.5 },
      { files: "[" },
      { exclude: "[" },
    ]) {
      const r = repo({ "one.ts": lines(1) }, wiring);
      r.write(
        "ratchet.json",
        JSON.stringify({ ...wiring, counters: [{ ...counter, ...changed }] }),
      );
      check(r, 2);
    }
  });
});
