/**
 * process-cwd.ts: a process listing is an answer only when it is complete.
 * Errors that name a process which ended are accepted, and so is one whose
 * working directory its owner cannot read because it holds privileges its
 * owner lacks; any other error, an ordinary process whose directory cannot
 * be read included, makes the listing no answer.
 */
import { describe, expect, test } from "bun:test";
import {
  cwdHolders,
  holdersIn,
  parseCwdListing,
  scanCwds,
  type AsyncProbeRun,
  type ProbeRun,
} from "../process-cwd.ts";
import type { RunResult } from "../orca-workspace/runner.ts";

const TOP = "/w/holder";
const result = (status: number, stdout: string, stderr = ""): RunResult => ({
  status,
  stdout,
  stderr,
});
const statusFile = (permitted: string) =>
  result(0, `Name:\tx\nCapInh:\t0\nCapPrm:\t${permitted}\nCapEff:\t0\n`);

/** A runner answering the listing with `listing`, and each `cat /proc/<pid>/status` from `statuses`. */
function runner(
  listing: RunResult,
  statuses: Record<string, RunResult> = {},
): { run: ProbeRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: ProbeRun = (argv, cwd) => {
    calls.push(argv);
    if (argv[0] === "sh") {
      expect(cwd).toBe("/");
      return listing;
    }
    const pid = /^\/proc\/(\d+)\/status$/.exec(argv[1] ?? "")?.[1] ?? "";
    return (
      statuses[pid] ??
      result(1, "", `cat: ${argv[1]}: No such file or directory`)
    );
  };
  return { run, calls };
}

describe("parseCwdListing", () => {
  test("reads /proc's lines and lsof's fields, matching the tree and what is under it only", () => {
    expect(
      parseCwdListing(
        "/proc/1\t/\n/proc/2\t/w/holder\n/proc/3\t/w/holder/sub\n/proc/4\t/w/holder-2\n/proc/5\t\n",
        TOP,
      ),
    ).toEqual({ pids: ["2", "3"], unread: ["5"], partial: [] });
    expect(
      parseCwdListing("p10\nfcwd\nn/w/holder/x\np11\nfcwd\nn/w/other\n", TOP),
    ).toEqual({ pids: ["10"], unread: [], partial: [] });
  });
});

describe("parseCwdListing lsof escapes", () => {
  test("matches a tree whose name lsof printed with byte escapes", () => {
    expect(
      parseCwdListing(
        "p10\nfcwd\nn/w/caf\\xc3\\xa9/x\np11\nfcwd\nn/w/other\n",
        "/w/café",
      ),
    ).toEqual({ pids: ["10"], unread: [], partial: [] });
  });
});

describe("parseCwdListing lsof control characters", () => {
  test.each([
    ["C escape", "/w/my\\ttree/x", "/w/my\ttree"],
    ["caret notation", "/w/my^Itree/x", "/w/my\ttree"],
    ["literal caret", "/w/my^Itree/x", "/w/my^Itree"],
    ["doubled backslash", "/w/a\\\\b/x", "/w/a\\b"],
  ])("matches a name printed with a %s", (_label, printed, top) => {
    expect(parseCwdListing(`p10\nfcwd\nn${printed}\n`, top)).toEqual({
      pids: ["10"],
      unread: [],
      partial: [],
    });
  });

  test("leaves a different tree alone", () => {
    expect(parseCwdListing("p10\nfcwd\nn/w/my^Itree/x\n", "/w/other")).toEqual({
      pids: [],
      unread: [],
      partial: [],
    });
  });
});

describe("cwdHolders", () => {
  test("answers from a clean listing", () => {
    const { run } = runner(result(0, "/proc/1\t/\n/proc/2\t/w/holder/a\n"));
    expect(cwdHolders(run, TOP)).toEqual({ pids: ["2"] });
  });

  test("is no answer when lsof gave only part of a name, as `/ -- work/holder`", () => {
    const { run } = runner(result(0, "p7\nfcwd\nn/ -- work/holder\n"));
    expect(cwdHolders(run, TOP)).toEqual({
      unknown:
        "lsof gave only part of a working directory's name (/ -- work/holder)",
    });
  });

  test("accepts exit 1 when every error names a process that ended", () => {
    const { run } = runner(
      result(
        1,
        "/proc/1\t/\n",
        "find: '/proc/77': No such file or directory\nfind: '/proc/78/cwd': No such file or directory\n",
      ),
    );
    expect(cwdHolders(run, TOP)).toEqual({ pids: [] });
  });

  test("accepts a process that exits while find visits its task directory", () => {
    const { run } = runner(
      result(1, "/proc/1\t/\n", "find: '/proc/77/task': No such process\n"),
    );
    expect(cwdHolders(run, TOP)).toEqual({ pids: [] });
    const denied = runner(
      result(1, "/proc/1\t/\n", "find: '/proc/77/cwd': Permission denied\n"),
      {
        "77": result(1, "", "cat: /proc/77/status: No such process"),
      },
    );
    expect(cwdHolders(denied.run, TOP)).toEqual({ pids: [] });
  });

  test("accepts a denied process that holds privileges its owner lacks, or ended since", () => {
    const { run, calls } = runner(
      result(1, "/proc/1\t/\n", "find: '/proc/42/cwd': Permission denied\n"),
      { "42": statusFile("0000000800000000") },
    );
    expect(cwdHolders(run, TOP)).toEqual({ pids: [] });
    expect(calls).toContainEqual(["cat", "/proc/42/status"]);
    const gone = runner(
      result(1, "/proc/1\t/\n", "find: '/proc/43/cwd': Permission denied\n"),
    );
    expect(cwdHolders(gone.run, TOP)).toEqual({ pids: [] });
  });

  test("is no answer when an ordinary process's directory cannot be read", () => {
    const denied = runner(
      result(1, "/proc/1\t/\n", "find: '/proc/42/cwd': Permission denied\n"),
      { "42": statusFile("0000000000000000") },
    );
    expect(cwdHolders(denied.run, TOP)).toEqual({
      unknown: "process 42's working directory cannot be read",
    });
    const blank = runner(result(0, "/proc/1\t/\n/proc/9\t\n"), {
      "9": result(1, "", "cat: /proc/9/status: Permission denied"),
    });
    expect(cwdHolders(blank.run, TOP)).toEqual({
      unknown: "process 9's working directory and status cannot be read",
    });
  });

  test("is no answer for any other error, a failed listing or an empty one", () => {
    expect(
      cwdHolders(
        runner(result(1, "/proc/1\t/\n", "find: memory exhausted\n")).run,
        TOP,
      ),
    ).toEqual({ unknown: "find: memory exhausted" });
    expect(
      cwdHolders(runner(result(2, "", "lsof: not found\n")).run, TOP),
    ).toEqual({
      unknown: "the process listing failed (exit 2): lsof: not found",
    });
    expect(cwdHolders(runner(result(0, "")).run, TOP)).toEqual({
      unknown: "the process listing failed (exit 0): no output",
    });
  });
});

describe("scanCwds and holdersIn", () => {
  const trees = ["/w/holder", "/w/other", "/w/holder-2", "/w/caf\u00e9"];
  const cases: [string, RunResult, Record<string, RunResult>][] = [
    [
      "a clean /proc listing",
      result(0, "/proc/1\t/\n/proc/2\t/w/holder/a\n/proc/3\t/w/other\n"),
      {},
    ],
    [
      "an lsof listing with escaped names and a partial one",
      result(0, "p10\nfcwd\nn/w/caf\\xc3\\xa9/x\np11\nfcwd\nn/w/holder\n"),
      {},
    ],
    ["a partial lsof name", result(0, "p7\nfcwd\nn/ -- work/holder\n"), {}],
    [
      "a denied process with privileges its owner lacks",
      result(1, "/proc/1\t/\n", "find: '/proc/42/cwd': Permission denied\n"),
      { "42": statusFile("0000000800000000") },
    ],
    [
      "a denied ordinary process",
      result(1, "/proc/1\t/\n", "find: '/proc/42/cwd': Permission denied\n"),
      { "42": statusFile("0000000000000000") },
    ],
    [
      "an unreadable directory whose status cannot be read",
      result(0, "/proc/1\t/\n/proc/9\t\n"),
      { "9": result(1, "", "cat: /proc/9/status: Permission denied") },
    ],
    [
      "an error that is no answer",
      result(1, "/proc/1\t/\n", "find: boom\n"),
      {},
    ],
    ["a failed listing", result(2, "", "lsof: not found\n"), {}],
    [
      "a partial lsof name beside a denied ordinary process",
      result(
        1,
        "p7\nfcwd\nn/ -- work/holder\n",
        "find: '/proc/42/cwd': Permission denied\n",
      ),
      { "42": statusFile("0000000000000000") },
    ],
  ];

  test.each(cases)(
    "gives every tree the answer its own probe gave: %s",
    async (_name, listing, statuses) => {
      const { run } = runner(listing, statuses);
      const scan = await scanCwds(async (argv, cwd) => run(argv, cwd));
      for (const tree of trees)
        expect(holdersIn(scan, tree)).toEqual(cwdHolders(run, tree));
    },
  );

  test("starts no status read once its signal fires, and hands each read the time left", async () => {
    const abort = new AbortController();
    const limits: (number | undefined)[] = [];
    const reads: string[][] = [];
    const probe: AsyncProbeRun = async (argv, _cwd, limit) => {
      limits.push(limit);
      reads.push(argv);
      if (argv[0] === "sh") {
        abort.abort();
        return result(
          1,
          "/proc/1\t/\n",
          "find: '/proc/42/cwd': Permission denied\n",
        );
      }
      return statusFile("0000000000000000");
    };
    const scan = await scanCwds(probe, {
      signal: abort.signal,
      deadlineMs: 5_000,
    });
    expect(scan).toEqual({ unknown: "the process scan was stopped" });
    expect(reads).toHaveLength(1);
    expect(limits[0]).toBeGreaterThanOrEqual(1);
    expect(limits[0]).toBeLessThanOrEqual(5);
  });

  test("stops waiting for a read in flight when the signal fires", async () => {
    const abort = new AbortController();
    const scan = scanCwds(() => new Promise<never>(() => undefined), {
      signal: abort.signal,
    });
    abort.abort();
    expect(await scan).toEqual({ unknown: "the process scan was stopped" });
  });

  test("a clean listing that finishes past the deadline is no answer", async () => {
    const scan = await scanCwds(
      async () => {
        await Bun.sleep(1_100);
        return result(0, "/proc/1\t/\n");
      },
      { deadlineMs: 1_000 },
    );
    expect(scan).toEqual({ unknown: "the process scan ran past its deadline" });
  });

  test("starts nothing once the deadline is spent", async () => {
    let calls = 0;
    const scan = await scanCwds(
      async () => {
        calls++;
        return result(0, "/proc/1\t/\n");
      },
      { deadlineMs: 0 },
    );
    expect(scan).toEqual({ unknown: "the process scan ran past its deadline" });
    expect(calls).toBe(0);
  });

  test("asks the host once however many trees it is asked about", async () => {
    const { run, calls } = runner(
      result(
        1,
        "/proc/1\t/\n/proc/2\t/w/t5/a\n",
        "find: '/proc/42/cwd': Permission denied\n",
      ),
      { "42": statusFile("0000000800000000") },
    );
    const probe: AsyncProbeRun = async (argv, cwd) => run(argv, cwd);
    const scan = await scanCwds(probe);
    const answers = Array.from({ length: 50 }, (_, i) =>
      holdersIn(scan, `/w/t${i}`),
    );
    expect(answers[5]).toEqual({ pids: ["2"] });
    expect(
      answers.filter((a) => "pids" in a && a.pids.length > 0),
    ).toHaveLength(1);
    // The listing, and the one denied process's status; never one per tree.
    expect(calls).toEqual([
      ["sh", "-c", expect.any(String)],
      ["cat", "/proc/42/status"],
    ]);
  });
});
