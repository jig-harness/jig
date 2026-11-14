/**
 * `check-fields.ts` from the command line: the options it refuses before it
 * reads the tracker, and a move record it cannot read. Each case runs the
 * script in a scratch repository with a GitHub tracker configured and no
 * credential, so nothing it could reach is a real tracker.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { fileLockPath, withFileLock } from "../../../shared/file-lock.ts";

const script = join(import.meta.dir, "..", "scripts", "check-fields.ts");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "check-fields-")));
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

  test("keeps no read position when the sweep moves issues", async () => {
    const stderr = await run(["check", "--position", "position.json"], 1);
    expect(stderr).toContain(
      "file_issue.sweep.move is true, so a moved issue leaves the population and no read position is kept",
    );
    expect(existsSync(join(scratch, `repo-${n - 1}`, "position.json"))).toBe(
      false,
    );
  });

  test("warns of an unreadable read position, and leaves it when a store problem stops the run", async () => {
    const stderr = await run(
      ["check", "--yes", "--position", "record.json"],
      1,
      "file_issue:\n  sweep:\n    move: false\n",
    );
    expect(stderr).toContain(
      "is not an issue-fields-position record of version 1; starting from the oldest issue",
    );
    expect(
      readFileSync(join(scratch, `repo-${n - 1}`, "record.json"), "utf8"),
    ).toBe('{"kind":"something-else"}\n');
  });

  test("refuses a second run on a read position another run holds", async () => {
    const position = join(scratch, `repo-${n}`, "position.json");
    const held = await withFileLock(
      position,
      () =>
        run(
          ["check", "--yes", "--position", "position.json"],
          1,
          "file_issue:\n  sweep:\n    move: false\n",
        ),
      { root: join(scratch, `repo-${n}`), name: "sweep-position" },
    );
    expect(held?.value).toContain("another run holds this read position");
  });

  test("takes over a read position lock whose owner is gone", async () => {
    const root = join(scratch, `repo-${n}`);
    mkdirSync(root, { recursive: true });
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(
      fileLockPath(join(root, "position.json"), root, "sweep-position"),
      `${dead.pid}\nstale-token\n`,
    );
    const lock = fileLockPath(
      join(root, "position.json"),
      root,
      "sweep-position",
    );
    const stderr = await run(
      ["check", "--yes", "--position", "position.json"],
      1,
      "file_issue:\n  sweep:\n    move: false\n",
    );
    expect(stderr).not.toContain("another run holds this read position");
    // The run reached the tracker, which refuses it for want of a credential.
    expect(stderr).not.toContain("check-fields: failed");
    expect(existsSync(lock)).toBe(false);
  });

  test("stops with the cause when the read position's directory cannot be made", async () => {
    const root = join(scratch, `repo-${n}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "blocker"), "a file, not a directory\n");
    const stderr = await run(
      ["check", "--yes", "--position", "blocker/position.json"],
      1,
      "file_issue:\n  sweep:\n    move: false\n",
    );
    expect(stderr).toContain("cannot be locked");
  });

  test("refuses a run reaching a held read position through a symlinked directory", async () => {
    const root = join(scratch, `repo-${n}`);
    mkdirSync(root, { recursive: true });
    symlinkSync(root, join(root, "alias"), "junction");
    const held = await withFileLock(
      join(realpathSync(root), "position.json"),
      () =>
        run(
          ["check", "--yes", "--position", "alias/position.json"],
          1,
          "file_issue:\n  sweep:\n    move: false\n",
        ),
      { root: realpathSync(root), name: "sweep-position" },
    );
    expect(held?.value).toContain("another run holds this read position");
  });
});
