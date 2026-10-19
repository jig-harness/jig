/**
 * The plugin cache holds a copy of the plugin outside any repository, with no
 * `node_modules` above it. The whole procedure has to run from such a copy,
 * started from a consumer repository with its own configuration.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
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
    'resolve_conflicts:\n  obligations:\n    - check: "Keep shared validation in all changed callers."\n      command: git diff --cached --name-only\n  generated:\n    - paths: ["gen/**"]\n      command: make gen\n',
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
  expectSpawnExit({ ...check, exitCode: check.code }, 0);
  expect(check.stderr).toContain(
    "Keep shared validation in all changed callers.",
  );
  expect(check.stderr).toContain("passed");
  expect(check.stdout).toBe("Conflicts resolved:\n- src/config.ts: combined\n");
});

it("replays the history from a copy outside this repository", () => {
  const h = new Scratch();
  try {
    h.env.JIG_HOME = join(h.home, "jig-home");
    const base = h.commit("base", { "a.txt": "x\n" });
    h.git("checkout", "-q", "-b", "feature");
    const theirs = h.commit("theirs", { "a.txt": "z\n" });
    h.git("checkout", "-q", "main");
    const ours = h.commit("ours", { "a.txt": "y\n" });
    expect(base).not.toBe(ours);
    const merge = h
      .git(
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        ours,
        "-p",
        theirs,
        "-m",
        "Merge",
      )
      .trim();
    h.git("reset", "-q", "--hard", merge);
    const scripts = join(cache, "skills", "resolve-conflicts", "scripts");
    const r = h.script(join(scripts, "history.ts"), ["--json", "--all"]);
    expectSpawnExit(
      { exitCode: r.code, stdout: r.stdout, stderr: r.stderr },
      0,
    );
    const report = JSON.parse(r.stdout);
    expect(report.totals).toMatchObject({ merges: 1, conflicted: 1 });
    expect(report.confidence).not.toBeNull();
  } finally {
    h.cleanup();
  }
});
