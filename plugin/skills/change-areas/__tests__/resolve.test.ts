/**
 * The resolver: seed matching, the one-directional `impliedBy` closure, and
 * the git layer driven by a fake git.
 */
import { describe, expect, test } from "bun:test";
import {
  applyImpliedClosure,
  changedFilesFromGit,
  changedFilesFromWorktree,
  GitContextError,
  type GitRunner,
  matchSeedAreas,
  resolveAreas,
  seedGlobs,
  transitiveImpliedBy,
} from "../scripts/lib/resolve.ts";
import { fakeGit, fixture } from "./helpers.ts";

const catalog = fixture();
const seeds = (files: string[]) => [...matchSeedAreas(files, catalog)].sort();
const areas = (files: string[]) => [...resolveAreas(files, catalog)].sort();

describe("seed matching", () => {
  test("a file seeds every area whose globs match it", () => {
    expect(seeds(["docs/adr/0001-record.md"])).toEqual(["adr", "docs"]);
    expect(seeds(["docs/guide.md"])).toEqual(["docs"]);
    expect(seeds(["README.md"])).toEqual(["docs"]);
    // `*.md` matches at the root only.
    expect(seeds(["tools/README.md"])).toEqual(["tooling"]);
  });

  test("a generator's source seeds the area that declares it, even from another area", () => {
    expect(seedGlobs(catalog, "api-schema")).toEqual([
      "packages/api-schema/**",
      "apps/api-service/src/routes/**",
      "tools/gen/schema.ts",
    ]);
    expect(seeds(["tools/gen/schema.ts"])).toEqual(["api-schema", "tooling"]);
    expect(seeds(["apps/api-service/src/routes/orders.ts"])).toEqual([
      "api-schema",
      "api-service",
    ]);
    expect(seedGlobs(catalog, "no-such-area")).toEqual([]);
  });

  test("a file no area matches seeds nothing, and no files resolve to no areas", () => {
    expect(seeds(["stray.txt"])).toEqual([]);
    expect(areas([])).toEqual([]);
  });
});

describe("the impliedBy closure", () => {
  test("is single-direction: two areas sharing an implier do not reach each other", () => {
    expect(areas(["apps/web-app/src/page.tsx"])).toEqual(["web-app"]);
    expect(areas(["apps/api-service/src/app.ts"])).toEqual([
      "api-schema",
      "api-service",
      "search-index",
    ]);
  });

  test("fans out from a shared library to every consumer, transitively", () => {
    expect(areas(["packages/core-lib/src/index.ts"])).toEqual([
      "api-schema",
      "api-service",
      "core-lib",
      "search-index",
      "web-app",
    ]);
  });

  test("fans in: each source of the search index implies it, one at a time", () => {
    expect(areas(["docs/guide.md"])).toEqual(["docs", "search-index"]);
    expect(areas(["apps/api-service/x.ts"])).toContain("search-index");
    expect(areas(["search/schema.json"])).toEqual(["search-index"]);
    expect(areas(["tools/build.ts"])).toEqual(["tooling"]);
  });

  test("starts from the given seed and keeps it", () => {
    expect([...applyImpliedClosure(["ci-infra"], catalog)].sort()).toEqual([
      "api-schema",
      "api-service",
      "ci-infra",
      "search-index",
      "web-app",
    ]);
  });

  test("transitiveImpliedBy follows impliedBy one way, through other areas", () => {
    expect([...transitiveImpliedBy("api-schema", catalog)].sort()).toEqual([
      "api-service",
      "ci-infra",
      "core-lib",
    ]);
    expect([...transitiveImpliedBy("core-lib", catalog)]).toEqual([]);
    expect([...transitiveImpliedBy("no-such-area", catalog)]).toEqual([]);
  });
});

describe("the git layer", () => {
  const SINGLE = { "rev-list --parents -n 1 HEAD": "tip parent" };

  test("push diffs the tip against its parent", () => {
    const { git, calls } = fakeGit({
      ...SINGLE,
      "diff --no-renames --name-only -z HEAD~1 HEAD": "apps/web-app/x.ts\0",
    });
    expect(changedFilesFromGit({ eventName: "push" }, git)).toEqual([
      "apps/web-app/x.ts",
    ]);
    expect(changedFilesFromGit({}, git)).toEqual(["apps/web-app/x.ts"]);
    expect(calls).toContain("diff --no-renames --name-only -z HEAD~1 HEAD");
  });

  test("push with a before SHA diffs the whole push; an all-zero one falls back to the tip", () => {
    const { git, calls } = fakeGit({
      ...SINGLE,
      "diff --no-renames --name-only -z abc123 HEAD": "a\0b\0",
      "diff --no-renames --name-only -z HEAD~1 HEAD": "b\0",
    });
    expect(
      changedFilesFromGit({ eventName: "push", beforeRef: "abc123" }, git),
    ).toEqual(["a", "b"]);
    expect(
      changedFilesFromGit(
        { eventName: "push", beforeRef: "0".repeat(40) },
        git,
      ),
    ).toEqual(["b"]);
    expect(calls).toContain("diff --no-renames --name-only -z abc123 HEAD");
  });

  test("a ref git would read as something else is refused before any git call", () => {
    const { git, calls } = fakeGit({});
    for (const ctx of [
      { eventName: "push" as const, beforeRef: "--cached" },
      { eventName: "push" as const, beforeRef: "" },
      { eventName: "push" as const, head: "-p" },
      { eventName: "pull_request" as const, baseRef: "main --cached" },
      { eventName: "workflow_dispatch" as const, sinceRef: "--all" },
    ])
      expect(() => changedFilesFromGit(ctx, git)).toThrow(GitContextError);
    expect(calls).toEqual([]);
  });

  test("pull_request diffs origin/<base>...<head>, and refuses a missing base", () => {
    const { git, calls } = fakeGit({
      "rev-list --parents -n 1 feature": "tip parent",
      "diff --no-renames --name-only -z origin/main...feature":
        "apps/api-service/y.ts\0\0",
    });
    expect(
      changedFilesFromGit(
        { eventName: "pull_request", baseRef: "main", head: "feature" },
        git,
      ),
    ).toEqual(["apps/api-service/y.ts"]);
    expect(calls[0]).toBe(
      "diff --no-renames --name-only -z origin/main...feature",
    );
    expect(() =>
      changedFilesFromGit({ eventName: "pull_request" }, fakeGit({}).git),
    ).toThrow(GitContextError);
  });

  test("workflow_dispatch fetches the since ref first, then diffs the whole gap", () => {
    const { git, calls } = fakeGit({
      ...SINGLE,
      "diff --no-renames --name-only -z origin/last-green...HEAD":
        "a.md\0tools/x.ts\0",
    });
    expect(
      changedFilesFromGit(
        { eventName: "workflow_dispatch", sinceRef: "origin/last-green" },
        git,
      ),
    ).toEqual(["a.md", "tools/x.ts"]);
    expect(calls.slice(0, 2)).toEqual([
      "fetch origin +refs/heads/last-green:refs/remotes/origin/last-green --quiet",
      "diff --no-renames --name-only -z origin/last-green...HEAD",
    ]);
  });

  test("workflow_dispatch carries on when the fetch fails, and skips it for a local ref", () => {
    const calls: string[] = [];
    const git: GitRunner = (args) => {
      calls.push(args.join(" "));
      if (args[0] === "fetch") throw new Error("no network");
      return args[0] === "diff" ? "docs/a.md\0" : "";
    };
    expect(
      changedFilesFromGit(
        { eventName: "workflow_dispatch", sinceRef: "origin/last-green" },
        git,
      ),
    ).toEqual(["docs/a.md"]);
    const local = fakeGit(SINGLE);
    changedFilesFromGit(
      { eventName: "workflow_dispatch", sinceRef: "refs/tags/last-green" },
      local.git,
    );
    expect(local.calls[0]).toBe(
      "diff --no-renames --name-only -z refs/tags/last-green...HEAD",
    );
    expect(local.calls.some((c) => c.startsWith("fetch"))).toBe(false);
  });

  test("workflow_dispatch without a since ref is refused, not resolved from the tip", () => {
    const { git, calls } = fakeGit({});
    expect(() =>
      changedFilesFromGit({ eventName: "workflow_dispatch" }, git),
    ).toThrow(/since ref/);
    expect(calls).toEqual([]);
  });

  test("a merge commit adds each parent's own files to the first-parent diff", () => {
    const tree = (sha: string) =>
      `diff-tree --no-renames --no-commit-id --name-only -z -r -m --first-parent ${sha}`;
    const { git } = fakeGit({
      // The tip's first-parent diff shows only documentation...
      "diff --no-renames --name-only -z HEAD~1 HEAD": "CHANGES.md\0",
      "rev-list --parents -n 1 HEAD": "merge p1 p2",
      [tree("p1")]: "CHANGES.md\0",
      // ...while the code arrived through the second parent.
      [tree("p2")]: "packages/core-lib/src/a.ts\0",
    });
    const files = changedFilesFromGit({ eventName: "push" }, git);
    expect(files).toEqual(["CHANGES.md", "packages/core-lib/src/a.ts"]);
    expect([...resolveAreas(files, catalog)]).toContain("web-app");
  });

  test("the parent walk runs for every event", () => {
    const tree = (sha: string) =>
      `diff-tree --no-renames --no-commit-id --name-only -z -r -m --first-parent ${sha}`;
    const { git } = fakeGit({
      "diff --no-renames --name-only -z origin/main...HEAD": "",
      "rev-list --parents -n 1 HEAD": "merge p1 p2",
      [tree("p2")]: "tools/gen/schema.ts\0",
    });
    expect(
      changedFilesFromGit({ eventName: "pull_request", baseRef: "main" }, git),
    ).toEqual(["tools/gen/schema.ts"]);
  });

  test("paths are read NUL-separated, so a non-ASCII or spaced name keeps its bytes", () => {
    const tree = (sha: string) =>
      `diff-tree --no-renames --no-commit-id --name-only -z -r -m --first-parent ${sha}`;
    const { git, calls } = fakeGit({
      "diff --no-renames --name-only -z HEAD~1 HEAD":
        "docs/café.md\0docs/two words.md\0",
      "rev-list --parents -n 1 HEAD": "merge p1 p2",
      [tree("p2")]: "docs/naïve\nname.md\0",
    });
    const files = changedFilesFromGit({ eventName: "push" }, git);
    expect(files).toEqual([
      "docs/café.md",
      "docs/two words.md",
      "docs/naïve\nname.md",
    ]);
    expect(seeds(files)).toEqual(["docs"]);
    expect(
      calls.filter((c) => c.startsWith("diff")).every((c) => c.includes(" -z")),
    ).toBe(true);
  });

  test("a failing git command fails the resolution", () => {
    const git: GitRunner = () => {
      throw new Error("bad revision");
    };
    expect(() => changedFilesFromGit({ eventName: "push" }, git)).toThrow(
      "bad revision",
    );
  });
});

describe("working-tree files", () => {
  test("includes committed, staged, unstaged and untracked paths without quoting or duplicates", () => {
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === "merge-base") return "abc123\n";
      if (args[0] === "diff") return "src/café.ts\0docs/a b.md\0";
      return "docs/new.md\0src/café.ts\0";
    };
    expect(changedFilesFromWorktree("origin/main", git)).toEqual([
      "src/café.ts",
      "docs/a b.md",
      "docs/new.md",
    ]);
    expect(calls).toEqual([
      ["merge-base", "origin/main", "HEAD"],
      ["diff", "-z", "--no-renames", "--name-only", "abc123", "--"],
      ["ls-files", "-z", "--others", "--exclude-standard"],
    ]);
  });
  test("refuses unsafe references and failed git reads", () => {
    expect(() => changedFilesFromWorktree("--cached", () => "")).toThrow();
    expect(() =>
      changedFilesFromWorktree("origin/main", () => {
        throw new Error("cannot read git");
      }),
    ).toThrow("cannot read git");
  });
});
