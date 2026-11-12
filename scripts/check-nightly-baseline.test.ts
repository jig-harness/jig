import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";
import { BASELINE_FILE } from "./check-nightly-baseline.ts";

const SCRIPT = join(import.meta.dir, "check-nightly-baseline.ts");
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

/** A repository holding one test file and the baseline `body` names. */
function repo(body: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "jig-nightly-baseline-"));
  temporary.push(root);
  mkdirSync(join(root, "lib"));
  writeFileSync(
    join(root, "lib/a.test.ts"),
    'describe("outer", () => { test("spells the path", () => {}); });\n',
  );
  if (body !== undefined) {
    mkdirSync(join(root, ".config"));
    writeFileSync(join(root, BASELINE_FILE), body);
  }
  return root;
}

const group = (tests: string) =>
  `version: 1\ngroups:\n  - platform: windows\n    issue: "#12"\n    reason: Paths differ.\n    tests:\n${tests}`;

function run(root: string) {
  return Bun.spawnSync([process.execPath, SCRIPT, root], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("Jig's own baseline names only tests that exist", () => {
  expectSpawnExit(run(join(import.meta.dir, "..")), 0);
});

test("an entry for a test that is gone, renamed or in a missing file fails the check", () => {
  const passing = run(
    repo(
      group(
        '      lib/a.test.ts: ["outer > spells the path", "outer > (unnamed)"]\n',
      ),
    ),
  );
  expectSpawnExit(passing, 0);
  const failing = run(
    repo(
      group(
        '      lib/a.test.ts: ["outer > spells it differently"]\n      lib/gone.test.ts: ["outer > spells the path"]\n',
      ),
    ),
  );
  expectSpawnExit(failing, 1);
  const stderr = failing.stderr.toString();
  expect(stderr).toContain(
    'windows: lib/a.test.ts no longer declares "outer > spells it differently"',
  );
  expect(stderr).toContain("windows: lib/gone.test.ts does not exist");
});

test("a malformed or duplicated entry fails the check, and a missing baseline cannot be checked", () => {
  const malformed = run(
    repo(
      group(
        '      lib/a.test.ts: ["outer > spells the path", "outer > spells the path"]\n',
      ).replace('"#12"', "twelve"),
    ),
  );
  expectSpawnExit(malformed, 1);
  expect(malformed.stderr.toString()).toContain(
    "issue must be the owning issue",
  );
  const duplicated = run(
    repo(
      group(
        '      lib/a.test.ts: ["outer > spells the path", "outer > spells the path"]\n',
      ),
    ),
  );
  expectSpawnExit(duplicated, 1);
  expect(duplicated.stderr.toString()).toContain(
    "is recorded twice for windows",
  );
  expectSpawnExit(run(repo(undefined)), 2);
});
