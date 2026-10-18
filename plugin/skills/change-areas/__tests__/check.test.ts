/**
 * The invariants beyond the schema: the impliedBy graph, the workspaces and
 * the generated files, checked against a scratch repository on disk.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Catalog, validateCatalog } from "../scripts/lib/catalog.ts";
import {
  checkCatalog,
  generatedProblems,
  graphProblems,
  outputNameProblems,
  repositoryFiles,
  uncoveredFiles,
  workspaceProblems,
} from "../scripts/lib/check.ts";
import { fixture, repository, temporary, write } from "./helpers.ts";

const area = (paths: string[], impliedBy: string[] = [], extra = {}) => ({
  title: "An area",
  category: "library",
  paths,
  workspace: [],
  impliedBy,
  deployTier: "none",
  ...extra,
});
const catalogOf = (areas: Record<string, unknown>): Catalog =>
  validateCatalog({ areas });

describe("the impliedBy graph", () => {
  test("the fixture's graph is sound", () => {
    expect(graphProblems(fixture())).toEqual([]);
  });

  test("a reference to no area and an area implying itself are named", () => {
    expect(
      graphProblems(
        catalogOf({ a: area(["a/**"], ["a", "ghost", "constructor"]) }),
      ),
    ).toEqual([
      "a: implies itself",
      "a: impliedBy names unknown area `ghost`",
      "a: impliedBy names unknown area `constructor`",
    ]);
  });

  test("one cycle is reported as its path", () => {
    expect(
      graphProblems(
        catalogOf({
          a: area(["a/**"], ["c"]),
          b: area(["b/**"], ["a"]),
          c: area(["c/**"], ["b"]),
          d: area(["d/**"], ["d"]),
        }),
      ),
    ).toEqual(["d: implies itself", "impliedBy cycle: a -> c -> b -> a"]);
  });
});

describe("the repository's facts", () => {
  test("a workspace must be a directory", () => {
    const root = temporary();
    write(root, "apps/file", "x");
    const catalog = catalogOf({
      api: area(["apps/**"], [], { workspace: ["apps/api", "apps/file"] }),
    });
    expect(workspaceProblems(catalog, { root, trackedFiles: [] })).toEqual([
      "api: workspace `apps/api` is not a directory",
      "api: workspace `apps/file` is not a directory",
    ]);
  });

  test("a workspace is covered through the globs: a broad glob covers it, a partial one does not", () => {
    const root = temporary();
    mkdirSync(join(root, "apps", "web"), { recursive: true });
    mkdirSync(join(root, "apps", "empty"), { recursive: true });
    const trackedFiles = ["apps/web/src/main.ts", "apps/web/docs/a.md"];
    const ctx = { root, trackedFiles };
    expect(
      workspaceProblems(
        catalogOf({ web: area(["apps/**"], [], { workspace: ["apps/web"] }) }),
        ctx,
      ),
    ).toEqual([]);
    expect(
      workspaceProblems(
        catalogOf({
          web: area(["apps/web/docs/**"], [], { workspace: ["apps/web"] }),
        }),
        ctx,
      ),
    ).toEqual([
      "web: workspace `apps/web` holds 1 file(s) the area's own paths do not match, such as `apps/web/src/main.ts`; widen the area's paths to cover `apps/web/**`",
    ]);
    // Another area's glob covering the rest does not discharge the owner's:
    // a change to `src` would never seed `web`.
    expect(
      workspaceProblems(
        catalogOf({
          web: area(["apps/web/docs/**"], [], { workspace: ["apps/web"] }),
          src: area(["apps/web/src/**"]),
        }),
        ctx,
      ),
    ).toEqual([
      "web: workspace `apps/web` holds 1 file(s) the area's own paths do not match, such as `apps/web/src/main.ts`; widen the area's paths to cover `apps/web/**`",
    ]);
    expect(
      workspaceProblems(
        catalogOf({
          web: area(["services/**"], [], { workspace: ["apps/web"] }),
          rest: area(["apps/**"]),
        }),
        ctx,
      ),
    ).toEqual([
      "web: workspace `apps/web` is matched by none of the area's paths; add one that covers `apps/web/**`",
    ]);
    // A workspace with no files yet is covered by a glob inside it or by an
    // ancestor glob that would match a file under it.
    expect(
      workspaceProblems(
        catalogOf({
          a: area(["apps/empty/**"], [], { workspace: ["apps/empty"] }),
          broad: area(["apps/**"], [], { workspace: ["apps/empty"] }),
          star: area(["apps/*/**"], [], { workspace: ["apps/empty"] }),
          b: area(["other/**"], [], { workspace: ["apps/empty"] }),
          shallow: area(["apps/*"], [], { workspace: ["apps/empty"] }),
          // A glob constrained below the workspace still matches a file in it.
          deeper: area(["apps/*/src/**"], [], { workspace: ["apps/empty"] }),
          ext: area(["**/*.ts"], [], { workspace: ["apps/empty"] }),
          braces: area(["{lib,apps/empty}/**"], [], {
            workspace: ["apps/empty"],
          }),
          sibling: area(["apps/{web,api}/**"], [], {
            workspace: ["apps/empty"],
          }),
          embedded: area(["apps/other**/src/**"], [], {
            workspace: ["apps/empty"],
          }),
          spanning: area(["apps/e**"], [], { workspace: ["apps/empty"] }),
        }),
        ctx,
      ),
    ).toEqual([
      "b: workspace `apps/empty` is matched by none of the area's paths; add one that covers `apps/empty/**`",
      "shallow: workspace `apps/empty` is matched by none of the area's paths; add one that covers `apps/empty/**`",
      "sibling: workspace `apps/empty` is matched by none of the area's paths; add one that covers `apps/empty/**`",
      "embedded: workspace `apps/empty` is matched by none of the area's paths; add one that covers `apps/empty/**`",
    ]);
  });

  test("a workspace is written as git lists paths", () => {
    const root = temporary();
    mkdirSync(join(root, "apps", "web"), { recursive: true });
    const ctx = { root, trackedFiles: ["apps/web/src/main.ts"] };
    expect(
      workspaceProblems(
        catalogOf({
          dot: area(["./apps/web/docs/**"], [], { workspace: ["./apps/web"] }),
          slash: area(["apps/**"], [], { workspace: ["apps/web/"] }),
          up: area(["apps/**"], [], { workspace: ["apps/../apps/web"] }),
        }),
        ctx,
      ),
    ).toEqual([
      "dot: workspace `./apps/web` is not a repository-relative path in canonical form; write it as git lists paths, such as `apps/web`",
      "slash: workspace `apps/web/` is not a repository-relative path in canonical form; write it as git lists paths, such as `apps/web`",
      "up: workspace `apps/../apps/web` is not a repository-relative path in canonical form; write it as git lists paths, such as `apps/web`",
    ]);
  });

  test("an area keyed like another's seed output is refused", () => {
    expect(
      outputNameProblems(
        catalogOf({
          app: area(["app/**"]),
          "app-seed": area(["seed/**"]),
          "lib-seed": area(["lib/**"]),
        }),
      ),
    ).toEqual([
      "app-seed: its GitHub output collides with the seed output of `app`; rename one of them",
    ]);
  });

  test("a generated output is a file, declared once, matched by its own area's paths", () => {
    const root = temporary();
    write(root, "gen/out.json", "{}");
    write(root, "src/input.yaml", "x: 1");
    const gen = (outputs: string[]) => ({
      generated: [
        {
          outputs,
          source: ["src/input.yaml"],
          command: "g",
          check: "g --check",
        },
      ],
    });
    const catalog = catalogOf({
      gen: area(
        ["gen/**", "src/**"],
        [],
        gen(["gen/out.json", "gen/missing.json"]),
      ),
      other: area(["other/**"], [], gen(["gen/out.json"])),
    });
    expect(
      generatedProblems(catalog, {
        root,
        trackedFiles: ["src/input.yaml", "gen/out.json"],
      }),
    ).toEqual([
      "gen: generated output `gen/missing.json` is not a file",
      "other: generated output `gen/out.json` is not matched by the area's own paths; add it to them",
      "generated output `gen/out.json` is declared by both `gen` and `other`; each output has one owning area",
    ]);
  });

  test("a generated source matches a file of the repository, and every file it matches has an area", () => {
    const root = temporary();
    write(root, "out.json", "{}");
    const entry = (source: string[]) => ({
      generated: [
        { outputs: ["out.json"], source, command: "g", check: "g --check" },
      ],
    });
    const trackedFiles = ["out.json", "src/a.yaml", "loose/b.yaml"];
    expect(
      generatedProblems(
        catalogOf({
          gen: area(
            ["out.json", "src/**"],
            [],
            entry(["src/*.yaml", "src/gone.yaml"]),
          ),
        }),
        { root, trackedFiles },
      ),
    ).toEqual([
      "gen: generated source `src/gone.yaml` matches no file of the repository; fix the path or drop the entry",
    ]);
    expect(
      generatedProblems(
        catalogOf({
          gen: area(["out.json", "src/**"], [], entry(["**/*.yaml"])),
        }),
        { root, trackedFiles },
      ),
    ).toEqual([
      "gen: generated source `**/*.yaml` matches `loose/b.yaml`, which no area's paths match; add it to the owning area's paths",
    ]);
  });

  test("checkCatalog runs every invariant, and the fixture breaks only what a bare directory lacks", () => {
    const problems = checkCatalog(fixture(), {
      root: temporary(),
      trackedFiles: [],
    });
    expect(problems).toContain(
      "web-app: workspace `apps/web-app` is not a directory",
    );
    expect(problems).toContain(
      "api-schema: generated source `tools/gen/schema.ts` matches no file of the repository; fix the path or drop the entry",
    );
    expect(problems.some((p) => p.includes("cycle"))).toBe(false);
  });
});

test("uncoveredFiles lists the files no area claims, a generator's source counting as claimed", () => {
  const catalog = catalogOf({
    a: area(["a/**"], [], {
      generated: [
        {
          outputs: ["a/out"],
          source: ["gen/in.txt"],
          command: "g",
          check: "c",
        },
      ],
    }),
  });
  expect(uncoveredFiles(["a/x", "gen/in.txt", "stray"], catalog)).toEqual([
    "stray",
  ]);
});

test("repositoryFiles lists tracked and untracked files, not ignored ones", () => {
  const root = repository({ ".gitignore": "*.log\n", "a.txt": "a" });
  write(root, "new.txt", "n");
  write(root, "debug.log", "x");
  expect(repositoryFiles(root).sort()).toEqual([
    ".gitignore",
    "a.txt",
    "new.txt",
  ]);
});
