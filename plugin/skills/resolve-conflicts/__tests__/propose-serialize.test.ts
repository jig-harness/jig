/**
 * history.ts --propose-serialize: the change areas a conflict hotspot lies
 * in alone are printed as the catalog lines a person would add, a hotspot
 * no single area holds is listed beside them, and nothing in the
 * repository changes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { Scratch } from "./scratch.ts";

const CATALOG = `areas:
  migrations:
    title: Migrations
    category: data
    paths: ["db/migrations/**"]
    workspace: []
    impliedBy: []
    deployTier: none
  app:
    title: App
    category: app
    paths: ["src/**"]
    workspace: []
    impliedBy: []
    deployTier: none
    serialize: true
`;

let s: Scratch;

beforeEach(() => {
  s = new Scratch("resolve-conflicts-propose-");
  s.env.JIG_HOME = join(s.home, "jig-home");
  s.overlay(
    "drive:\n  change_areas_catalog: catalog.yaml\nresolve_conflicts:\n  hotspot_min_merges: 2\n",
  );
  s.write("catalog.yaml", CATALOG);
  s.commit("setup");
});
afterEach(() => s.cleanup());

/**
 * One merge of a branch that changed `path` against a main that changed it
 * too, resolved by keeping main's side, so the replay finds it conflicting.
 */
function conflictOn(path: string, round: number): void {
  s.commit(`base ${round}`, { [path]: `base ${round}\n` });
  const branch = `topic-${path.replace(/\W/g, "-")}-${round}`;
  s.git("checkout", "-q", "-b", branch);
  s.commit(`theirs ${round}`, { [path]: `theirs ${round}\n` });
  s.git("checkout", "-q", "main");
  s.commit(`ours ${round}`, { [path]: `ours ${round}\n` });
  expect(s.gitTry("merge", "-q", "--no-edit", branch).code).not.toBe(0);
  s.git("checkout", "--ours", "--", path);
  s.git("add", "--", path);
  s.git("commit", "-q", "--no-edit");
}

describe("history.ts --propose-serialize", () => {
  it("prints the catalog line for a hotspot one area holds, lists the rest, and writes nothing", () => {
    for (const round of [1, 2]) {
      conflictOn("db/migrations/001.sql", round);
      conflictOn("src/app.ts", round);
      conflictOn("README.md", round);
    }
    const before = [
      s.git("status", "--porcelain", "--untracked-files=all"),
      s.git("for-each-ref"),
      s.read("catalog.yaml"),
    ];
    const r = s.script("history.ts", ["--all", "--propose-serialize"]);
    expectSpawnExit(
      { exitCode: r.code, stdout: r.stdout, stderr: r.stderr },
      0,
      "history.ts --propose-serialize",
    );
    expect(r.stdout).toContain(
      "Areas to serialize, from the hotspots of all history. Add these lines under each area in catalog.yaml; nothing was written:\n\nareas:\n  migrations:\n    serialize: true  # hotspots: db/migrations/001.sql (2 merges)\n",
    );
    expect(r.stdout).toContain("Already serialized: app.");
    expect(r.stdout).toContain(
      "Hotspots no single area holds (not proposed):\n  README.md: no area of the catalog holds it",
    );
    expect([
      s.git("status", "--porcelain", "--untracked-files=all"),
      s.git("for-each-ref"),
      s.read("catalog.yaml"),
    ]).toEqual(before);
  });

  it("refuses to propose without a change-area catalog", () => {
    s.overlay("resolve_conflicts:\n  hotspot_min_merges: 2\n");
    const r = s.script("history.ts", ["--all", "--propose-serialize"]);
    expectSpawnExit(
      { exitCode: r.code, stdout: r.stdout, stderr: r.stderr },
      2,
    );
    expect(r.stderr).toContain(
      "--propose-serialize needs the change-area catalog, and drive.change_areas_catalog names none",
    );
  });
});
