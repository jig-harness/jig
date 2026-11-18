/**
 * The conflict rates under the dispatch state directory: their reader, which
 * gives each path its rate or the default and says when every rate is at
 * its default, and the daily refresh after the act phase, which runs
 * `history.ts --rates` under a deadline and keeps the previous file whenever
 * the run does not end with a whole new one.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoFromMs, parseMs } from "../../shared/time.ts";
import {
  DEFAULT_FILE_RATE,
  MIN_OBSERVED,
  ratesPaths,
  readConflictRates,
  STALE_AFTER_MS,
} from "../lib/conflict-rates.ts";
import {
  eligibleTargets,
  REFRESH_DEADLINE_MS,
  REFRESH_EVERY_MS,
  type RunHistory,
  refreshConflictRates,
} from "../lib/conflict-rates-refresh.ts";

const SLUG = "acme/widgets";
const NOW = parseMs("2026-11-18T12:00:00Z");
const HOUR = 3_600_000;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dispatch-conflict-rates-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function rates(generatedAt: number, paths: unknown[]): string {
  return `${JSON.stringify({
    schema: "merge-conflict-rates/v1",
    generatedAt: isoFromMs(generatedAt),
    repository: SLUG,
    range: { since: null, until: null, label: "the last 30 days" },
    paths,
  })}\n`;
}

function place(text: string): string {
  const { rates: file } = ratesPaths(SLUG, root);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

describe("the conflict rates' reader", () => {
  it("gives a path observed in enough merged pull requests its share that conflicted, and the default below that", () => {
    place(
      rates(NOW - HOUR, [
        { path: "src/hot.ts", merged: 8, conflicted: 6, unknown: 1 },
        {
          path: "src/cold.ts",
          merged: MIN_OBSERVED,
          conflicted: 0,
          unknown: 0,
        },
        {
          path: "src/new.ts",
          merged: MIN_OBSERVED - 1,
          conflicted: 0,
          unknown: 3,
        },
      ]),
    );
    const read = readConflictRates(SLUG, NOW, root);
    expect(read.defaulted).toBeNull();
    expect(read.rate("src/hot.ts")).toBe(0.75);
    expect(read.rate("src/cold.ts")).toBe(0);
    expect(read.rate("src/new.ts")).toBe(DEFAULT_FILE_RATE);
    expect(read.rate("src/never.ts")).toBe(DEFAULT_FILE_RATE);
    expect(read.observed("src/hot.ts")).toBe(8);
    expect(read.observed("src/never.ts")).toBe(0);
    expect(read.generatedAt).toBe(isoFromMs(NOW - HOUR));
  });

  it("puts every rate at its default, and says why, when there is no file", () => {
    const read = readConflictRates(SLUG, NOW, root);
    expect(read.defaulted).toContain("no conflict rates");
    expect(read.defaulted).toContain(
      `every path's rate is the default ${DEFAULT_FILE_RATE}`,
    );
    expect(read.rate("src/hot.ts")).toBe(DEFAULT_FILE_RATE);
  });

  it("puts every rate at its default, and says why, when the file is stale", () => {
    place(
      rates(NOW - STALE_AFTER_MS - 1, [
        { path: "src/hot.ts", merged: 8, conflicted: 8, unknown: 0 },
      ]),
    );
    const read = readConflictRates(SLUG, NOW, root);
    expect(read.defaulted).toContain("stale");
    expect(read.rate("src/hot.ts")).toBe(DEFAULT_FILE_RATE);
  });

  it("puts every rate at its default when the file does not read", () => {
    place("{ not json");
    const read = readConflictRates(SLUG, NOW, root);
    expect(read.defaulted).toContain("does not read");
    expect(read.rate("src/hot.ts")).toBe(DEFAULT_FILE_RATE);
  });
});

/** A fake `history.ts --rates` run: what it was asked, and what it does. */
function fake(
  act: (out: string) => { code: number; stderr?: string; timedOut?: boolean },
): {
  run: RunHistory;
  calls: { argv: string[]; timeoutSec: number; cwd: string }[];
} {
  const calls: { argv: string[]; timeoutSec: number; cwd: string }[] = [];
  const run: RunHistory = async (argv, opts) => {
    calls.push({ argv, timeoutSec: opts.timeoutSec, cwd: opts.cwd });
    const out = argv[argv.indexOf("--out") + 1] as string;
    const r = act(out);
    return {
      code: r.code,
      stderr: r.stderr ?? "",
      timedOut: r.timedOut ?? false,
    };
  };
  return { run, calls };
}

const target = { slug: SLUG, path: "/checkouts/widgets" };

describe("the daily refresh of the conflict rates", () => {
  it("runs the rates over the window and puts the new file in place", async () => {
    const { run, calls } = fake((out) => {
      writeFileSync(
        out,
        rates(NOW, [{ path: "a", merged: 5, conflicted: 1, unknown: 0 }]),
      );
      return { code: 0 };
    });
    const r = await refreshConflictRates(target, {
      nowMs: NOW,
      deadlineMs: undefined,
      root,
      run,
    });
    expect(r).toEqual({ slug: SLUG, outcome: "written" });
    expect(calls).toHaveLength(1);
    const argv = calls[0]?.argv ?? [];
    expect(argv).toContain("--rates");
    expect(
      argv.slice(argv.indexOf("--days"), argv.indexOf("--days") + 2),
    ).toEqual(["--days", "30"]);
    expect(argv[argv.indexOf("--cohort-cache") + 1]).toBe(
      ratesPaths(SLUG, root).cohort,
    );
    expect(calls[0]?.cwd).toBe(target.path);
    expect(calls[0]?.timeoutSec).toBe(REFRESH_DEADLINE_MS / 1000);
    expect(readConflictRates(SLUG, NOW, root).rate("a")).toBe(0.2);
  });

  it("refreshes at most once a day, whatever the last attempt's outcome", async () => {
    const { run, calls } = fake(() => ({ code: 3, stderr: "history: cut" }));
    const first = await refreshConflictRates(target, {
      nowMs: NOW,
      deadlineMs: undefined,
      root,
      run,
    });
    expect(first.outcome).toBe("kept");
    const again = await refreshConflictRates(target, {
      nowMs: NOW + REFRESH_EVERY_MS - 1,
      deadlineMs: undefined,
      root,
      run,
    });
    expect(again.outcome).toBe("skipped");
    expect(calls).toHaveLength(1);
    const later = await refreshConflictRates(target, {
      nowMs: NOW + REFRESH_EVERY_MS,
      deadlineMs: undefined,
      root,
      run,
    });
    expect(later.outcome).toBe("kept");
    expect(calls).toHaveLength(2);
  });

  it("keeps the previous file when the run errs or its cohort is incomplete, and the reader says so", async () => {
    const previous = place(
      rates(NOW - HOUR, [{ path: "a", merged: 5, conflicted: 5, unknown: 0 }]),
    );
    const { run } = fake((out) => {
      writeFileSync(out, "half");
      return {
        code: 3,
        stderr:
          "history: the merged pull requests did not read in full (cut)\n",
      };
    });
    const r = await refreshConflictRates(target, {
      nowMs: NOW,
      deadlineMs: undefined,
      root,
      run,
    });
    expect(r.outcome).toBe("kept");
    if (r.outcome !== "kept") return;
    expect(r.reason).toContain("did not read in full");
    expect(readFileSync(previous, "utf8")).toContain('"conflicted":5');
    expect(existsSync(`${previous}.next`)).toBe(false);
    const read = readConflictRates(SLUG, NOW, root);
    expect(read.rate("a")).toBe(1);
    expect(read.lastRefresh).toMatchObject({ outcome: "kept" });
  });

  it("keeps the previous file when the run passes its deadline, however much it wrote", async () => {
    const previous = place(
      rates(NOW - HOUR, [{ path: "a", merged: 5, conflicted: 5, unknown: 0 }]),
    );
    const { run, calls } = fake((out) => {
      writeFileSync(
        out,
        rates(NOW, [{ path: "a", merged: 5, conflicted: 0, unknown: 0 }]),
      );
      return { code: 124, timedOut: true };
    });
    // The tick's own deadline is nearer than the refresh's: the run gets what is left of it.
    const r = await refreshConflictRates(target, {
      nowMs: NOW,
      deadlineMs: NOW + 120_000,
      root,
      run,
    });
    expect(calls[0]?.timeoutSec).toBe(120);
    expect(r.outcome).toBe("kept");
    if (r.outcome !== "kept") return;
    expect(r.reason).toContain("deadline");
    expect(readFileSync(previous, "utf8")).toContain('"conflicted":5');
  });

  it("keeps the previous file when the run writes one that does not read", async () => {
    const { run } = fake((out) => {
      writeFileSync(out, "{}");
      return { code: 0 };
    });
    const r = await refreshConflictRates(target, {
      nowMs: NOW,
      deadlineMs: undefined,
      root,
      run,
    });
    expect(r.outcome).toBe("kept");
    expect(existsSync(ratesPaths(SLUG, root).rates)).toBe(false);
  });

  it("starts no run when the tick has too little time left, and leaves it due", async () => {
    const { run, calls } = fake(() => ({ code: 0 }));
    const r = await refreshConflictRates(target, {
      nowMs: NOW,
      deadlineMs: NOW + 1000,
      root,
      run,
    });
    expect(r.outcome).toBe("skipped");
    expect(calls).toHaveLength(0);
    expect(existsSync(ratesPaths(SLUG, root).refresh)).toBe(false);
  });

  it("refreshes only the repositories an applying tick launches pickups for", () => {
    const repos = [
      {
        slug: "a/one",
        path: "/one",
        listed: true,
        stages: ["pickup", "rearm"],
      },
      { slug: "a/two", path: "/two", listed: true, stages: ["rearm"] },
      { slug: "a/three", path: "/three", listed: false, stages: ["pickup"] },
    ];
    expect(eligibleTargets(repos, true)).toEqual([
      { slug: "a/one", path: "/one" },
    ]);
    expect(eligibleTargets(repos, false)).toEqual([]);
  });
});
