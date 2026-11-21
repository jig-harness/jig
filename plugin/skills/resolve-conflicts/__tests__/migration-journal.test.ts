import { expect, test } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { type Run, Scratch } from "./scratch.ts";

function exit(result: Run, code: number): void {
  expectSpawnExit({ ...result, exitCode: result.code }, code);
}

function journal(entries: [string, number][]): string {
  return JSON.stringify({
    version: "7",
    dialect: "postgresql",
    entries: entries.map(([tag, when], idx) => ({
      idx,
      when,
      tag,
      breakpoints: true,
    })),
  });
}

test("preserves the integration journal's applied-migration watermark", () => {
  const repo = new Scratch();
  const dir = "migrations";
  const path = `${dir}/meta/_journal.json`;
  const first = `${dir}/0001_feature.sql`;
  const moved = `${dir}/0002_feature.sql`;
  const sql = "CREATE TABLE feature (value INT);\n";
  try {
    repo.overlay(`resolve_conflicts:
  sequenced_migrations:
    - directory: ${dir}
      journal: ${path}
      command: bun rebuild-migrations.ts
`);
    repo.commit("Start sequence", {
      [`${dir}/0000_init.sql`]: "CREATE TABLE initial (value INT);\n",
      [path]: journal([["0000_init", 100]]),
    });
    repo.git("switch", "-q", "-c", "feature");
    repo.commit("Add feature migration", {
      [first]: sql,
      [path]: journal([
        ["0000_init", 100],
        ["0001_feature", 150],
      ]),
    });
    repo.git("switch", "-q", "main");
    repo.commit("Add integration migration", {
      [`${dir}/0001_integration.sql`]:
        "CREATE TABLE integration (value INT);\n",
      [path]: journal([
        ["0000_init", 100],
        ["0001_integration", 200],
      ]),
    });
    repo.git("switch", "-q", "feature");
    exit(repo.gitTry("merge", "main"), 1);
    exit(repo.script("conflict-map.ts"), 0);
    repo.write(moved, sql);
    repo.git("rm", "--", first);
    repo.write(
      path,
      journal([
        ["0000_init", 101],
        ["0001_integration", 201],
        ["0002_feature", 300],
      ]),
    );
    repo.git("add", "--", path, moved);
    exit(
      repo.script("record.ts", [
        first,
        "deleted",
        "--reason",
        `Renumbered to ${moved}.`,
      ]),
      0,
    );
    exit(repo.script("record.ts", [path, "regenerated"]), 0);

    const check = repo.script("check-resolution.ts");
    exit(check, 1);
    expect(check.stdout).toContain("preserve the integration journal entries");
    repo.write(
      path,
      journal([
        ["0000_init", 100],
        ["0001_integration", 200],
        ["0002_feature", 300],
      ]),
    );
    repo.git("add", "--", path);
    exit(repo.script("check-resolution.ts"), 0);
  } finally {
    repo.cleanup();
  }
});
