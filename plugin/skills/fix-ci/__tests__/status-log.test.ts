/**
 * status-log.ts: `ci.log_command` is run through the shell in a copy of the
 * default branch's files, reads the failing status on stdin and prints its log; exit
 * 3 says the log is gone, any other failure and a run past the deadline is a
 * failure to read. Each case runs a real command, a script the test writes.
 * The command is the default branch's; a working tree's alone never runs, and
 * the program it runs is the default branch's too (`readStatusLogs`).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  logCommandOf,
  readStatusLog,
  readStatusLogs,
} from "../scripts/status-log.ts";

const STATUS = {
  context: "continuous-integration/jenkins/pr-merge",
  target_url: "https://ci.example/job/project/PR-12/3/",
};

/**
 * A stand-in for a repository's log command: it reads the status from stdin
 * and answers as its first argument says.
 */
const COMMAND = `
const status = JSON.parse(await Bun.stdin.text());
const mode = process.argv[2];
if (mode === "log") {
  console.log("log of " + status.context + " at " + status.target_url);
  console.log("cwd " + process.cwd());
} else if (mode === "gone") {
  console.log("build 3 was discarded\\nmore detail");
  process.exit(3);
} else if (mode === "broken") {
  console.error("401 Unauthorized");
  process.exit(5);
} else {
  await Bun.sleep(30_000);
}
`;

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "fix-ci-status-log-"));
  writeFileSync(join(repo, "ci-log.ts"), COMMAND);
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** The command line for one mode, the runtime's path quoted for the shell. */
const command = (mode: string) => `"${process.execPath}" ci-log.ts ${mode}`;

describe("readStatusLog", () => {
  it("passes the status on stdin and returns what the command prints", async () => {
    const read = await readStatusLog(command("log"), STATUS, 60, repo);
    expect(read.ok).toBe(true);
    if (read.ok && read.value.kind === "log") {
      expect(read.value.text).toContain(
        `log of ${STATUS.context} at ${STATUS.target_url}`,
      );
      expect(read.value.text).toContain("cwd ");
    } else expect(read).toMatchObject({ value: { kind: "log" } });
  });

  it("reads exit 3 as a log that is gone, the first line it prints the reason", async () => {
    expect(await readStatusLog(command("gone"), STATUS, 60, repo)).toEqual({
      ok: true,
      value: { kind: "gone", reason: "build 3 was discarded" },
    });
  });

  it("reads any other exit as a failure naming the status", async () => {
    const read = await readStatusLog(command("broken"), STATUS, 60, repo);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.failure.code).toBe("log-command-failed");
      expect(read.failure.reason).toContain(STATUS.context);
      expect(read.failure.reason).toContain("exit 5");
      expect(read.failure.reason).toContain("401 Unauthorized");
    }
  });

  it("stops a command at its deadline", async () => {
    const started = Date.now();
    const read = await readStatusLog(command("hang"), STATUS, 2, repo);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.failure.reason).toContain("still running after 2s");
      expect(read.failure.reason).toContain(
        "JIG_FIX_CI_LOG_COMMAND_TIMEOUT_SEC",
      );
    }
    expect(Date.now() - started).toBeLessThan(25_000);
  });
});

describe("logCommandOf", () => {
  it("runs no command where the default branch cannot be read and the working tree sets none", async () => {
    expect(await logCommandOf(repo, undefined)).toEqual({
      ok: true,
      value: null,
    });
  });

  it("refuses a working tree's command when the default branch cannot be read", async () => {
    const read = await logCommandOf(repo, "bun scripts/ci-log.ts");
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.failure.code).toBe("unreadable");
      expect(read.failure.reason).toContain("default branch");
    }
  });
});

/** A command a pull request's author edited, and what the default branch holds. */
const PROGRAM = (version: string) => `
import { appendFileSync, writeFileSync } from "node:fs";
const [mode, record] = process.argv.slice(2);
appendFileSync(record, process.cwd() + "\\n");
await Bun.stdin.text();
if (mode === "fail") process.exit(5);
else if (mode === "flood") console.log("x".repeat(100_000));
else if (mode === "hang") await Bun.sleep(30_000);
else console.log("${version}");
`;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

describe("readStatusLogs", () => {
  let work: string;
  let main: string;
  let record: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "fix-ci-default-branch-"));
    record = join(work, "..", `${work.split(/[\\/]/).pop()}.cwds`);
    writeFileSync(record, "");
    git(work, "init", "-q", "-b", "main");
    writeFileSync(join(work, "ci-log.ts"), PROGRAM("default branch"));
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "base");
    main = git(work, "rev-parse", "HEAD");
    // The pull request edits the script, in a commit and then in its working tree.
    git(work, "checkout", "-q", "-b", "pr");
    writeFileSync(join(work, "ci-log.ts"), PROGRAM("pull request commit"));
    git(work, "commit", "-q", "-am", "edit the log command");
    writeFileSync(join(work, "ci-log.ts"), PROGRAM("pull request tree"));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(record, { force: true });
  });

  const run = (mode: string, statuses = [STATUS], seconds = 60) =>
    readStatusLogs(
      `"${process.execPath}" ci-log.ts ${mode} "${record}"`,
      main,
      statuses,
      seconds,
      work,
    );
  const cwds = () =>
    readFileSync(record, "utf8")
      .split("\n")
      .filter((l) => l !== "");

  it("runs the default branch's program, not the pull request's commit or its working tree", async () => {
    const read = await run("log");
    expect(read).toEqual({
      ok: true,
      value: [{ kind: "log", text: "default branch\n" }],
    });
    expect(cwds()).not.toContain(work);
  });

  it("copies once for several statuses and answers each in order", async () => {
    const read = await run("log", [STATUS, { ...STATUS, context: "other" }]);
    expect(read.ok && read.value.length).toBe(2);
    expect(new Set(cwds()).size).toBe(1);
  });

  it("copies nothing when no status failed", async () => {
    expect(await run("log", [])).toEqual({ ok: true, value: [] });
    expect(cwds()).toEqual([]);
  });

  it("leaves the repository's working tree, index and branch as they were", async () => {
    await run("log");
    expect(readFileSync(join(work, "ci-log.ts"), "utf8")).toBe(
      PROGRAM("pull request tree"),
    );
    expect(git(work, "status", "--porcelain")).toBe("M ci-log.ts");
    expect(git(work, "branch", "--show-current")).toBe("pr");
  });

  for (const mode of ["log", "fail", "flood", "hang"]) {
    it(`removes the copy after a run that ends as '${mode}'`, async () => {
      const read = await run(mode, [STATUS], 2);
      expect(read.ok).toBe(mode === "log");
      const [copy] = cwds();
      expect(copy).toBeDefined();
      expect(existsSync(copy as string)).toBe(false);
    });
  }

  it("fails the read, running nothing, when the copy cannot be made", async () => {
    const read = await readStatusLogs(
      `"${process.execPath}" ci-log.ts log "${record}"`,
      "0".repeat(40),
      [STATUS],
      60,
      work,
    );
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.failure.code).toBe("unreadable");
      expect(read.failure.reason).toContain("could not be copied");
    }
    expect(cwds()).toEqual([]);
  });
});
