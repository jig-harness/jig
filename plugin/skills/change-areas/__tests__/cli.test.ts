/**
 * The command lines end to end: the entry scripts spawned in scratch git
 * repositories as a consumer runs them, and `runCli` called in-process with
 * a composer's options.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { runCli } from "../scripts/lib/cli.ts";
import { defaultValidation } from "../scripts/lib/emit.ts";
import {
  commit,
  FIXTURE,
  fakeGit,
  git,
  repository,
  run,
  temporary,
  write,
} from "./helpers.ts";

const CATALOG = readFileSync(FIXTURE, "utf8");

/** A consumer repository whose Jig configuration names the fixture catalog. */
function consumer(): string {
  return repository({
    ".config/jig.yaml":
      "drive:\n  change_areas_catalog: .config/change-areas.yaml\n",
    ".config/change-areas.yaml": CATALOG,
    "docs/guide.md": "# Guide\n",
  });
}

describe("resolve.ts", () => {
  test("--files - reads the changed files from stdin and prints the JSON", () => {
    const result = run(consumer(), "resolve.ts", ["--files", "-"], {
      input: "docs/guide.md\n\ntools/gen/schema.ts\n",
    });
    expectSpawnExit(result, 0);
    const json = JSON.parse(result.stdout);
    expect(json.seedAreas).toEqual(["api-schema", "docs", "tooling"]);
    expect(json.validation.profiles).toEqual(["shallow", "standard"]);
  });

  test("--worktree covers the full workspace and refuses conflicting input modes", () => {
    const root = consumer();
    const base = git(root, "rev-parse", "HEAD").trim();
    commit(root, { "apps/web-app/page.tsx": "committed" }, "web");
    write(root, "docs/guide.md", "unstaged");
    write(root, "tools/staged.ts", "staged");
    git(root, "add", "tools/staged.ts");
    write(root, "docs/new café.md", "untracked");
    const result = run(root, "resolve.ts", ["--worktree", "--base", base]);
    expectSpawnExit(result, 0);
    expect(JSON.parse(result.stdout).changedFiles.sort()).toEqual([
      "apps/web-app/page.tsx",
      "docs/guide.md",
      "docs/new café.md",
      "tools/staged.ts",
    ]);
    expectSpawnExit(
      run(root, "resolve.ts", ["--worktree", "--base", base, "--files", "-"]),
      2,
    );
    expectSpawnExit(run(root, "resolve.ts", ["--worktree"]), 2);
  });

  test("push resolves the last commit, and a merge commit adds its parents' files", () => {
    const root = consumer();
    commit(root, { "apps/web-app/page.tsx": "x" }, "web");
    const push = run(root, "resolve.ts", [
      "--event",
      "push",
      "--format",
      "gha",
    ]);
    expectSpawnExit(push, 0);
    expect(push.stdout).toContain("web-app=true\n");
    expect(push.stdout).toContain("api-service=false\n");

    git(root, "checkout", "-q", "-b", "feature", "HEAD~1");
    commit(root, { "tools/build.ts": "x" }, "tool");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "-m", "merge", "feature");
    // The first-parent diff holds only the tool; the walk adds the web page.
    const merged = run(root, "resolve.ts", ["--event", "push"]);
    expectSpawnExit(merged, 0);
    expect(JSON.parse(merged.stdout).seedAreas).toEqual(["tooling", "web-app"]);
  });

  test("a non-ASCII path from git keeps its name and seeds its area", () => {
    const root = consumer();
    commit(root, { "docs/café.md": "x" }, "accent");
    // Git's default, set here so a machine's own configuration cannot hide
    // it: without -z, the path comes back quoted and octal-escaped.
    const quoting = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.quotePath",
      GIT_CONFIG_VALUE_0: "true",
    };
    const result = run(root, "resolve.ts", ["--event", "push"], {
      env: quoting,
    });
    expectSpawnExit(result, 0);
    const json = JSON.parse(result.stdout);
    expect(json.changedFiles).toEqual(["docs/café.md"]);
    expect(json.seedAreas).toEqual(["docs"]);
  });

  test("--base resolves a pull request against origin/<base>", () => {
    const root = consumer();
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(root, "checkout", "-q", "-b", "feature");
    commit(root, { "packages/core-lib/a.ts": "x" }, "lib");
    const result = run(root, "resolve.ts", ["--base", "main"]);
    expectSpawnExit(result, 0);
    expect(JSON.parse(result.stdout).areas).toContain("web-app");
    // The CI event's variables stand in for the flags.
    const fromEnv = run(root, "resolve.ts", [], {
      env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" },
    });
    expectSpawnExit(fromEnv, 0);
    expect(JSON.parse(fromEnv.stdout).seedAreas).toEqual(["core-lib"]);
  });

  test("--since resolves the whole gap for a dispatched run, and is required for one", () => {
    const root = consumer();
    commit(root, { "docs/a.md": "a" }, "one");
    commit(root, { "search/x.json": "{}" }, "two");
    const gap = run(root, "resolve.ts", [
      "--event",
      "workflow_dispatch",
      "--since",
      "HEAD~2",
    ]);
    expectSpawnExit(gap, 0);
    expect(JSON.parse(gap.stdout).changedFiles).toEqual([
      "docs/a.md",
      "search/x.json",
    ]);
    const missing = run(root, "resolve.ts", ["--event", "workflow_dispatch"]);
    expectSpawnExit(missing, 2);
    expect(missing.stderr).toContain("since ref");
  });

  test("--output-gha appends the outputs beside the JSON, as --format gha appends to $GITHUB_OUTPUT", () => {
    const root = consumer();
    const out = join(temporary(), "outputs");
    writeFileSync(out, "");
    for (let i = 0; i < 2; i++)
      expectSpawnExit(
        run(root, "resolve.ts", ["--files", "-", "--output-gha", out], {
          input: "docs/a.md\n",
        }),
        0,
      );
    const once = readFileSync(out, "utf8");
    expect(once.split("docs=true\n")).toHaveLength(3);
    expect(once.endsWith("web-app-seed=false\n")).toBe(true);

    const env = join(temporary(), "github-output");
    writeFileSync(env, "previous=1\n");
    expectSpawnExit(
      run(root, "resolve.ts", ["--files", "-", "--format", "gha"], {
        input: "docs/a.md\n",
        env: { GITHUB_OUTPUT: env },
      }),
      0,
    );
    expect(readFileSync(env, "utf8")).toStartWith("previous=1\nadr=false\n");
  });

  test("push with a before SHA resolves every commit it carried, from --before or the event payload", () => {
    const root = consumer();
    const before = git(root, "rev-parse", "HEAD").trim();
    commit(root, { "apps/web-app/page.tsx": "x" }, "web");
    commit(root, { "tools/build.ts": "x" }, "tool");
    const seeds = (args: string[], env: Record<string, string> = {}) => {
      const result = run(root, "resolve.ts", args, { env });
      expectSpawnExit(result, 0);
      return JSON.parse(result.stdout).seedAreas;
    };
    expect(seeds(["--event", "push", "--before", before])).toEqual([
      "tooling",
      "web-app",
    ]);
    const payload = join(temporary(), "event.json");
    writeFileSync(payload, JSON.stringify({ before }));
    expect(
      seeds([], { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: payload }),
    ).toEqual(["tooling", "web-app"]);
    // A push that created the branch has no before: the tip alone.
    expect(seeds(["--event", "push", "--before", "0".repeat(40)])).toEqual([
      "tooling",
    ]);
  });

  test("push metadata that names no before commit is refused, not narrowed to the tip", () => {
    const root = consumer();
    commit(root, { "tools/build.ts": "x" }, "tool");
    const payload = join(temporary(), "event.json");
    const env = { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: payload };
    for (const body of [{ before: 123 }, {}, null, { before: "" }]) {
      writeFileSync(payload, JSON.stringify(body));
      const result = run(root, "resolve.ts", [], { env });
      expectSpawnExit(result, 2);
      expect(result.stderr).toContain("without a commit SHA");
    }
    for (const [args, message] of [
      [["--event", "push", "--before", ""], "--before needs a commit"],
      [["--event", "push", "--before", "--cached"], "is not a revision"],
    ] as const) {
      const result = run(root, "resolve.ts", [...args]);
      expectSpawnExit(result, 2);
      expect(result.stderr).toContain(message);
    }
  });

  test("a flag another event's diff needs is refused, not ignored", () => {
    const root = consumer();
    for (const [args, message] of [
      [["--base", "main", "--event", "push"], "--base applies to pull_request"],
      [["--before", "HEAD~1", "--base", "main"], "--before applies to push"],
      [["--since", "HEAD~1"], "--since applies to workflow_dispatch"],
    ] as const) {
      const result = run(root, "resolve.ts", [...args]);
      expectSpawnExit(result, 2);
      expect(result.stderr).toContain(message);
    }
  });

  test("--files keeps each name byte for byte, refuses a path git quoted, and reads any name with -z", () => {
    const root = consumer();
    const spaced = run(root, "resolve.ts", ["--files", "-"], {
      input: " docs/a.md\r\n",
    });
    expectSpawnExit(spaced, 0);
    expect(JSON.parse(spaced.stdout).changedFiles).toEqual([" docs/a.md"]);
    expect(JSON.parse(spaced.stdout).seedAreas).toEqual([]);

    const quoted = run(root, "resolve.ts", ["--files", "-"], {
      input: '"docs/a\\"b.md"\n',
    });
    expectSpawnExit(quoted, 2);
    expect(quoted.stderr).toContain("a path git quoted");

    const nul = run(root, "resolve.ts", ["--files", "-", "-z"], {
      input: 'docs/a"b.md\0docs/c\\d.md\0',
    });
    expectSpawnExit(nul, 0);
    expect(JSON.parse(nul.stdout).changedFiles).toEqual([
      'docs/a"b.md',
      "docs/c\\d.md",
    ]);
    expect(JSON.parse(nul.stdout).seedAreas).toEqual(["docs"]);
  });

  test("--output-gha with no path and no $GITHUB_OUTPUT is refused before anything is written", () => {
    const result = run(
      consumer(),
      "resolve.ts",
      ["--files", "-", "--output-gha"],
      {
        input: "docs/a.md\n",
      },
    );
    expectSpawnExit(result, 2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("needs $GITHUB_OUTPUT");
  });

  test("the static formats and --area-paths need no changed files", () => {
    const root = consumer();
    const dorny = run(root, "resolve.ts", ["--format", "dorny"]);
    expectSpawnExit(dorny, 0);
    expect(dorny.stdout).toStartWith("adr:\n  - docs/adr/**\n");
    const table = run(root, "resolve.ts", ["--format", "review-table"]);
    expectSpawnExit(table, 0);
    expect(table.stdout).toContain("| Core Library | `core-lib` |");
    const paths = run(root, "resolve.ts", ["--area-paths", "ci-infra"]);
    expectSpawnExit(paths, 0);
    expect(paths.stdout).toBe(".github/workflows/**\npackage.json\n");
    const checklist = run(
      root,
      "resolve.ts",
      ["--files", "-", "--format", "checklist"],
      {
        input: "tools/a.ts\n",
      },
    );
    expectSpawnExit(checklist, 0);
    expect(checklist.stdout).toBe(
      "_(No post-deploy actions required for this changeset.)_\n",
    );
  });

  test("a catalog that cannot be read, is invalid or is not configured exits 2", () => {
    const root = consumer();
    const unreadable = run(
      root,
      "resolve.ts",
      ["--files", "-", "--catalog", "nowhere.yaml"],
      {
        input: "",
      },
    );
    expectSpawnExit(unreadable, 2);
    expect(unreadable.stderr).toContain("nowhere.yaml cannot be read");

    write(root, "bad.yaml", "areas:\n  a:\n    title: A\n");
    const invalid = run(root, "resolve.ts", ["--catalog", "bad.yaml"]);
    expectSpawnExit(invalid, 2);
    expect(invalid.stderr).toContain("a: `category` is missing");

    const bare = repository({ "a.txt": "a" });
    const unconfigured = run(bare, "resolve.ts", ["--files", "-"], {
      input: "",
    });
    expectSpawnExit(unconfigured, 2);
    expect(unconfigured.stderr).toContain("drive.change_areas_catalog");
  });

  test("an impliedBy that names no area, the area itself, or a cycle is refused with exit 2", () => {
    const root = consumer();
    const lib =
      "  lib:\n    title: Lib\n    category: library\n    paths: ['lib/**']\n    workspace: []\n    impliedBy: []\n    deployTier: none\n";
    const app = (impliedBy: string) =>
      `  a:\n    title: A\n    category: app\n    paths: ['a/**']\n    workspace: []\n    impliedBy: [${impliedBy}]\n    deployTier: none\n`;
    for (const [impliedBy, problem] of [
      ["libb", "a: impliedBy names unknown area `libb`"],
      ["a", "a: implies itself"],
    ] as const) {
      write(root, "graph.yaml", `areas:\n${lib}${app(impliedBy)}`);
      const result = run(
        root,
        "resolve.ts",
        ["--files", "-", "--catalog", "graph.yaml"],
        {
          input: "lib/x.ts\n",
        },
      );
      expectSpawnExit(result, 2);
      expect(result.stderr).toContain(problem);
      expect(result.stdout).toBe("");
    }
    write(
      root,
      "cycle.yaml",
      `areas:\n${lib.replace("impliedBy: []", "impliedBy: [a]")}${app("lib")}`,
    );
    const cycle = run(root, "resolve.ts", [
      "--format",
      "dorny",
      "--catalog",
      "cycle.yaml",
    ]);
    expectSpawnExit(cycle, 2);
    expect(cycle.stderr).toContain("impliedBy cycle: lib -> a -> lib");
  });

  test("an event with no diff here, or an empty --files, is refused rather than read as a push", () => {
    const root = consumer();
    commit(root, { "tools/a.ts": "x" }, "tool");
    for (const name of ["pull_request_target", "merge_group", "schedule"]) {
      const result = run(root, "resolve.ts", [], {
        env: { GITHUB_EVENT_NAME: name },
      });
      expectSpawnExit(result, 2);
      expect(result.stderr).toContain(`"${name}"`);
      expect(result.stderr).toContain("--event");
    }
    // A flag says which diff to take, whatever the event's name.
    const files = run(root, "resolve.ts", ["--files", "-"], {
      input: "tools/a.ts\n",
      env: { GITHUB_EVENT_NAME: "schedule" },
    });
    expectSpawnExit(files, 0);
    expectSpawnExit(
      run(root, "resolve.ts", ["--event", "push"], {
        env: { GITHUB_EVENT_NAME: "schedule" },
      }),
      0,
    );
    // Unset still means push.
    expect(JSON.parse(run(root, "resolve.ts", []).stdout).seedAreas).toEqual([
      "tooling",
    ]);
    const empty = run(root, "resolve.ts", ["--files", ""]);
    expectSpawnExit(empty, 2);
    expect(empty.stderr).toContain("--files needs a path");
  });

  test("a usage error exits 2 and a failing git exits non-zero", () => {
    const root = consumer();
    expectSpawnExit(run(root, "resolve.ts", ["--format", "xml"]), 2);
    expectSpawnExit(run(root, "resolve.ts", ["--frobnicate"]), 2);
    expectSpawnExit(run(root, "resolve.ts", ["--area-paths", "nope"]), 2);
    expectSpawnExit(run(root, "resolve.ts", ["--files", "missing.txt"]), 2);
    const noRemote = run(root, "resolve.ts", ["--base", "main"]);
    expectSpawnExit(noRemote, 1);
    expect(noRemote.stderr).toContain("origin/main");
    expectSpawnExit(run(root, "resolve.ts", ["--help"]), 0);
  });
});

describe("check.ts", () => {
  test("exits 0 for a sound catalog, 1 with each problem, 2 when unreadable", () => {
    const root = repository({
      ".config/jig.yaml": "drive:\n  change_areas_catalog: catalog.yaml\n",
      "catalog.yaml":
        "areas:\n  docs:\n    title: Docs\n    category: docs\n    paths: ['**']\n    workspace: []\n    impliedBy: []\n    deployTier: none\n",
    });
    const ok = run(root, "check.ts", []);
    expectSpawnExit(ok, 0);
    expect(ok.stdout).toContain("is valid");

    write(
      root,
      "broken.yaml",
      "areas:\n  a:\n    title: A\n    category: docs\n    paths: ['a/**']\n    workspace: [apps/a]\n    impliedBy: [a]\n    deployTier: none\n",
    );
    const broken = run(root, "check.ts", ["--catalog", "broken.yaml"]);
    expectSpawnExit(broken, 1);
    expect(broken.stderr).toContain("broken.yaml: a: implies itself");
    expect(broken.stderr).toContain("workspace `apps/a` is not a directory");

    write(root, "invalid.yaml", "areas:\n  a: {}\n");
    const invalid = run(root, "check.ts", ["--catalog", "invalid.yaml"]);
    expectSpawnExit(invalid, 1);
    expect(invalid.stderr).toContain("a: `title` is missing");

    write(root, "repeated.yaml", "areas:\n  a: {}\n  a: {}\n");
    const repeated = run(root, "check.ts", ["--catalog", "repeated.yaml"]);
    expectSpawnExit(repeated, 2);
    expect(repeated.stderr).toContain("duplicated mapping key");
    expectSpawnExit(run(root, "check.ts", ["--catalog", "nowhere.yaml"]), 2);
    // Outside a repository there are no files to check the catalog against.
    const loose = temporary();
    write(
      loose,
      "catalog.yaml",
      readFileSync(join(root, "catalog.yaml"), "utf8"),
    );
    const unlisted = run(loose, "check.ts", ["--catalog", "catalog.yaml"], {
      env: { GIT_CEILING_DIRECTORIES: dirname(loose) },
    });
    expectSpawnExit(unlisted, 2);
    expect(unlisted.stderr).toContain("cannot be listed");
    expectSpawnExit(run(root, "check.ts", ["--frobnicate"]), 2);
  });
});

describe("a composer", () => {
  const out = () => join(temporary(), "out");

  test("adds fields, GitHub output lines and its own validation plan", async () => {
    const root = temporary();
    write(
      root,
      "catalog.yaml",
      `${CATALOG.replace("    deployTier: none\n    validation:\n      profile: standard", "    deployTier: none\n    reviewRisk: high\n    validation:\n      profile: standard\n      remote: true")}`,
    );
    const options = {
      catalogPath: join(root, "catalog.yaml"),
      fields: {
        area: { reviewRisk: ["high"] },
        validation: { remote: "boolean" },
      } as const,
      ghaOutputs: () => ["code=true"],
      validation: (ctx: Parameters<typeof defaultValidation>[0]) => ({
        ...defaultValidation(ctx),
        localChecks: ["composed"],
      }),
    };
    expect(
      await runCli(["--files", "-", "--catalog", "nowhere.yaml"], options),
    ).toBe(2);
    const gha = out();
    writeFileSync(gha, "");
    const files = join(root, "files.txt");
    writeFileSync(files, "tools/a.ts\n");
    expect(
      await runCli(
        ["--files", files, "--format", "gha", "--output", gha],
        options,
      ),
    ).toBe(0);
    expect(readFileSync(gha, "utf8")).toEndWith(
      "web-app-seed=false\ncode=true\n",
    );
    const json = out();
    expect(await runCli(["--files", files, "--output", json], options)).toBe(0);
    expect(
      JSON.parse(readFileSync(json, "utf8")).validation.localChecks,
    ).toEqual(["composed"]);
    // Without the composer's fields the same catalog is refused.
    expect(
      await runCli(["--files", files], { catalogPath: options.catalogPath }),
    ).toBe(2);
  });

  test("--no-validation routes a catalog with no profiles, which a plan refuses", async () => {
    const root = temporary();
    write(
      root,
      "catalog.yaml",
      [
        "areas:",
        "  ui:",
        "    title: UI",
        "    category: app",
        '    paths: ["ui/**"]',
        "    workspace: []",
        "    impliedBy: []",
        "    deployTier: none",
        '    review: { skills: ["design-review"] }',
        "",
      ].join("\n"),
    );
    const files = join(root, "files.txt");
    writeFileSync(files, "ui/a.tsx\n");
    const options = { catalogPath: join(root, "catalog.yaml") };
    expect(await runCli(["--files", files], options)).toBe(2);
    const json = out();
    expect(
      await runCli(
        ["--files", files, "--no-validation", "--output", json],
        options,
      ),
    ).toBe(0);
    const resolution = JSON.parse(readFileSync(json, "utf8"));
    expect(resolution.reviewSkills).toEqual(["design-review"]);
    expect(resolution.validation).toBeNull();
    expect(
      await runCli(
        ["--files", files, "--no-validation", "--format", "gha"],
        options,
      ),
    ).toBe(2);
  });

  test("supplies the since ref a dispatched run falls back to", async () => {
    const { git: fake, calls } = fakeGit({
      "diff --no-renames --name-only -z origin/stable...HEAD": "docs/a.md\0",
    });
    const json = out();
    const code = await runCli(
      ["--event", "workflow_dispatch", "--output", json],
      {
        catalogPath: FIXTURE,
        defaults: { since: "origin/stable" },
        git: fake,
      },
    );
    expect(code).toBe(0);
    expect(calls[0]).toBe(
      "fetch origin +refs/heads/stable:refs/remotes/origin/stable --quiet",
    );
    expect(JSON.parse(readFileSync(json, "utf8")).seedAreas).toEqual(["docs"]);
    // The flag wins over the composer's default.
    await runCli(
      ["--event", "workflow_dispatch", "--since", "v1", "--output", json],
      {
        catalogPath: FIXTURE,
        defaults: { since: "origin/stable" },
        git: fake,
      },
    );
    expect(calls).toContain("diff --no-renames --name-only -z v1...HEAD");
  });
});
