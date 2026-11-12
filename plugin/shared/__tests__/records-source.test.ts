import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
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

test("a dangling symlink cannot create a database inside live state", () => {
  const home = join(root, "dangling-operator");
  const target = join(
    home,
    ".local",
    "state",
    "jig",
    "dispatch",
    "absent.sqlite",
  );
  const alias = join(root, "dangling.sqlite");
  symlinkSync(target, alias, "junction");
  expect(sourceDatabaseRefusal(alias, home)).not.toBeNull();
});

test("parent segments follow a symlink before locating an absent database", () => {
  const home = join(root, "parent-operator");
  const dispatch = join(home, ".local", "state", "jig", "dispatch");
  mkdirSync(dispatch, { recursive: true });
  const alias = join(root, "parent-alias");
  symlinkSync(dispatch, alias, "junction");
  const raw = `${alias}${sep}..${sep}absent.sqlite`;
  expect(sourceDatabaseRefusal(raw, home)).not.toBeNull();
});

test.skipIf(
  skipsOnWindows(
    "file-system",
    "relative file symlinks require Windows developer-mode privileges",
  ),
)(
  "relative symlink targets preserve parent segments until their directory links resolve",
  () => {
    const home = join(root, "relative-operator");
    const dispatch = join(home, ".local", "state", "jig", "dispatch");
    mkdirSync(dispatch, { recursive: true });
    const directoryAlias = join(root, "relative-directory");
    symlinkSync(dispatch, directoryAlias, "junction");
    const alias = join(root, "relative.sqlite");
    symlinkSync(`relative-directory${sep}..${sep}absent.sqlite`, alias, "file");
    expect(sourceDatabaseRefusal(alias, home)).not.toBeNull();
  },
);

test("a symlink cycle refuses state whose location cannot be verified", () => {
  const first = join(root, "cycle-first");
  const second = join(root, "cycle-second");
  symlinkSync(second, first, "junction");
  symlinkSync(first, second, "junction");
  expect(
    sourceDatabaseRefusal(first, join(root, "cycle-operator")),
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
