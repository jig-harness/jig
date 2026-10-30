/** Small units: the explanation, the terminal colours, the read limiter, git's output. */
import { describe, expect, test } from "bun:test";
import { total } from "../scripts/lib/aggregate.ts";
import { createLimiter } from "../scripts/lib/analyze.ts";
import { explainText } from "../scripts/lib/explain.ts";
import { gitFailure, parseLsFiles } from "../scripts/lib/git.ts";
import { type FileStats, KINDS } from "../scripts/lib/model.ts";
import {
  columnWidth,
  terminalReport,
  useColour,
  visible,
} from "../scripts/lib/render-terminal.ts";

const stats = (over: Partial<FileStats> = {}): FileStats => ({
  path: "notes/todo.unknown",
  area: "production",
  kind: "other",
  language: "unknown",
  module: "notes",
  areaMatched: false,
  bytes: 10,
  rawLines: 1,
  blankLines: 0,
  commentLines: 0,
  codeLines: 1,
  ...over,
});

describe("explainText", () => {
  const rule = { value: "x", rule: "r" };
  const explain = (over: Partial<FileStats>) =>
    explainText(
      {
        stats: stats(over),
        classification: {
          area: rule,
          areaMatched: over.areaMatched ?? false,
          kind: { value: over.kind ?? "other", rule: "r" },
          language: rule,
          module: rule,
        },
      },
      false,
    );

  test("names both reasons when a file is unclassified for both", () => {
    expect(explain({})).toContain(
      "Unclassified: no kind rule matched, and no area rule matched.",
    );
    expect(explain({ kind: "code" })).toContain(
      "Unclassified: no area rule matched.",
    );
    expect(explain({ areaMatched: true })).toContain(
      "Unclassified: no kind rule matched.",
    );
  });
});

describe("terminal colours", () => {
  const report = (colour: boolean) =>
    terminalReport({
      repository: "shop",
      date: "2026-01-01",
      areas: ["production"],
      defaultArea: "production",
      kinds: KINDS,
      files: [stats()],
      vendoredExcluded: total([]),
      includeVendored: false,
      missing: 0,
      unreadable: [],
      topModules: 15,
      htmlCommand: "bun code-stats.ts --html",
      colour,
    });

  test("are written only when asked for", () => {
    expect(report(true)).toContain("\x1b[");
    expect(report(false)).not.toContain("\x1b[");
  });

  test("groups by the original names, so names that print alike stay apart", () => {
    const out = terminalReport({
      repository: "shop",
      date: "2026-01-01",
      areas: ["production"],
      defaultArea: "production",
      kinds: KINDS,
      files: [
        stats({ kind: "code", module: "a\nb", codeLines: 3 }),
        stats({ kind: "code", module: "a\\nb", codeLines: 5 }),
      ],
      vendoredExcluded: total([]),
      includeVendored: false,
      missing: 0,
      unreadable: [],
      topModules: 15,
      htmlCommand: "bun code-stats.ts --html",
      colour: false,
    });
    const rows = out.split("\n").filter((l) => l.startsWith("a\\nb "));
    expect(rows).toHaveLength(2);
  });

  test("sizes a column over more labels than a call can take arguments", () => {
    const labels = Array.from({ length: 1_000_000 }, (_, i) => `m${i}`);
    expect(columnWidth(labels, 40)).toBe(40);
    expect(columnWidth(["x".repeat(50)], 40)).toBe(52);
  });

  test("are asked for only on a terminal without NO_COLOR", () => {
    expect(useColour(true, {})).toBe(true);
    expect(useColour(false, {})).toBe(false);
    expect(useColour(true, { NO_COLOR: "1" })).toBe(false);
    expect(useColour(true, { NO_COLOR: "" })).toBe(true);
  });
});

describe("visible", () => {
  test("writes C0, DEL and C1 control characters as escapes, and nothing else", () => {
    expect(visible("a\x1b[2J\rb\x85c\x7f\td")).toBe(
      "a\\u001b[2J\\rb\\u0085c\\u007f\\td",
    );
    expect(visible("plain/é\\path")).toBe("plain/é\\path");
  });
});

describe("createLimiter", () => {
  test("never lets more than its limit run at once", async () => {
    const limit = createLimiter(2);
    let running = 0;
    let peak = 0;
    const job = () =>
      limit(async () => {
        running++;
        peak = Math.max(peak, running);
        await Promise.resolve();
        await Promise.resolve();
        running--;
        return running;
      });
    await Promise.all(Array.from({ length: 9 }, job));
    expect(peak).toBe(2);
  });

  test("a job arriving while a waiter wakes does not share its slot", async () => {
    // Arrive at each microtask depth after the first job ends, so one lands
    // between the slot's release and the woken waiter taking it.
    for (let depth = 0; depth < 8; depth++) {
      const limit = createLimiter(1);
      let running = 0;
      let peak = 0;
      const job = async () => {
        running++;
        peak = Math.max(peak, running);
        for (let i = 0; i < 4; i++) await Promise.resolve();
        running--;
      };
      let release: () => void = () => undefined;
      const first = limit(() => new Promise<void>((r) => (release = r)));
      const second = limit(job);
      let late: Promise<void> = Promise.resolve();
      let chain = Promise.resolve();
      for (let i = 0; i < depth; i++) chain = chain.then(() => undefined);
      const arrived = chain.then(() => {
        late = limit(job);
      });
      release();
      await Promise.all([first, second, arrived]);
      await late;
      expect([depth, peak]).toEqual([depth, 1]);
    }
  });

  test("releases its slot when the job throws", async () => {
    const limit = createLimiter(1);
    await expect(
      limit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await limit(async () => 7)).toBe(7);
  });
});

describe("git", () => {
  test("one ls-files -s listing gives the paths and the submodules", () => {
    const out = [
      "100644 aaaa 0\tsrc/a.ts",
      "160000 bbbb 0\tdeps/lib",
      "120000 cccc 0\tlink",
      "",
    ].join("\0");
    const listing = parseLsFiles(out);
    expect(listing.paths).toEqual(["src/a.ts", "deps/lib", "link"]);
    expect([...listing.submodules]).toEqual(["deps/lib"]);
  });

  test("a file in a merge conflict, listed once per stage, is counted once", () => {
    const out = [
      "100644 1111111111111111111111111111111111111111 1\tsrc/a.ts",
      "100644 2222222222222222222222222222222222222222 2\tsrc/a.ts",
      "100644 3333333333333333333333333333333333333333 3\tsrc/a.ts",
      "100644 4444444444444444444444444444444444444444 0\tsrc/b.ts",
      "",
    ].join("\0");
    expect(parseLsFiles(out).paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("an output cap overflow says so", () => {
    const base = {
      code: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      spawnFailed: false,
      stderrTail: "",
    };
    expect(
      gitFailure(["ls-files"], { ...base, bufferExceeded: true }).message,
    ).toContain("printed more than the 64 MiB");
    expect(
      gitFailure(["ls-files"], {
        ...base,
        bufferExceeded: false,
        stderr: "fatal: x",
      }).message,
    ).toBe("git ls-files failed (exit 1): fatal: x");
  });
});
