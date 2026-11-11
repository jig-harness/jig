import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { sourceDatabaseRefusal } from "../records/source.ts";

const root = mkdtempSync(join(tmpdir(), "records-source-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("source copies refuse live state but allow explicitly isolated state", () => {
  const home = join(import.meta.dir, "fixture-home");
  const live = join(home, ".local", "state", "jig", "dispatch", "state.sqlite");
  expect(sourceDatabaseRefusal(live, home)).not.toBeNull();
  expect(
    sourceDatabaseRefusal(join(home, "scratch", "state.sqlite"), home),
  ).toBeNull();
  expect(
    sourceDatabaseRefusal(live + "/../../../../jig-other/state.sqlite", home),
  ).toBeNull();
});

test("a symlink alias cannot disguise the live state directory", () => {
  const home = join(root, "operator");
  const live = join(home, ".local", "state", "jig");
  mkdirSync(live, { recursive: true });
  const alias = join(root, "alias");
  symlinkSync(live, alias, "junction");
  expect(
    sourceDatabaseRefusal(join(alias, "dispatch", "state.sqlite"), home),
  ).not.toBeNull();
});

test("a development subprocess can create state under an explicitly isolated home", () => {
  const home = join(root, "isolated");
  const module = new URL("../records/db.ts", import.meta.url).href;
  const script = `import { homedir } from 'node:os'; import { join } from 'node:path';
    const { openDatabase } = await import(${JSON.stringify(module)});
    const result = openDatabase({ path: join(homedir(), '.local/state/jig/dispatch/state.sqlite'), migrations: [{sql:'CREATE TABLE isolated (id INTEGER);', additive:false}] });
    console.log(JSON.stringify(result.ok ? {ok:true} : result)); process.exit(result.ok ? 0 : 1);`;
  const child = Bun.spawnSync(
    [process.execPath, "--no-env-file", "--eval", script],
    {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    },
  );
  expectSpawnExit(child, 0);
  expect(child.stdout.toString()).toContain('"ok":true');
});
