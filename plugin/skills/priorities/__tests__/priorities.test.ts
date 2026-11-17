/**
 * The priorities skill's script, run as a subprocess: record validation, the
 * weights file's report, the shortlist diff against the dispatcher's newest
 * ranking, and the hand-off of batchable signals to work-batch.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { dump } from "../../../shared/yaml.ts";
import { rank } from "../../../shared/priorities/ranker.ts";
import {
  epic,
  input,
  item,
} from "../../../shared/__tests__/priorities-fixtures.ts";

const script = join(import.meta.dir, "..", "scripts", "priorities.ts");
const scratch = mkdtempSync(join(tmpdir(), "jig-priorities-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The child's environment, its home moved under the scratch directory. */
function env(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("JIG_") && !k.startsWith("DRIVE_PR_"))
      out[k] = v;
  out.HOME = home;
  out.JIG_HOME = join(home, ".jig");
  return out;
}

function run(args: string[], home = join(scratch, "home"), stdin = "") {
  const result = Bun.spawnSync([process.execPath, script, ...args], {
    cwd: scratch,
    env: env(home),
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ...result,
    out: result.stdout.toString() + result.stderr.toString(),
  };
}

let n = 0;
function file(value: unknown): string {
  const path = join(scratch, `record-${n++}.yaml`);
  writeFileSync(path, typeof value === "string" ? value : dump(value));
  return path;
}

const objective = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  class: "core",
  purpose: `${id} purpose`,
  endState: `${id} end state`,
  owner: "maintainers",
  epics: [{ scope: "acme/widgets", keys: ["#100"] }],
  ...over,
});
const record = (objectives: unknown[], over: Record<string, unknown> = {}) => ({
  level: "repository",
  scope: "acme/widgets",
  revision: 1,
  objectives,
  ...over,
});

describe("validate", () => {
  test("a repository record validates with no site record and no site fields", () => {
    const result = run([
      "validate",
      "--file",
      file(record([objective("ship")])),
    ]);
    expectSpawnExit(result, 0);
    expect(result.out).toContain(
      "valid priorities/v1 record, repository level",
    );
  });

  test("a reference to another level is a note, never a requirement", () => {
    const refs = objective("follow-site", {
      epics: undefined,
      refs: [{ level: "site", scope: "acme", id: "goal" }],
    });
    delete (refs as Record<string, unknown>).epics;
    const result = run(["validate", "--file", file(record([refs]))]);
    expectSpawnExit(result, 0);
    expect(result.out).toContain("note:");
  });

  const invalid: Array<[string, unknown, string]> = [
    [
      "an unknown field",
      record([objective("a", { capacityLimit: 3 })]),
      "unknown field `capacityLimit`",
    ],
    [
      "an unknown envelope field",
      record([objective("a")], { peripheralFloor: 0.1 }),
      "unknown field `peripheralFloor`",
    ],
    [
      "a duplicate id",
      record([objective("a"), objective("a")]),
      "is a duplicate",
    ],
    [
      "an empty selector",
      record([objective("a", { epics: [{ scope: "acme/widgets" }] })]),
      "selects nothing",
    ],
    [
      "a negative share",
      record([objective("a", { share: -0.1 })]),
      "share is negative",
    ],
    [
      "a share above one",
      record([objective("a", { share: 1.5 })]),
      "share is above one",
    ],
    [
      "a lane's shares above one",
      record([objective("a", { share: 0.6 }), objective("b", { share: 0.5 })]),
      "shares total 1.1, above one",
    ],
    [
      "both epics and refs",
      record([
        objective("a", { refs: [{ level: "site", scope: "s", id: "x" }] }),
      ]),
      "exactly one of epics and refs",
    ],
  ];
  for (const [name, value, problem] of invalid)
    test(`refuses ${name}`, () => {
      const result = run(["validate", "--file", file(value)]);
      expectSpawnExit(result, 1, name);
      expect(result.out).toContain(problem);
    });

  test("refuses a file that is not YAML, and a missing option value", () => {
    expectSpawnExit(run(["validate", "--file", file("level: [")]), 1);
    const missing = run(["validate", "--file"]);
    expectSpawnExit(missing, 2);
    expect(missing.out).toContain("--file needs a value");
  });
});

describe("weights", () => {
  test("a missing file reads as the defaults", () => {
    const result = run(["weights", "--file", join(scratch, "absent.yaml")]);
    expectSpawnExit(result, 0);
    expect(result.out).toContain("core: 50 share 50%");
  });

  test("an unknown lane takes every lane out and names the problem", () => {
    const result = run(["weights", "--file", file("lanes:\n  urgent: 10\n")]);
    expectSpawnExit(result, 1);
    expect(result.out).toContain("unknown lane `urgent`");
    expect(result.out).toContain("every weighted lane is out of rotation");
  });
});

describe("shortlist", () => {
  test("with no dispatcher ranking it says so", () => {
    const result = run(
      ["shortlist", "--repo", "acme/widgets"],
      join(scratch, "empty-home"),
    );
    expectSpawnExit(result, 0);
    expect(result.out).toContain("no dispatcher ranking for acme/widgets");
  });

  test("with no dispatcher ranking a proposal that does not read still fails", () => {
    const broken = file("lanes: [core: 1\n");
    const result = run(
      ["shortlist", "--repo", "acme/widgets", "--weights", broken],
      join(scratch, "empty-home"),
    );
    expectSpawnExit(result, 1);
    expect(result.out).toContain("is not YAML");
  });

  test("shows how a proposed weights file changes the dispatcher's newest shortlist", () => {
    const home = join(scratch, "ranked-home");
    const root = join(home, ".local", "state", "jig", "dispatch");
    mkdirSync(root, { recursive: true });
    const ranked = input({
      snapshot: {
        readAt: "2026-11-17T06:00:00.000Z",
        items: [
          epic("#100"),
          item("#101", { parent: "#100" }),
          epic("#200"),
          item("#201", { parent: "#200" }),
        ],
      },
      capacity: { starts: 1 },
    });
    const output = rank(ranked);
    const seed = join(scratch, "seed.ts");
    const plugin = join(import.meta.dir, "..", "..", "..");
    writeFileSync(
      seed,
      [
        `import { stateDb } from ${JSON.stringify(join(plugin, "dispatch/lib/state.ts"))};`,
        `import { ALLOCATION_TABLES_SQL, saveRanking } from ${JSON.stringify(join(plugin, "dispatch/lib/allocation-store.ts"))};`,
        `const db = stateDb(${JSON.stringify(root)});`,
        `if (db.query("SELECT 1 FROM sqlite_master WHERE name = 'allocation_ranking'").get() === null) db.exec(ALLOCATION_TABLES_SQL);`,
        `saveRanking(db, "acme/widgets", ${JSON.stringify(ranked)}, ${JSON.stringify(output)}, {}, 1);`,
        "db.close();",
      ].join("\n"),
    );
    const seeded = Bun.spawnSync([process.execPath, seed], {
      env: env(home),
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(seeded, 0, "seed");
    const same = run(["shortlist", "--repo", "acme/widgets"], home);
    expectSpawnExit(same, 0);
    expect(same.out).toContain("leaves the shortlist as it is");
    const changed = run(
      [
        "shortlist",
        "--repo",
        "acme/widgets",
        "--weights",
        file("lanes:\n  core: 0\n"),
        "--json",
      ],
      home,
    );
    expectSpawnExit(changed, 0);
    const diff = JSON.parse(changed.stdout.toString()).diff;
    expect(diff.removed.map((r: { key: string }) => r.key)).toEqual(["#101"]);
    expect(diff.added.map((a: { key: string }) => a.key)).toEqual(["#201"]);
    expect(
      diff.shares.find((s: { lane: string }) => s.lane === "core"),
    ).toMatchObject({ from: 0.5, to: 0 });
    expect(JSON.parse(changed.stdout.toString()).problems).toEqual([]);
    const broken = file("lanes: [core: 1\n");
    const refused = run(
      ["shortlist", "--repo", "acme/widgets", "--weights", broken, "--json"],
      home,
    );
    expectSpawnExit(refused, 1);
    expect(JSON.parse(refused.stdout.toString()).problems[0]).toContain(
      "is not YAML",
    );
    const printed = run(
      ["shortlist", "--repo", "acme/widgets", "--weights", broken],
      home,
    );
    expectSpawnExit(printed, 1);
    expect(printed.out).toContain("problem:");
  });
});

describe("batchable", () => {
  test("hands the issues to work-batch's eligibility mode and returns its exit", () => {
    // Outside a configured repository work-batch refuses, under its own name:
    // the verdict is work-batch's, never a copy of its rules.
    const result = run(["batchable", "--issues", file("[]")]);
    expectSpawnExit(result, 1);
    expect(result.out).toContain("work-batch:");
  });

  test("needs its issues file", () => {
    const result = run(["batchable"]);
    expectSpawnExit(result, 2);
    expect(result.out).toContain("batchable needs --issues");
  });
});
