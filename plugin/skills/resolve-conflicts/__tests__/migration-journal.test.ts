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

test.each([false, true])(
  "preserves the integration journal's watermark (integration timestamps out of order: %s)",
  (outOfOrder) => {
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
          ["0001_integration", outOfOrder ? 50 : 200],
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
      expect(check.stdout).toContain(
        "preserve the integration journal entries",
      );
      repo.write(
        path,
        journal([
          ["0000_init", 100],
          ["0001_integration", outOfOrder ? 50 : 200],
          ["0002_feature", 300],
        ]),
      );
      repo.git("add", "--", path);
      exit(repo.script("check-resolution.ts"), 0);
    } finally {
      repo.cleanup();
    }
  },
);

const lateDir = "migrations";
const lateJournal = `${lateDir}/meta/_journal.json`;
const featureSql = "CREATE TABLE feature (value INT);\n";
// The integration journal lists 0002 before 0001, as a repository's
// journal does when a long-lived branch's lower sequence merged late.
const lateBase: [string, number][] = [
  ["0000_init", 100],
  ["0002_two", 200],
  ["0001_one", 300],
];

/** A merge onto an integration journal that is out of sequence order. */
function lateMerge(
  repo: Scratch,
  branchAddsMigration: boolean,
  integrationJournal = journal(lateBase),
  branchMigration = "0003_feature",
): void {
  repo.overlay(`resolve_conflicts:
  sequenced_migrations:
    - directory: ${lateDir}
      journal: ${lateJournal}
      command: bun rebuild-migrations.ts
`);
  repo.commit("Start sequence", {
    [`${lateDir}/0000_init.sql`]: "CREATE TABLE initial (value INT);\n",
    [lateJournal]: journal([["0000_init", 100]]),
    "notes.txt": "start\n",
  });
  repo.git("switch", "-q", "-c", "feature");
  repo.commit(
    "Branch change",
    branchAddsMigration
      ? {
          [`${lateDir}/${branchMigration}.sql`]: featureSql,
          [lateJournal]: journal([
            ["0000_init", 100],
            [branchMigration, 400],
          ]),
        }
      : { "notes.txt": "branch\n" },
  );
  repo.git("switch", "-q", "main");
  repo.commit("Add the later sequence first", {
    [`${lateDir}/0002_two.sql`]: "CREATE TABLE two (value INT);\n",
    [lateJournal]: journal(lateBase.slice(0, 2)),
  });
  repo.commit("Merge the lower sequence late", {
    [`${lateDir}/0001_one.sql`]: "CREATE TABLE one (value INT);\n",
    [lateJournal]: integrationJournal,
    "notes.txt": "integration\n",
  });
  repo.git("switch", "-q", "feature");
  exit(repo.gitTry("merge", "main"), 1);
  exit(repo.script("conflict-map.ts"), 0);
}

function stageJournal(repo: Scratch, entries: [string, number][]): void {
  repo.write(lateJournal, journal(entries));
  repo.git("add", "--", lateJournal);
}

test("accepts a branch migration appended to an out-of-order integration journal", () => {
  const repo = new Scratch();
  try {
    lateMerge(repo, true);
    stageJournal(repo, [...lateBase, ["0003_feature", 400]]);
    exit(repo.script("record.ts", [lateJournal, "regenerated"]), 0);
    exit(repo.script("check-resolution.ts"), 0);
  } finally {
    repo.cleanup();
  }
});

test("renumbers a branch migration after an out-of-order integration journal", () => {
  const repo = new Scratch();
  const first = `${lateDir}/0001_feature.sql`;
  const moved = `${lateDir}/0003_feature.sql`;
  try {
    lateMerge(repo, true, journal(lateBase), "0001_feature");
    repo.write(moved, featureSql);
    repo.git("rm", "-q", "--", first);
    stageJournal(repo, [...lateBase, ["0003_feature", 400]]);
    repo.git("add", "--", moved);
    exit(
      repo.script("record.ts", [
        first,
        "deleted",
        "--reason",
        `Renumbered to ${moved}.`,
      ]),
      0,
    );
    exit(repo.script("record.ts", [lateJournal, "regenerated"]), 0);
    exit(repo.script("check-resolution.ts"), 0);
  } finally {
    repo.cleanup();
  }
});

test("accepts a branch without migrations over an out-of-order integration journal", () => {
  const repo = new Scratch();
  try {
    lateMerge(repo, false);
    repo.write("notes.txt", "branch\nintegration\n");
    repo.git("add", "--", "notes.txt");
    exit(repo.script("record.ts", ["notes.txt", "combined"]), 0);
    exit(repo.script("check-resolution.ts"), 0);
  } finally {
    repo.cleanup();
  }
});

test.each<[string, [string, number][]]>([
  [
    "drops an integration entry",
    [
      ["0000_init", 100],
      ["0002_two", 200],
      ["0003_feature", 400],
    ],
  ],
  [
    "puts the branch migration before an integration entry",
    [
      ["0000_init", 100],
      ["0002_two", 200],
      ["0003_feature", 250],
      ["0001_one", 300],
    ],
  ],
  [
    "reorders the integration entries",
    [
      ["0000_init", 100],
      ["0001_one", 150],
      ["0002_two", 200],
      ["0003_feature", 400],
    ],
  ],
  [
    "appends the branch migration below the integration watermark",
    [...lateBase, ["0003_feature", 250]],
  ],
])("refuses a resolution that %s", (_, entries) => {
  const repo = new Scratch();
  try {
    lateMerge(repo, true);
    stageJournal(repo, entries);
    exit(repo.script("record.ts", [lateJournal, "regenerated"]), 0);
    const check = repo.script("check-resolution.ts");
    exit(check, 1);
    expect(check.stdout).toContain(lateJournal);
  } finally {
    repo.cleanup();
  }
});

test("refuses an integration journal it cannot decode", () => {
  const repo = new Scratch();
  try {
    const undecodable = JSON.stringify({
      entries: lateBase.map(([tag], idx) => ({ idx, tag })),
    });
    lateMerge(repo, true, undecodable);
    stageJournal(repo, [...lateBase, ["0003_feature", 400]]);
    exit(repo.script("record.ts", [lateJournal, "regenerated"]), 0);
    const check = repo.script("check-resolution.ts");
    exit(check, 1);
    expect(check.stdout).toContain(
      "cannot verify the committed integration journal",
    );
  } finally {
    repo.cleanup();
  }
});
