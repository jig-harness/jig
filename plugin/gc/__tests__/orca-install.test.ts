import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { dump } from "../../shared/yaml.ts";

const JIG = resolve(import.meta.dir, "../../jig.ts");
const ORCA = "/opt/orca/orca-ide";

let root: string;
let home: string;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gc-orca-install-"));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(join(home, ".jig"), { recursive: true });
  mkdirSync(repo);
  expectSpawnExit(Bun.spawnSync(["git", "init", "-q", repo]), 0);
  writeFileSync(
    join(home, ".jig", "jig.yaml"),
    dump({ gc: { repositories: [], orca: { command: ORCA } } }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A previewing `jig gc install` run; it changes neither the file nor the scheduler. */
function preview(args: string[]) {
  const done = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      `--config=${join(dirname(JIG), "gc", "bunfig.toml")}`,
      JIG,
      "gc",
      "install",
      "--repo",
      repo,
      "--uninstall",
      ...args,
    ],
    {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        JIG_HOME: join(home, ".jig"),
        RESOURCE_LOCK_BYPASS: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30000,
    },
  );
  expectSpawnExit(done, 0);
  return done.stdout.toString();
}

test("removing the last repository keeps the job while the terminal kind is enabled", () => {
  const text = preview([]);
  expect(text).not.toContain("job is removed");
  expect(text).toContain(ORCA);
});

test("machine-wide removal withdraws the terminal kind's authority", () => {
  const text = preview(["--machine"]);
  expect(text).toContain("job is removed");
  expect(text).not.toContain(ORCA);
});
