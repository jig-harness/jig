/**
 * The plugin cache holds a copy of the plugin outside any repository, with no
 * `node_modules` above it. The whole procedure has to run from such a copy,
 * started from a consumer repository with its own configuration.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { CONFIG_COMBINED, mergeConflict, Scratch } from "./scratch.ts";

const plugin = join(import.meta.dir, "..", "..", "..");
let cache: string;
let s: Scratch;

beforeAll(() => {
  cache = realpathSync(mkdtempSync(join(tmpdir(), "resolve-conflicts-cache-")));
  cpSync(plugin, cache, {
    recursive: true,
    filter: (path) => !path.split(sep).includes("__tests__"),
  });
  s = new Scratch();
});
afterAll(() => {
  rmSync(cache, { recursive: true, force: true });
  s.cleanup();
});

it("maps, records and checks from a copy outside this repository", () => {
  for (let dir = cache; dirname(dir) !== dir; dir = dirname(dir))
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  const scripts = join(cache, "skills", "resolve-conflicts", "scripts");
  s.overlay(
    'resolve_conflicts:\n  generated:\n    - paths: ["gen/**"]\n      command: make gen\n',
  );
  mergeConflict(s);

  const map = s.script(join(scripts, "conflict-map.ts"), ["--json"]);
  expect(map.stderr).toBe("");
  expect(map.code).toBe(0);
  expect(Object.keys(JSON.parse(map.stdout).paths)).toEqual(["src/config.ts"]);

  s.write("src/config.ts", CONFIG_COMBINED);
  s.git("add", "src/config.ts");
  expect(
    s.script(join(scripts, "record.ts"), ["src/config.ts", "combined"]).code,
  ).toBe(0);
  const check = s.script(join(scripts, "check-resolution.ts"), ["--message"]);
  expect(check.code).toBe(0);
  expect(check.stdout).toBe("Conflicts resolved:\n- src/config.ts: combined\n");
});
