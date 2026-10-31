/**
 * `file-issue` asks a person before writing only under `attended`: a driver
 * pass under `unattended` skips the confirmation and gets the filed-by line
 * its issue body carries. Each case runs the script in a scratch repository
 * with its environment passed to the child.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExited } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

const script = join(import.meta.dir, "..", "scripts", "confirm-step.ts");
const scratch = mkdtempSync(join(tmpdir(), "confirm-step-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

async function run(
  config: string,
  opts: { driver: boolean; args?: string[]; exit?: number },
): Promise<{ stdout: string; stderr: string }> {
  const root = join(scratch, `repo-${n++}`);
  mkdirSync(join(root, ".config"), { recursive: true });
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, ".config", "jig.yaml"), config);
  const proc = Bun.spawn(scriptArgv(script, ...(opts.args ?? [])), {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      JIG_HOME: join(root, "home"),
      JIG_CONSUMER_ROOT: root,
      ...(opts.driver ? { DRIVE_PR_TARGET: "42" } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await expectSpawnExited(proc, opts.exit ?? 0);
  return { stdout, stderr };
}

const UNATTENDED = "autonomy:\n  level: unattended\n";
const WHY = [
  "--skill",
  "resolve-review-comments",
  "--pr",
  "https://github.com/example/project/pull/42",
  "--why",
  "a deferred finding the batch step could not file",
];

describe("the confirm step", () => {
  test("a driver pass under unattended skips it and gets the filed-by line", async () => {
    const { stdout } = await run(UNATTENDED, { driver: true, args: WHY });
    const [first, second] = stdout.trim().split("\n");
    expect(first).toStartWith("skip: autonomy: unattended");
    expect(second).toBe(
      "Filed by `/jig:resolve-review-comments` from https://github.com/example/project/pull/42, without a person's confirmation: a deferred finding the batch step could not file",
    );
  });

  test("a driver pass under unattended confirms when no pull request is named", async () => {
    const { stdout } = await run(UNATTENDED, { driver: true });
    expect(stdout).toStartWith("confirm: autonomy: unattended");
  });

  test("options that name no pull request are refused, never a skip", async () => {
    const bad = (i: number, value: string) =>
      WHY.map((v, j) => (j === i ? value : v));
    for (const args of [
      ["--skill", "", "--pr", "", "--why", ""],
      bad(1, ""),
      bad(3, ""),
      bad(3, "not a url"),
      bad(3, "https://github.com/example/project/issues/42"),
      bad(5, "  "),
      bad(5, "two\nlines"),
    ]) {
      const { stdout, stderr } = await run(UNATTENDED, {
        driver: true,
        args,
        exit: 2,
      });
      expect(stdout).not.toContain("skip");
      expect(stderr).toContain("give --skill, --pr and --why together");
    }
  });

  test("a driver pass under attended confirms", async () => {
    const { stdout } = await run("autonomy:\n  level: attended\n", {
      driver: true,
    });
    expect(stdout).toStartWith("confirm: autonomy: attended");
  });

  test("a person's session confirms though the repository says unattended", async () => {
    const { stdout } = await run(UNATTENDED, { driver: false });
    expect(stdout).toStartWith("confirm: autonomy: attended");
    expect(stdout).toContain("interactive session");
  });
});
