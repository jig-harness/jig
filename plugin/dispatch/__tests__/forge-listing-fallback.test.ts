/**
 * dispatch: a pull-request listing the forge runs out of time on is asked
 * once more without the checks, and a failed second ask does not read. Each
 * case runs the listing in a subprocess whose `gh` is a fake that is too slow
 * for any listing that asks for the checks.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";

const FORGE = join(import.meta.dir, "..", "lib", "forge.ts");

const PR = {
  number: 7,
  url: "https://github.com/o/r/pull/7",
  title: "Seven",
  headRefName: "seven",
  createdAt: "2026-11-13T00:00:00Z",
  headRefOid: "abc",
  baseRefName: "main",
  mergeable: "MERGEABLE",
  author: { login: "someone", is_bot: false },
  isDraft: false,
  updatedAt: "2026-11-13T00:00:00Z",
};

/** Runs the open listing against a `gh` that outlasts its deadline when asked for the checks, and answers a listing without them as `answer`. */
async function listing(answer: "answers" | "fails") {
  const dir = mkdtempSync(join(tmpdir(), "jig-listing-"));
  try {
    const log = join(dir, "asked.log");
    writeFakeProgram(
      join(dir, "gh"),
      `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *statusCheckRollup*) sleep 5; exit 0 ;;
esac
${
  answer === "answers"
    ? `echo '${JSON.stringify([PR])}'`
    : `echo "HTTP 500" >&2; exit 1`
}
`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const m = await import(${JSON.stringify(FORGE)});
console.log(JSON.stringify(await m.openPullRequests("o/r")));`,
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          GH_CALL_TIMEOUT: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expectSpawnExit(
      { exitCode: await child.exited, stdout, stderr },
      0,
      "listing",
    );
    const asked = readFileSync(log, "utf8").trim().split("\n");
    return {
      asked,
      outcome: JSON.parse(stdout.trim().split("\n").at(-1) ?? ""),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("an open pull request listing the forge runs out of time on", () => {
  it("is asked once more without the checks, which then read as unknown", async () => {
    const { asked, outcome } = await listing("answers");
    expect(asked.length).toBe(2);
    expect(asked[0]).toContain("statusCheckRollup");
    expect(asked[1]).not.toContain("statusCheckRollup");
    expect(asked[1]).toContain("headRefOid");
    expect(outcome.ok).toBe(true);
    expect(outcome.value[0].number).toBe(7);
    expect(outcome.value[0].failingChecks).toBeUndefined();
  });

  it("does not read when the second ask fails too", async () => {
    const { asked, outcome } = await listing("fails");
    expect(asked.length).toBe(2);
    expect(outcome.ok).toBe(false);
  });
});
