import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../../../plugin/shared/guarded-git-spawn.ts";
import { namedRecords, parseInventory } from "./check-skeleton-adr.ts";

const gate = join(import.meta.dir, "check-skeleton-adr.ts");
const scratch = mkdtempSync(join(tmpdir(), "skeleton-gate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
  ),
);

function git(cwd: string, ...args: string[]) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, env },
  );
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

const adr = (status: string, extra = "") =>
  `---\ntitle: "x"\ntype: adr\nstatus: ${status}\n${extra}---\n\n# x\n`;

const inventory = `# Skeleton files.
decision_records: docs/adr
skeleton:
  - path: docs/architecture/layering.md
    why: the layer rules every package follows
  - path: src/contracts/
    why: the published interfaces
  - glob: "schema/*.sql"
    why: the schema contract
`;

const baseFiles: Record<string, string> = {
  ".config/skeleton.yaml": inventory,
  "docs/architecture/layering.md": "layers\n",
  "src/contracts/api.ts": "export type A = 1;\n",
  "src/contracts/other.ts": "export type B = 1;\n",
  "src/app/impl.ts": "export const a = 1;\n",
  "schema/001.sql": "SELECT 1;\n",
  "schema/009.sql": "SELECT 9;\n",
  "docs/adr/ADR-0001-layers.md": adr("approved"),
  "docs/adr/ADR-0002-draft.md": adr("draft"),
  "docs/adr/ADR-0003-amended.md": adr("amended"),
  "docs/adr/ADR-0004-old.md": adr("approved", "superseded_by: ADR-0005\n"),
  "docs/adr/ADR-0009-list.md": adr("approved", "superseded_by: [ADR-0005]\n"),
  "docs/adr/ADR-0011-map.md": adr(
    "approved",
    "superseded_by: { id: ADR-0005 }\n",
  ),
  "docs/adr/ADR-0012-null.md": adr("approved", "superseded_by: null\n"),
  "docs/adr/ADR-0008-bad-yaml.md": "---\nstatus: [\n---\n",
  "docs/adr/ADR-0006-no-status.md": "---\ntitle: x\n---\n",
  "docs/adr/ADR-0001-layers.png": "not a record\n",
  "docs/adr/ADR-0007-a.md": adr("approved"),
  "docs/adr/ADR-0007-b.md": adr("approved"),
};

function put(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

let counter = 0;
/** A repository with the base files committed on `main`. */
function repo(files: Record<string, string> = {}) {
  const dir = join(scratch, `repo-${counter++}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  put(dir, { ...baseFiles, ...files });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

function run(dir: string, args: string[]) {
  return Bun.spawnSync([process.execPath, gate, ...args], {
    cwd: dir,
    env: { ...env, GITHUB_ACTIONS: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Stage `files` (null deletes) and run the commit-msg hook form. */
function hook(
  dir: string,
  files: Record<string, string | null>,
  message: string,
) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) git(dir, "rm", "-q", path);
    else {
      put(dir, { [path]: content });
      git(dir, "add", path);
    }
  }
  writeFileSync(join(dir, "MSG"), message);
  return run(dir, ["MSG"]);
}

const err = (result: { stderr: Buffer }) => result.stderr.toString();

describe("commit-msg form", () => {
  test("tissue passes without any record", () => {
    const result = hook(
      repo(),
      { "src/app/impl.ts": "export const a = 2;\n" },
      "fix: tissue\n",
    );
    expectSpawnExit(result, 0);
  });

  test("a skeleton file without authority fails and says what to do", () => {
    const result = hook(
      repo(),
      { "docs/architecture/layering.md": "new\n" },
      "docs: edit\n",
    );
    expectSpawnExit(result, 1);
    expect(err(result)).toContain("skeleton-change-unauthorized");
    expect(err(result)).toContain("Decision-Record: ADR-NNNN");
  });

  test("a directory entry and a glob entry both protect their files", () => {
    expectSpawnExit(
      hook(repo(), { "src/contracts/api.ts": "x\n" }, "feat: c\n"),
      1,
    );
    expectSpawnExit(
      hook(repo(), { "schema/002.sql": "SELECT 2;\n" }, "feat: s\n"),
      1,
    );
  });

  test("an approved or amended record in the trailer block authorizes", () => {
    const edit = { "docs/architecture/layering.md": "new\n" };
    expectSpawnExit(
      hook(repo(), edit, "docs: edit\n\nDecision-Record: ADR-0001\n"),
      0,
    );
    expectSpawnExit(
      hook(repo(), edit, "docs: edit\n\ndecision-record: ADR-0003\n"),
      0,
    );
    expectSpawnExit(
      hook(repo(), edit, "docs: edit\n\nDecision-Record: ADR-0012\n"),
      0,
    );
  }, 30_000);

  test("a record that is not approved authorizes nothing", () => {
    const edit = { "docs/architecture/layering.md": "new\n" };
    const cases: [string, string][] = [
      ["ADR-0002", "whose status is `draft`"],
      ["ADR-0004", "superseded"],
      ["ADR-0009", "`superseded_by` is not a record id or null"],
      ["ADR-0011", "`superseded_by` is not a record id or null"],
      ["ADR-0006", "no readable `status`"],
      ["ADR-0007", "resolves to 2 records"],
      ["ADR-0008", "not valid YAML"],
      ["ADR-0099", "does not resolve"],
      ["not-an-id", "is not a record id"],
      ["../ADR-0001", "is not a record id"],
    ];
    for (const [id, expected] of cases) {
      const result = hook(
        repo(),
        edit,
        `docs: edit\n\nDecision-Record: ${id}\n`,
      );
      expectSpawnExit(result, 1);
      expect(err(result)).toContain("skeleton-record-not-approved");
      expect(err(result)).toContain(expected);
    }
  }, 30_000);

  test("a draft among approved records still fails", () => {
    const result = hook(
      repo(),
      { "docs/architecture/layering.md": "new\n" },
      "docs: edit\n\nDecision-Record: ADR-0001\nDecision-Record: ADR-0002\n",
    );
    expectSpawnExit(result, 1);
  });

  test("the trailer counts only in the last paragraph", () => {
    const result = hook(
      repo(),
      { "docs/architecture/layering.md": "new\n" },
      "docs: edit\n\nDecision-Record: ADR-0001\n\nprose after it\n",
    );
    expectSpawnExit(result, 1);
  });

  test("a record approved in the same commit resolves from the index", () => {
    const result = hook(
      repo(),
      {
        "docs/architecture/layering.md": "new\n",
        "docs/adr/ADR-0010-new.md": adr("approved"),
      },
      "docs: edit\n\nDecision-Record: ADR-0010\n",
    );
    expectSpawnExit(result, 0);
  });

  test("updating the inventory in the same change authorizes", () => {
    const result = hook(
      repo(),
      {
        "docs/architecture/layering.md": "new\n",
        ".config/skeleton.yaml": `${inventory}  - path: src/app/impl.ts\n    why: now a contract\n`,
      },
      "docs: edit\n",
    );
    expectSpawnExit(result, 0);
  });

  test("a rename with only a trailer fails: the inventory is stale", () => {
    const dir = repo();
    git(
      dir,
      "mv",
      "docs/architecture/layering.md",
      "docs/architecture/layers.md",
    );
    writeFileSync(
      join(dir, "MSG"),
      "docs: rename\n\nDecision-Record: ADR-0001\n",
    );
    const result = run(dir, ["MSG"]);
    expectSpawnExit(result, 1);
    expect(err(result)).toContain("skeleton-inventory-stale");
    expect(err(result)).toContain("docs/architecture/layering.md");
  });

  test("a rename that updates the inventory passes", () => {
    const dir = repo();
    git(
      dir,
      "mv",
      "docs/architecture/layering.md",
      "docs/architecture/layers.md",
    );
    put(dir, {
      ".config/skeleton.yaml": inventory.replace("layering.md", "layers.md"),
    });
    git(dir, "add", ".config/skeleton.yaml");
    writeFileSync(join(dir, "MSG"), "docs: rename\n");
    expectSpawnExit(run(dir, ["MSG"]), 0);
  });

  test("a stale inventory fails even when only tissue is touched", () => {
    const dir = repo({
      ".config/skeleton.yaml": `${inventory}  - path: docs/gone.md\n    why: was renamed away earlier\n`,
    });
    const result = hook(
      dir,
      { "src/app/impl.ts": "export const a = 3;\n" },
      "fix: tissue\n",
    );
    expectSpawnExit(result, 1);
    expect(err(result)).toContain("skeleton-inventory-stale");
    expect(err(result)).toContain("docs/gone.md");
    expect(err(result)).not.toContain("unauthorized");
  });

  test("a file moved out of a directory entry needs the inventory edited", () => {
    const dir = repo();
    git(dir, "mv", "src/contracts/api.ts", "src/app/api.ts");
    writeFileSync(
      join(dir, "MSG"),
      "refactor: move\n\nDecision-Record: ADR-0001\n",
    );
    const result = run(dir, ["MSG"]);
    expectSpawnExit(result, 1);
    expect(err(result)).toContain("skeleton-file-moved-out");
    expect(err(result)).toContain("src/app/api.ts");
    // The inventory covering the new path settles it.
    put(dir, {
      ".config/skeleton.yaml": `${inventory}  - path: src/app/api.ts\n    why: the interface moved\n`,
    });
    git(dir, "add", ".config/skeleton.yaml");
    expectSpawnExit(run(dir, ["MSG"]), 0);
  });

  test("a move between two skeleton entries is not a move out", () => {
    const dir = repo();
    git(dir, "mv", "schema/001.sql", "src/contracts/001.sql");
    writeFileSync(
      join(dir, "MSG"),
      "refactor: move\n\nDecision-Record: ADR-0001\n",
    );
    expectSpawnExit(run(dir, ["MSG"]), 0);
  });

  test("a merge in progress is left to the range form", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "topic");
    put(dir, { "src/app/topic.ts": "1\n" });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "topic");
    git(dir, "checkout", "-q", "main");
    put(dir, { "src/contracts/api.ts": "2\n" });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "c\n\nDecision-Record: ADR-0001");
    git(dir, "checkout", "-q", "topic");
    git(dir, "merge", "--no-commit", "--no-ff", "main");
    writeFileSync(join(dir, "MSG"), "Merge branch 'main'\n");
    expectSpawnExit(run(dir, ["MSG"]), 0);
    // The range form diffs from the merge-base: the topic's own change only.
    expectSpawnExit(run(dir, ["--base", "main", "--head", "topic"]), 0);
  });

  test("a path with glob characters in its name matches exactly", () => {
    const inv = `${inventory}  - path: app/[id]/page.tsx\n    why: the route contract\n`;
    const files = { ".config/skeleton.yaml": inv, "app/[id]/page.tsx": "1\n" };
    const dir = repo(files);
    expectSpawnExit(
      hook(dir, { "src/app/impl.ts": "9\n" }, "fix: tissue\n"),
      0,
    );
    expectSpawnExit(
      hook(dir, { "app/[id]/page.tsx": "2\n" }, "feat: route\n"),
      1,
    );
    // A sibling the brackets would match as a pattern is tissue.
    expectSpawnExit(
      hook(repo(files), { "app/i/page.tsx": "1\n" }, "feat: other\n"),
      0,
    );
    // So a rename onto such a sibling leaves the listed path stale.
    const moved = repo(files);
    mkdirSync(join(moved, "app/i"));
    git(moved, "mv", "app/[id]/page.tsx", "app/i/page.tsx");
    writeFileSync(
      join(moved, "MSG"),
      "refactor: move\n\nDecision-Record: ADR-0001\n",
    );
    const result = run(moved, ["MSG"]);
    expectSpawnExit(result, 1);
    expect(err(result)).toContain("skeleton-inventory-stale");
  }, 30_000);

  test("a deleted skeleton file needs authority too", () => {
    const result = hook(
      repo(),
      { "src/contracts/api.ts": null },
      "refactor: drop\n",
    );
    expectSpawnExit(result, 1);
    expect(err(result)).toContain("skeleton-change-unauthorized");
  });
});

describe("could not check", () => {
  test("a missing, empty or malformed inventory is exit 2", () => {
    const bad: Record<string, string> = {
      empty: "skeleton: []\n",
      "no-why": "skeleton:\n  - path: a.md\n",
      "not-yaml": "skeleton: [\n",
      escapes: "skeleton:\n  - path: ../a.md\n    why: x\n",
      "path-and-glob": "skeleton:\n  - path: a.md\n    glob: a*\n    why: x\n",
      "bad-statuses": `approved_statuses: []\n${inventory}`,
    };
    for (const [label, content] of Object.entries(bad)) {
      const result = hook(
        repo({ ".config/skeleton.yaml": content }),
        {},
        "chore: x\n",
      );
      expect([label, result.exitCode]).toEqual([label, 2]);
      expect(err(result)).toContain("could not check");
    }
    const dir = repo();
    git(dir, "rm", "-q", ".config/skeleton.yaml");
    writeFileSync(join(dir, "MSG"), "chore: x\n");
    expectSpawnExit(run(dir, ["MSG"]), 2);
  }, 30_000);

  test("a missing message file and bad usage are exit 2", () => {
    const dir = repo();
    expectSpawnExit(run(dir, ["nope"]), 2);
    expectSpawnExit(run(dir, []), 2);
    expectSpawnExit(run(dir, ["--base", "main"]), 2);
  });

  test("an unreadable git ref is exit 2, not a pass", () => {
    expectSpawnExit(run(repo(), ["--base", "nope", "--head", "main"]), 2);
  });

  test("a git diff killed by a signal is exit 2, not an empty change", () => {
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("git is not on PATH");
    const bin = join(scratch, `bin-${counter++}`);
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = diff ] && kill -9 $$; done\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    const dir = repo();
    put(dir, { "src/contracts/api.ts": "2\n" });
    git(dir, "add", "-A");
    writeFileSync(join(dir, "MSG"), "feat: api\n");
    const result = Bun.spawnSync([process.execPath, gate, "MSG"], {
      cwd: dir,
      env: { ...env, GITHUB_ACTIONS: "", PATH: `${bin}:${env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(result, 2);
  });
});

describe("range form", () => {
  function branch(dir: string, commits: [Record<string, string>, string][]) {
    git(dir, "checkout", "-q", "-b", "topic");
    for (const [files, message] of commits) {
      put(dir, files);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", message);
    }
    return run(dir, ["--base", "main", "--head", "topic"]);
  }

  test("tissue passes; skeleton without authority fails", () => {
    expectSpawnExit(
      branch(repo(), [[{ "src/app/impl.ts": "2\n" }, "fix: x"]]),
      0,
    );
    const result = branch(repo(), [
      [{ "src/contracts/api.ts": "2\n" }, "feat: x"],
    ]);
    expectSpawnExit(result, 1);
    expect(err(result)).toContain("skeleton-change-unauthorized");
  });

  test("a trailer on any commit of the range authorizes the range", () => {
    const result = branch(repo(), [
      [{ "src/contracts/api.ts": "2\n" }, "feat: x"],
      [{ "src/app/impl.ts": "2\n" }, "fix: y\n\nDecision-Record: ADR-0001"],
    ]);
    expectSpawnExit(result, 0);
  });

  test("a draft record fails the range", () => {
    const result = branch(repo(), [
      [
        { "src/contracts/api.ts": "2\n" },
        "feat: x\n\nDecision-Record: ADR-0002",
      ],
    ]);
    expectSpawnExit(result, 1);
  });

  test("a rename in the range without the inventory fails stale", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "topic");
    git(dir, "mv", "src/contracts/api.ts", "src/contracts/api2.ts");
    git(dir, "commit", "-q", "-m", "refactor\n\nDecision-Record: ADR-0001");
    // The directory entry still matches the moved file, so only authority matters.
    expectSpawnExit(run(dir, ["--base", "main", "--head", "topic"]), 0);
    git(dir, "mv", "docs/architecture/layering.md", "docs/architecture/x.md");
    git(dir, "commit", "-q", "-m", "docs\n\nDecision-Record: ADR-0001");
    const result = run(dir, ["--base", "main", "--head", "topic"]);
    expectSpawnExit(result, 1);
    expect(err(result)).toContain("skeleton-inventory-stale");
  });

  test("an inventory edit in the range authorizes", () => {
    const result = branch(repo(), [
      [
        {
          "src/contracts/api.ts": "2\n",
          ".config/skeleton.yaml": `${inventory}  - path: src/app/impl.ts\n    why: now a contract\n`,
        },
        "feat: x",
      ],
    ]);
    expectSpawnExit(result, 0);
  });

  test("an inventory edit listing a missing file still fails stale", () => {
    const result = branch(repo(), [
      [
        {
          "src/contracts/api.ts": "2\n",
          ".config/skeleton.yaml": `${inventory}  - path: NOTICE\n    why: legal\n`,
        },
        "feat: x",
      ],
    ]);
    expectSpawnExit(result, 1);
    expect(err(result)).toContain("skeleton-inventory-stale");
    expect(err(result)).not.toContain("unauthorized");
  });

  test("a file moved out of a directory entry fails the range", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "topic");
    git(dir, "mv", "src/contracts/api.ts", "src/app/api.ts");
    git(dir, "commit", "-q", "-m", "refactor\n\nDecision-Record: ADR-0001");
    const result = run(dir, ["--base", "main", "--head", "topic"]);
    expectSpawnExit(result, 1);
    expect(err(result)).toContain("skeleton-file-moved-out");
    expect(err(result)).toContain("src/app/api.ts");
  });
});

describe("parsing", () => {
  test("namedRecords reads the last paragraph's trailers only", () => {
    expect(
      namedRecords("a\n\nDecision-Record: ADR-0001\n", "Decision-Record"),
    ).toEqual(["ADR-0001"]);
    expect(
      namedRecords("a\n\nDecision-Record: ADR-0001\n\nb\n", "Decision-Record"),
    ).toEqual([]);
    expect(
      namedRecords(
        "a\n\nSigned-off-by: x\nDecision-Record: ADR-2\n# comment\n",
        "Decision-Record",
      ),
    ).toEqual(["ADR-2"]);
    expect(namedRecords("Decision-Record: ADR-1", "Decision-Record")).toEqual([
      "ADR-1",
    ]);
    const verbose =
      "a\n\nDecision-Record: ADR-1\n# ------------------------ >8 ------------------------\n# Do not modify.\ndiff --git a/x b/x\n\n+Decision-Record: ADR-9\n";
    expect(namedRecords(verbose, "Decision-Record")).toEqual(["ADR-1"]);
  });

  test("the inventory defaults and its required fields", () => {
    const parsed = parseInventory(inventory);
    expect(parsed.approvedStatuses).toEqual(["approved", "amended"]);
    expect(parsed.trailer).toBe("Decision-Record");
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries.map((entry) => entry.glob)).toEqual([
      false,
      false,
      true,
    ]);
  });
});
