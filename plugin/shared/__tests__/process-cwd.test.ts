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
  detachedCarriers,
  parseCwdListing,
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

describe("detachedCarriers", () => {
  const ENTRY = "JIG_HOOK_WORKTREE=/w/a";

  test("passes only numeric pids to one probe, and reads a failed probe as none", () => {
    const calls: string[][] = [];
    const failing: ProbeRun = (argv, cwd) => {
      calls.push(argv);
      expect(cwd).toBe("/");
      return result(2, "", "sh: broken");
    };
    expect(detachedCarriers(failing, ["12", "../self", "13"], ENTRY)).toEqual(
      new Set(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(3)).toEqual(["sh", ENTRY, "12", "13"]);
    expect(detachedCarriers(failing, ["x"], ENTRY)).toEqual(new Set());
    expect(calls).toHaveLength(1);
  });

  test("keeps only the pids it was asked about", () => {
    const run: ProbeRun = () => result(0, "12\n99\n");
    expect(detachedCarriers(run, ["12", "13"], ENTRY)).toEqual(new Set(["12"]));
  });

  test.skipIf(process.platform !== "linux")(
    "finds a detached process started with the entry, never one with a terminal or without it",
    async () => {
      const run: ProbeRun = (argv, cwd) => {
        const r = Bun.spawnSync(argv, {
          cwd: cwd ?? "/",
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          status: r.exitCode,
          stdout: r.stdout.toString(),
          stderr: r.stderr.toString(),
        };
      };
      const env = { ...process.env, JIG_HOOK_WORKTREE: "/w/a" };
      const spawn = (argv: string[], withEntry: boolean) =>
        Bun.spawn(argv, {
          env: withEntry ? env : { ...process.env, JIG_HOOK_WORKTREE: "/w/b" },
          stdio: ["ignore", "ignore", "ignore"],
        });
      const daemon = spawn(["setsid", "sleep", "600"], true);
      const other = spawn(["setsid", "sleep", "600"], false);
      // `script` gives the shell it starts a terminal of its own.
      const typed = spawn(
        ["setsid", "script", "-qec", "exec sleep 600", "/dev/null"],
        true,
      );
      try {
        const until = performance.now() + 10_000;
        let shell: string | undefined;
        while (shell === undefined && performance.now() < until) {
          const children = Bun.spawnSync([
            "ps",
            "-o",
            "pid=",
            "--ppid",
            String(typed.pid),
          ]);
          shell =
            children.stdout.toString().trim().split("\n")[0]?.trim() ||
            undefined;
          if (shell === undefined) await Bun.sleep(20);
        }
        if (shell === undefined) throw new Error("script started no shell");
        const pids = [String(daemon.pid), String(other.pid), shell];
        let found = new Set<string>();
        while (performance.now() < until) {
          found = detachedCarriers(run, pids, ENTRY);
          if (found.has(String(daemon.pid))) break;
          await Bun.sleep(20);
        }
        expect(found).toEqual(new Set([String(daemon.pid)]));
      } finally {
        for (const child of [daemon, other, typed]) child.kill("SIGKILL");
      }
    },
    20_000,
  );
});
