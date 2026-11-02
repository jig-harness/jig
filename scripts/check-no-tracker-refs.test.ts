import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../plugin/shared/guarded-git-spawn.ts";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function spawn(command: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
    ),
  );
  const [executable, ...args] = command;
  if (!executable) throw new Error("Missing subprocess executable");
  const result = spawnSync(executable, args, { env });
  return { ...result, exitCode: result.status };
}

/** A scanned repository: files are written and staged where the gate reads them. */
function repository() {
  const dir = mkdtempSync(join(tmpdir(), "jig-tracker-refs-"));
  temporary.push(dir);
  expectSpawnExit(spawn(["git", "init", "-q", dir]), 0);
  const write = (path: string, content: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
    expectSpawnExit(spawn(["git", "-C", dir, "add", path]), 0);
  };
  const check = () =>
    spawn([
      process.execPath,
      join(import.meta.dir, "check-no-tracker-refs.ts"),
      dir,
      join(dir, "patterns.txt"),
    ]);
  return { write, check };
}

test("{{team}} comes from the origin file when it exists, else from the configuration", () => {
  const { write, check } = repository();
  write(".config/jig.yaml", "issue_tracker:\n  team: NEW\n");
  write("patterns.txt", "\\b{{team}}-[0-9]+\\b\n");
  write("notes.md", "See OLD-12 and NEW-7.\n");
  const fallback = check();
  expectSpawnExit(fallback, 1);
  expect(fallback.stderr.toString()).toContain("NEW-7");
  expect(fallback.stderr.toString()).not.toContain("OLD-12");
  write(".config/origin-references.yaml", "tracker_team: OLD\n");
  const origin = check();
  expectSpawnExit(origin, 1);
  expect(origin.stderr.toString()).toContain("OLD-12");
  expect(origin.stderr.toString()).not.toContain("NEW-7");
});

test("an origin file that exists without a team is refused, not read as absent", () => {
  const { write, check } = repository();
  write(".config/jig.yaml", "issue_tracker:\n  team: NEW\n");
  write("patterns.txt", "\\b{{team}}-[0-9]+\\b\n");
  write("notes.md", "See OLD-12 and NEW-7.\n");
  for (const content of ["", "# no team yet\n", "tracker_team:\n"]) {
    write(".config/origin-references.yaml", content);
    const result = check();
    expectSpawnExit(result, 2);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("tracker_team");
    expect(stderr).toContain(".config/origin-references.yaml");
  }
});
