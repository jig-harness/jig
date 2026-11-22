import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { type Run, Scratch } from "./scratch.ts";

const dir = "db/migrations";
const journal = `${dir}/journal.json`;
const branchPath = `${dir}/002_feature.sql`;
const basePath = `${dir}/002_base.sql`;
const nextPath = `${dir}/004_feature.sql`;
let s: Scratch;
const exit = (result: Run, code: number) =>
  expectSpawnExit({ ...result, exitCode: result.code }, code);

beforeEach(() => {
  s = new Scratch();
  s.overlay(`resolve_conflicts:
  sequenced_migrations:
    - directory: ${dir}
      journal: ${journal}
      snapshots: ["${dir}/meta/{sequence}.json"]
      command: bun rebuild-migrations.ts && bun --version
`);
  s.commit("Start migrations", {
    [`${dir}/001_init.sql`]: "CREATE TABLE root (x INT);\n",
    [journal]: '["001_init.sql"]\n',
    [`${dir}/meta/001.json`]: "initial snapshot\n",
    "rebuild-migrations.ts": `
import { readdirSync, writeFileSync } from "node:fs";
const dir = "${dir}";
const [{ regenerate }] = JSON.parse(await Bun.stdin.text());
const files = readdirSync(dir).filter((path) => path.endsWith(".sql")).sort();
for (const path of regenerate)
  writeFileSync(path, path === "${journal}" ? JSON.stringify(files) + "\\n" : "resolved snapshot\\n");
`,
  });
  s.git("switch", "-q", "-c", "feature");
  s.commit("Add feature migration", {
    [branchPath]: "CREATE TABLE feature (x INT);\n",
    [journal]: '["001_init.sql","002_feature.sql"]\n',
    [`${dir}/meta/002.json`]: "feature snapshot\n",
  });
  s.git("switch", "-q", "main");
  s.commit("Add base migrations", {
    [basePath]: "CREATE TABLE base (x INT);\n",
    [`${dir}/003_next.sql`]: "CREATE TABLE next (x INT);\n",
    [journal]: '["001_init.sql","002_base.sql","003_next.sql"]\n',
    [`${dir}/meta/002.json`]: "base snapshot\n",
    [`${dir}/meta/003.json`]: "next snapshot\n",
  });
  s.git("switch", "-q", "feature");
  exit(s.gitTry("merge", "main"), 1);
});

afterEach(() => s.cleanup());

function runGenerator(result: Run): void {
  const plan = join(s.home, "migration-plan.json");
  writeFileSync(plan, result.stdout);
  const wrapper = join(import.meta.dir, "../../../shared/command.ts");
  const [{ command }] = JSON.parse(result.stdout);
  const shell =
    process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", command]
      : ["sh", "-c", command];
  exit(s.script(wrapper, ["--stdin-file", plan, "--", ...shell]), 0);
}

test("preserves and renumbers both migrations, then checks the regenerated journal", () => {
  exit(s.script("conflict-map.ts"), 0);
  const result = s.script("migration-plan.ts");
  exit(result, 0);
  expect(JSON.parse(result.stdout)[0].moves).toEqual([
    {
      from: branchPath,
      to: nextPath,
      commit: s.git("rev-parse", "HEAD").trim(),
    },
  ]);

  s.write(nextPath, s.git("show", `HEAD:${branchPath}`));
  s.git("rm", branchPath);
  s.git("checkout", "--theirs", journal, `${dir}/meta/002.json`);
  runGenerator(result);
  s.git("add", dir);
  exit(
    s.script("record.ts", [
      branchPath,
      "deleted",
      "--reason",
      `Renumbered to ${nextPath}.`,
    ]),
    0,
  );
  for (const path of [journal, `${dir}/meta/002.json`])
    exit(s.script("record.ts", [path, "regenerated"]), 0);
  exit(s.script("check-resolution.ts"), 0);

  expect(s.read(basePath)).toBe("CREATE TABLE base (x INT);\n");
  expect(s.read(nextPath)).toBe("CREATE TABLE feature (x INT);\n");
  expect(JSON.parse(s.read(journal))).toEqual([
    "001_init.sql",
    "002_base.sql",
    "003_next.sql",
    "004_feature.sql",
  ]);
  expect(s.read(`${dir}/meta/004.json`)).toBe("resolved snapshot\n");
});

test("fails if the branch migration disappears even with a deletion decision", () => {
  exit(s.script("conflict-map.ts"), 0);
  s.git("rm", branchPath);
  s.git("checkout", "--theirs", journal, `${dir}/meta/002.json`);
  s.git("add", dir);
  exit(
    s.script("record.ts", [
      branchPath,
      "deleted",
      "--reason",
      "Base version supersedes the branch change.",
    ]),
    0,
  );
  for (const path of [journal, `${dir}/meta/002.json`])
    exit(s.script("record.ts", [path, "regenerated"]), 0);
  const result = s.script("check-resolution.ts");
  exit(result, 1);
  expect(result.stdout).toContain(
    `migration ${branchPath} is missing or changed at ${nextPath}`,
  );
});

test("detects the legacy Drizzle journal and blocks renumbering without a command", () => {
  const drizzle = new Scratch();
  try {
    const dir = "packages/store/migrations";
    const journal = `${dir}/meta/_journal.json`;
    const feature = `${dir}/0001_feature.sql`;
    const snapshot = `${dir}/meta/0001_snapshot.json`;
    const entries = (newTag?: string) =>
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          { idx: 0, when: 1720000000000, tag: "0000_init" },
          ...(newTag ? [{ idx: 1, when: 1720000000001, tag: newTag }] : []),
        ],
      });
    drizzle.commit("Start legacy migrations", {
      [`${dir}/0000_init.sql`]: "CREATE TABLE root (x INT);\n",
      [journal]: entries(),
      [`${dir}/meta/0000_snapshot.json`]: '{"id":"initial"}',
    });
    drizzle.git("switch", "-q", "-c", "feature");
    drizzle.commit("Add legacy feature migration", {
      [feature]: "CREATE TABLE feature (x INT);\n",
      [journal]: entries("0001_feature"),
      [snapshot]: '{"id":"feature","prevId":"initial"}',
    });
    drizzle.git("switch", "-q", "main");
    drizzle.commit("Add legacy base migration", {
      [`${dir}/0001_base.sql`]: "CREATE TABLE base (x INT);\n",
      [journal]: entries("0001_base"),
      [snapshot]: '{"id":"base","prevId":"initial"}',
    });
    drizzle.git("switch", "-q", "feature");
    exit(drizzle.gitTry("merge", "main"), 1);
    exit(drizzle.script("conflict-map.ts"), 0);
    expect(drizzle.snapshot().paths).toMatchObject({
      [journal]: { class: "generated", regenerate: null },
      [snapshot]: { class: "generated", regenerate: null },
    });
    drizzle.git("checkout", "--theirs", journal);
    drizzle.git("add", journal);
    const result = drizzle.script("migration-plan.ts");
    exit(result, 1);
    expect(JSON.parse(result.stdout)[0]).toMatchObject({
      directory: dir,
      journal,
      command: null,
      moves: [{ from: feature, to: `${dir}/0002_feature.sql` }],
      problems: [
        {
          message: expect.stringContaining(
            "configure a repository regeneration command",
          ),
        },
      ],
    });
    const check = drizzle.script("check-resolution.ts");
    exit(check, 1);
    expect(check.stdout).toContain(
      "configure a repository regeneration command",
    );
  } finally {
    drizzle.cleanup();
  }
});

test("checks dropped lines when both sides edit an existing migration", () => {
  const existing = new Scratch();
  try {
    const file = `${dir}/001_init.sql`;
    existing.overlay(`resolve_conflicts:
  sequenced_migrations:
    - directory: ${dir}
      journal: ${journal}
      command: bun rebuild-migrations.ts
`);
    existing.commit("Start migrations", {
      [file]: "CREATE TABLE original (value INT);\n",
      [journal]: '["001_init.sql"]\n',
    });
    existing.git("switch", "-q", "-c", "feature");
    existing.commit("Edit feature migration", {
      [file]: "CREATE TABLE feature (value INT);\n",
    });
    existing.git("switch", "-q", "main");
    existing.commit("Edit integration migration", {
      [file]: "CREATE TABLE integration (value INT);\n",
    });
    existing.git("switch", "-q", "feature");
    exit(existing.gitTry("merge", "main"), 1);
    exit(existing.script("conflict-map.ts"), 0);
    existing.git("checkout", "--ours", file);
    existing.git("add", file);
    exit(existing.script("record.ts", [file, "combined"]), 0);
    const check = existing.script("check-resolution.ts");
    exit(check, 1);
    expect(check.stdout).toContain("theirs line 1 dropped");
  } finally {
    existing.cleanup();
  }
});

test("plans metadata-only legacy conflicts with their existing per-path generators", () => {
  const legacy = new Scratch();
  try {
    const directory = "legacy";
    const journal = "legacy/meta/_journal.json";
    const snapshot = "legacy/meta/0001_snapshot.json";
    legacy.overlay(`resolve_conflicts:
  generated:
    - paths: ["${snapshot}"]
      command: bun rebuild-snapshots.ts
drive:
  change_areas_catalog: .config/change-areas.yaml
`);
    legacy.commit("Start migration metadata", {
      ".config/change-areas.yaml": `version: 1
areas:
  migrations:
    paths: ["legacy/**"]
    generated:
      - outputs: ["${journal}"]
        command: bun rebuild-journal.ts
`,
      "legacy/0001_existing.sql": "CREATE TABLE root (x INT);\n",
      [journal]: '["0001_existing.sql"]\n',
      [snapshot]: "initial snapshot\n",
    });
    legacy.git("switch", "-q", "-c", "feature");
    legacy.commit("Adjust migration metadata", {
      [journal]: '[ "0001_existing.sql"]\n',
      [snapshot]: "feature snapshot\n",
    });
    legacy.git("switch", "-q", "main");
    legacy.commit("Refresh metadata", {
      [journal]: '["0001_existing.sql" ]\n',
      [snapshot]: "base snapshot\n",
    });
    legacy.git("switch", "-q", "feature");
    exit(legacy.gitTry("merge", "main"), 1);
    exit(legacy.script("conflict-map.ts"), 0);
    const result = legacy.script("migration-plan.ts");
    exit(result, 0);
    expect(JSON.parse(result.stdout)).toMatchObject([
      {
        directory,
        command: null,
        moves: [],
        regenerate: [snapshot, journal],
        fallback: {
          [snapshot]: {
            command: "bun rebuild-snapshots.ts",
            source: "configuration",
          },
          [journal]: { command: "bun rebuild-journal.ts", source: "catalog" },
        },
      },
    ]);
    expect(legacy.snapshot().paths).toMatchObject({
      [snapshot]: {
        class: "generated",
        regenerate: {
          command: "bun rebuild-snapshots.ts",
          source: "configuration",
        },
      },
      [journal]: {
        class: "generated",
        regenerate: { command: "bun rebuild-journal.ts", source: "catalog" },
      },
    });
  } finally {
    legacy.cleanup();
  }
});

test("rebuilds changed predecessors and missing snapshots without renumbering", () => {
  s.git("merge", "--abort");
  s.git("mv", branchPath, nextPath);
  s.git("mv", `${dir}/meta/002.json`, `${dir}/meta/004.json`);
  s.commit("Reserve a later sequence number", {
    [journal]: '["001_init.sql","004_feature.sql"]\n',
  });
  s.git("switch", "-q", "main");
  const missingSnapshot = `${dir}/meta/003.json`;
  s.git("rm", missingSnapshot);
  s.commit("Leave the new integration snapshot to regenerate");
  s.git("switch", "-q", "feature");
  exit(s.gitTry("merge", "main"), 1);
  exit(s.script("conflict-map.ts"), 0);

  const result = s.script("migration-plan.ts");
  exit(result, 0);
  expect(JSON.parse(result.stdout)).toMatchObject([
    {
      moves: [],
      regenerate: [journal, missingSnapshot, `${dir}/meta/004.json`],
    },
  ]);

  s.git("checkout", "--theirs", journal);
  runGenerator(result);
  s.git("add", dir);
  exit(s.script("record.ts", [journal, "regenerated"]), 0);
  exit(s.script("check-resolution.ts"), 0);
  expect(s.read(missingSnapshot)).toBe("resolved snapshot\n");

  const preservedSnapshot = `${dir}/meta/002.json`;
  s.write(preservedSnapshot, "overwritten integration snapshot\n");
  s.git("add", preservedSnapshot);
  exit(s.script("record.ts", [preservedSnapshot, "regenerated"]), 0);
  exit(s.script("check-resolution.ts"), 1);
  expect(s.script("check-resolution.ts").stdout).toContain(
    `${preservedSnapshot}: integration snapshot was changed`,
  );
});
