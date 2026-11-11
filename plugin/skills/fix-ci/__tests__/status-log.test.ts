/**
 * status-log.ts: `ci.log_command` is run through the shell from the
 * repository root, reads the failing status on stdin and prints its log; exit
 * 3 says the log is gone, any other failure and a run past the deadline is a
 * failure to read. Each case runs a real command, a script the test writes.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStatusLog } from "../scripts/status-log.ts";

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
  console.error("build 3 was discarded");
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

  it("reads exit 3 as a log that is gone, with the command's reason", async () => {
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
      expect(read.failure.reason).toContain("exited 5");
      expect(read.failure.reason).toContain("401 Unauthorized");
    }
  });

  it("stops a command at its deadline", async () => {
    const started = Date.now();
    const read = await readStatusLog(command("hang"), STATUS, 2, repo);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.failure.reason).toContain("ran past 2s");
    expect(Date.now() - started).toBeLessThan(25_000);
  });
});
