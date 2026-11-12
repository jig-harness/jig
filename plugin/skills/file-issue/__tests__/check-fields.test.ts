/**
 * `check-fields.ts` from the command line: the options it refuses before it
 * reads the tracker, and a move record it cannot read. Each case runs the
 * script in a scratch repository with a GitHub tracker configured and no
 * credential, so nothing it could reach is a real tracker.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

const script = join(import.meta.dir, "..", "scripts", "check-fields.ts");
const scratch = mkdtempSync(join(tmpdir(), "check-fields-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

async function run(args: string[], exit: number, extra = ""): Promise<string> {
  const root = join(scratch, `repo-${n++}`);
  mkdirSync(join(root, ".config"), { recursive: true });
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "home"));
  writeFileSync(
    join(root, ".config", "jig.yaml"),
    "issue_tracker:\n  adapter: github\n  github:\n    repository: owner/repo\n" +
      extra,
  );
  writeFileSync(join(root, "record.json"), '{"kind":"something-else"}\n');
  const proc = Bun.spawn(scriptArgv(script, ...args), {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      JIG_HOME: join(root, "home"),
      JIG_CONSUMER_ROOT: root,
      JIG_FACET_CACHE: "off",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  expectSpawnExit({ exitCode: await proc.exited, stdout, stderr }, exit);
  return stderr;
}

describe("check-fields.ts", () => {
  for (const [what, args, says] of [
    ["an unknown mode", ["sweep"], "unknown mode: sweep"],
    [
      "two phases at once",
      ["move", "--record", "r.json", "--copy", "--retire"],
      "move takes one of --copy, --retire and --restore",
    ],
    ["a move with no record", ["move", "--copy"], "move needs --record <file>"],
    [
      "--yes with no phase",
      ["move", "--record", "r.json", "--yes"],
      "--yes writes a phase",
    ],
    [
      "--yes on the preview",
      ["move", "--target", "t.yaml", "--record", "r.json", "--yes"],
      "the preview writes nothing to the tracker",
    ],
    [
      "a target beside a phase",
      ["move", "--target", "t.yaml", "--record", "r.json", "--copy"],
      "--target is for the preview",
    ],
    ["an option it does not know", ["check", "--all"], "Unknown option"],
    [
      "a record of another kind",
      ["move", "--record", "record.json", "--copy"],
      "its kind is not facet-move",
    ],
  ] as const)
    test(`refuses ${what} as usage, before writing anything`, async () => {
      const stderr = await run([...args], 2);
      expect(stderr).toContain(says);
    });

  for (const [what, section, says] of [
    [
      "a sweep.move that is not true or false",
      "file_issue:\n  sweep:\n    move: sometimes\n",
      "file_issue.sweep.move must be true or false",
    ],
    [
      "an unknown sweep field",
      "file_issue:\n  sweep:\n    moves: false\n",
      "file_issue.sweep.moves is not a field",
    ],
  ] as const)
    test(`refuses ${what} before reading the tracker`, async () => {
      const stderr = await run(["check"], 2, section);
      expect(stderr).toContain(says);
    });
});
