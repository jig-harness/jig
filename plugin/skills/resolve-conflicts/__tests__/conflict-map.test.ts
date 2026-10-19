/**
 * conflict-map.ts against real scratch repositories: side roles per
 * operation, kinds, classes, conflict regions, intent commits, and the
 * snapshot it keeps between runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mergeSnapshot } from "../scripts/conflict-map.ts";
import { CONFIG_BASE, mergeConflict, Scratch } from "./scratch.ts";

let s: Scratch;
beforeEach(() => {
  s = new Scratch();
});
afterEach(() => s.cleanup());

interface MappedPath {
  kind: string;
  class: string;
  regenerate: { command: string; cwd: string; source: string } | null;
  stages: Record<string, { blob: string } | null>;
  hunks: {
    start: number;
    end: number;
    ours: string;
    base: string | null;
    theirs: string;
  }[];
  intent: Record<
    "ours" | "theirs",
    {
      commits: { subject: string; pr: number | null }[];
      truncated: boolean;
      renamedTo: string | null;
    }
  >;
  resolution: { decision: string | null; reason: string | null };
}

interface Map {
  operation: { kind: string; head: string; incoming: string };
  sides: Record<"ours" | "theirs", { ref: string | null; role: string }> & {
    integration: string;
  };
  warning: string | null;
  catalogIncomplete?: string | null;
  paths: Record<string, MappedPath>;
}

function map(...args: string[]): Map {
  const r = s.script("conflict-map.ts", ["--json", ...args]);
  expect(r.stderr).not.toContain("error");
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout);
}

describe("a merge", () => {
  it("names the sides, the kind, the conflict region and each side's commits", () => {
    mergeConflict(s);
    const m = map();
    expect(m.operation.kind).toBe("merge");
    expect(m.sides.ours.ref).toBe("feature");
    expect(m.sides.ours.role).toContain("checked-out branch");
    expect(m.sides.theirs.ref).toBe("main");
    expect(m.sides.theirs.role).toContain("being merged in");
    expect(m.sides.integration).toBe("theirs");
    expect(m.warning).toBeNull();

    const path = m.paths["src/config.ts"] as MappedPath;
    expect(path.kind).toBe("both-modified");
    expect(path.class).toBe("text");
    expect(path.stages.base).not.toBeNull();
    expect(path.hunks).toHaveLength(1);
    expect(path.hunks[0]).toMatchObject({
      start: 2,
      ours: "  retries: 3,\n  timeoutOverride: true,",
      base: "  retries: 3,",
      theirs: "  retries: 5,",
    });
    expect(path.intent.ours.commits.map((c) => c.subject)).toEqual([
      "Add a timeout override option",
    ]);
    expect(path.intent.theirs.commits).toEqual([
      expect.objectContaining({
        subject: "Describe the service in detail",
        pr: null,
      }),
      expect.objectContaining({
        subject: "Raise the retry limit (#15)",
        pr: 15,
      }),
    ]);
    expect(path.intent.theirs.truncated).toBe(false);
    expect(path.resolution.decision).toBeNull();
  });

  it("parses regions without a base section, and the readable summary says how to add one", () => {
    mergeConflict(s, "merge");
    const m = map();
    expect(m.paths["src/config.ts"]?.hunks[0]?.base).toBeNull();
    const text = s.script("conflict-map.ts");
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("src/config.ts  both-modified  text");
    expect(text.stdout).toContain("git checkout --conflict=zdiff3");
    expect(text.stdout).toContain("Raise the retry limit (#15)");
  });

  it("works from a subdirectory of the repository", () => {
    mergeConflict(s);
    const r = s.script("conflict-map.ts", ["--json"], `${s.root}/src`);
    expect(r.code).toBe(0);
    expect(Object.keys(JSON.parse(r.stdout).paths)).toEqual(["src/config.ts"]);
  });

  it("--integration overrides the merge heuristic", () => {
    mergeConflict(s);
    expect(map("--integration", "ours").sides.integration).toBe("ours");
  });
});

describe("a rebase", () => {
  it("inverts the roles and warns about it", () => {
    mergeConflict(s);
    s.git("merge", "--abort");
    const rebase = s.gitTry("rebase", "main");
    expect(rebase.code).not.toBe(0);
    const m = map();
    expect(m.operation.kind).toBe("rebase");
    expect(m.sides.ours.ref).toBe("main");
    expect(m.sides.ours.role).toContain("upstream being rebased onto");
    expect(m.sides.theirs.ref).toBe("feature");
    expect(m.sides.theirs.role).toContain("being replayed");
    expect(m.sides.integration).toBe("ours");
    expect(m.warning).toContain("reverse of a merge");
    const path = m.paths["src/config.ts"] as MappedPath;
    expect(path.intent.theirs.commits.map((c) => c.subject)).toEqual([
      "Add a timeout override option",
    ]);
    expect(path.intent.ours.commits.map((c) => c.subject)).toContain(
      "Raise the retry limit (#15)",
    );

    const text = s.script("conflict-map.ts");
    expect(text.stdout.split("\n")[0]).toStartWith("WARNING: Rebase: 'ours'");
  });
});

describe("a cherry-pick", () => {
  it("names the picked commit as the incoming side", () => {
    mergeConflict(s);
    s.git("merge", "--abort");
    const pick = s.gitTry("cherry-pick", "main~1");
    expect(pick.code).not.toBe(0);
    const m = map();
    expect(m.operation.kind).toBe("cherry-pick");
    expect(m.sides.theirs.role).toContain("being cherry-picked");
    expect(m.sides.integration).toBe("ours");
    expect(
      m.paths["src/config.ts"]?.intent.theirs.commits.map((c) => c.subject),
    ).toEqual(["Raise the retry limit (#15)"]);
  });
});

describe("delete/modify", () => {
  it("reports where the deleting side moved the file", () => {
    const body = `${CONFIG_BASE}\nexport const owner = "platform";\n`;
    s.commit("Add the helpers", { "src/old.ts": body });
    s.git("checkout", "-q", "-b", "feature");
    s.commit("Tune the helpers", {
      "src/old.ts": body.replace("retries: 3", "retries: 4"),
    });
    s.git("checkout", "-q", "main");
    s.git("mv", "src/old.ts", "src/new.ts");
    s.commit("Move the helpers");
    s.git("checkout", "-q", "feature");
    // With rename detection off, git cannot follow the move and stops on a
    // delete/modify conflict; the map still finds the new location. The
    // `no-renames` strategy option turns detection off for this merge on
    // every git version; the `merge.renames` setting alone does not.
    expect(
      s.gitTry("-c", "merge.renames=false", "merge", "-X", "no-renames", "main")
        .code,
    ).not.toBe(0);
    const path = map().paths["src/old.ts"] as MappedPath;
    expect(path.kind).toBe("deleted-by-theirs");
    expect(path.intent.theirs.renamedTo).toBe("src/new.ts");
    expect(path.intent.ours.renamedTo).toBeNull();
  });
});

describe("a revert of the root commit", () => {
  it("compares with the empty tree", () => {
    const root = s.commit("Add the helpers", { "src/old.ts": CONFIG_BASE });
    s.commit("Tune the helpers", {
      "src/old.ts": CONFIG_BASE.replace("retries: 3", "retries: 4"),
    });
    expect(s.gitTry("revert", "--no-edit", root).code).not.toBe(0);
    const m = map();
    expect(m.operation.kind).toBe("revert");
    expect(m.paths["src/old.ts"]?.kind).toBe("deleted-by-theirs");
  });
});

describe("classes", () => {
  function conflictEverywhere(files: string[]) {
    s.commit("Base", Object.fromEntries(files.map((f) => [f, "base\n"])));
    s.git("checkout", "-q", "-b", "feature");
    s.commit("Feature", Object.fromEntries(files.map((f) => [f, "feature\n"])));
    s.git("checkout", "-q", "main");
    s.commit("Main", Object.fromEntries(files.map((f) => [f, "main\n"])));
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
  }

  it("reads a JIG_OVERLAY file inside the repository from the index", () => {
    const declare = (command: string) =>
      `resolve_conflicts:\n  generated:\n    - paths: ["gen/**"]\n      command: ${command}\n`;
    s.write("ov.yaml", declare("make gen"));
    s.env.JIG_OVERLAY = `${s.root}/ov.yaml`;
    conflictEverywhere(["gen/x.txt"]);
    s.write("ov.yaml", "");
    expect(map().paths["gen/x.txt"]).toMatchObject({
      class: "generated",
      regenerate: { command: "make gen" },
    });
  });

  it("reads a catalog configured through an alias of the repository from the index", () => {
    const catalog = (output: string) =>
      `areas:\n  api:\n    paths: ["src/**"]\n    generated:\n      - outputs: [${output}]\n        source: ["src/**"]\n        command: make gen\n`;
    s.write("catalog.yaml", catalog("gen.txt"));
    symlinkSync(s.root, `${s.home}/alias`);
    s.overlay(`drive:\n  change_areas_catalog: ${s.home}/alias/catalog.yaml\n`);
    conflictEverywhere(["gen.txt"]);
    s.write("catalog.yaml", catalog("other.txt"));
    expect(map().paths["gen.txt"]?.class).toBe("generated");
  });

  it.skipIf(process.platform === "win32")(
    "reads the JIG_OVERLAY file by its name as given, a trailing space included",
    () => {
      s.write(
        "ov.yaml ",
        'resolve_conflicts:\n  generated:\n    - paths: ["gen/**"]\n      command: make gen\n',
      );
      s.env.JIG_OVERLAY = "ov.yaml ";
      conflictEverywhere(["gen/x.txt"]);
      expect(map().paths["gen/x.txt"]?.class).toBe("generated");
    },
  );

  it("follows a linked directory on the way to the catalog through the index, not the disk", () => {
    const catalog = (output: string) =>
      `areas:\n  api:\n    paths: ["src/**"]\n    generated:\n      - outputs: [${output}]\n        source: ["src/**"]\n        command: make gen\n`;
    s.write("config/catalog.yaml", catalog("gen.txt"));
    s.write("alt/catalog.yaml", catalog("other.txt"));
    symlinkSync("config", `${s.root}/cfg`);
    s.overlay("drive:\n  change_areas_catalog: cfg/catalog.yaml\n");
    conflictEverywhere(["gen.txt"]);
    rmSync(`${s.root}/cfg`);
    symlinkSync("alt", `${s.root}/cfg`);
    expect(map().paths["gen.txt"]?.class).toBe("generated");
  });

  it("takes a configured catalog path's `..` after a link from where the link leads", () => {
    const catalog = (output: string) =>
      `areas:\n  api:\n    paths: ["src/**"]\n    generated:\n      - outputs: [${output}]\n        source: ["src/**"]\n        command: make gen\n`;
    s.write("config/nested/keep", "");
    s.write("config/defs.yaml", catalog("gen.txt"));
    s.write("defs.yaml", catalog("other.txt"));
    symlinkSync("config/nested", `${s.root}/cfg`);
    s.overlay("drive:\n  change_areas_catalog: cfg/../defs.yaml\n");
    conflictEverywhere(["gen.txt"]);
    expect(map().paths["gen.txt"]?.class).toBe("generated");
  });

  it("maps an unmerged configuration, incomplete until it is staged and mapped again", () => {
    const declare = (command: string) =>
      `resolve_conflicts:\n  generated:\n    - paths: ["gen/**"]\n      command: ${command}\n`;
    s.commit("Base", {
      ".config/jig.yaml": declare("make gen"),
      "gen/x.txt": "base\n",
    });
    s.git("checkout", "-q", "-b", "feature");
    s.commit("Feature", {
      ".config/jig.yaml": declare("make feature"),
      "gen/x.txt": "feature\n",
    });
    s.git("checkout", "-q", "main");
    s.commit("Main", {
      ".config/jig.yaml": declare("make main"),
      "gen/x.txt": "main\n",
    });
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    const first = map();
    expect(first.paths[".config/jig.yaml"]).toBeDefined();
    expect(first.catalogIncomplete).toContain(".config/jig.yaml is unmerged");
    s.overlay(declare("make gen"));
    s.git("add", ".config/jig.yaml");
    const again = map();
    expect(again.catalogIncomplete).toBeNull();
    expect(again.paths[".config/jig.yaml"]).toBeDefined();
    expect(again.paths["gen/x.txt"]?.regenerate?.command).toBe("make gen");
  });

  it("lockfiles by name, generated files by configuration, binary by content", () => {
    s.overlay(
      [
        "resolve_conflicts:",
        "  generated:",
        '    - paths: ["src/generated/**", "docs/*.md"]',
        "      command: bun run generate",
        "",
      ].join("\n"),
    );
    conflictEverywhere([
      "bun.lock",
      "packages/app/package-lock.json",
      "src/generated/deep/api.ts",
      "docs/index.md",
      "docs/guide/intro.md",
    ]);
    const m = map();
    expect(m.paths["bun.lock"]).toMatchObject({
      class: "lockfile",
      regenerate: { command: "bun install", cwd: ".", source: "built-in" },
    });
    expect(m.paths["packages/app/package-lock.json"]).toMatchObject({
      class: "lockfile",
      regenerate: {
        command: "npm install --package-lock-only",
        cwd: "packages/app",
      },
    });
    for (const generated of ["src/generated/deep/api.ts", "docs/index.md"])
      expect(m.paths[generated]).toMatchObject({
        class: "generated",
        regenerate: { command: "bun run generate", source: "configuration" },
      });
    // `*` stays within one directory.
    expect(m.paths["docs/guide/intro.md"]?.class).toBe("text");
  });

  it("configuration overrides the built-in lockfile table", () => {
    s.overlay(
      [
        "resolve_conflicts:",
        "  generated:",
        '    - paths: ["bun.lock"]',
        "      command: bun run relock",
        "",
      ].join("\n"),
    );
    conflictEverywhere(["bun.lock"]);
    expect(map().paths["bun.lock"]).toMatchObject({
      class: "generated",
      regenerate: { command: "bun run relock", source: "configuration" },
    });
  });

  describe("the change-area catalog", () => {
    const CATALOG = [
      "areas:",
      "  api:",
      '    paths: ["src/api/**"]',
      "    generated:",
      "      - outputs: [openapi.json, docs/api.md]",
      '        source: ["src/api/**"]',
      "        command: bun run gen:openapi",
      "        check: bun run gen:openapi --check",
      "      - outputs: [schema.sql]",
      '        source: ["src/db/**"]',
      "        check: bun run gen:schema --check",
      "",
    ].join("\n");

    function useCatalog(text = CATALOG, extra: string[] = []): void {
      s.write("catalog.yaml", text);
      s.overlay(
        ["drive:", "  change_areas_catalog: catalog.yaml", ...extra, ""].join(
          "\n",
        ),
      );
    }

    it("maps an output as generated with the catalog's command", () => {
      useCatalog();
      conflictEverywhere(["openapi.json", "docs/api.md", "src/api/routes.ts"]);
      const m = map();
      for (const output of ["openapi.json", "docs/api.md"])
        expect(m.paths[output]).toMatchObject({
          class: "generated",
          regenerate: {
            command: "bun run gen:openapi",
            cwd: ".",
            source: "catalog",
          },
        });
      // A source is edited by hand: only the outputs are derived.
      expect(m.paths["src/api/routes.ts"]?.class).toBe("text");
    });

    it("prints the catalog's command as the regeneration command", () => {
      useCatalog();
      conflictEverywhere(["openapi.json"]);
      const r = s.script("conflict-map.ts");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("openapi.json  both-modified  generated");
      expect(r.stdout).toContain(
        "regenerate: bun run gen:openapi (in .; catalog)",
      );
    });

    it("lets resolve_conflicts.generated override it, and it override the lockfile table", () => {
      useCatalog(
        CATALOG.replace(
          "outputs: [openapi.json, docs/api.md]",
          "outputs: [openapi.json, bun.lock]",
        ),
        [
          "resolve_conflicts:",
          "  generated:",
          '    - paths: ["openapi.json"]',
          "      command: make openapi",
        ],
      );
      conflictEverywhere(["openapi.json", "bun.lock", "go.sum"]);
      const m = map();
      expect(m.paths["openapi.json"]?.regenerate).toMatchObject({
        command: "make openapi",
        source: "configuration",
      });
      expect(m.paths["bun.lock"]).toMatchObject({
        class: "generated",
        regenerate: { command: "bun run gen:openapi", source: "catalog" },
      });
      expect(m.paths["go.sum"]?.regenerate?.source).toBe("built-in");
    });

    it("reports an entry with no command, and still treats its outputs as generated", () => {
      useCatalog();
      conflictEverywhere(["schema.sql"]);
      const r = s.script("conflict-map.ts", ["--json"]);
      expect(r.code).toBe(0);
      const m = JSON.parse(r.stdout) as Map;
      expect(m.paths["schema.sql"]).toMatchObject({
        class: "generated",
        regenerate: null,
      });
      expect(m.warning).toContain(
        "catalog area api.generated[1] declares outputs (schema.sql) but no command",
      );
      expect(r.stderr).toContain("WARNING: catalog area api.generated[1]");
      const text = s.script("conflict-map.ts");
      expect(text.stdout).toContain("WARNING: catalog area api.generated[1]");
    });

    it("reports a catalog it cannot read and still maps", () => {
      s.overlay("drive:\n  change_areas_catalog: missing.yaml\n");
      conflictEverywhere(["openapi.json", "bun.lock"]);
      const r = s.script("conflict-map.ts", ["--json"]);
      expect(r.code).toBe(0);
      const m = JSON.parse(r.stdout) as Map;
      expect(m.warning).toContain("the change-area catalog");
      expect(m.warning).toContain("missing.yaml could not be read");
      expect(m.paths["openapi.json"]?.class).toBe("text");
      expect(m.paths["bun.lock"]?.class).toBe("lockfile");
    });

    it("picks the catalog up when the map runs again once it can be read", () => {
      s.overlay("drive:\n  change_areas_catalog: catalog.yaml\n");
      conflictEverywhere(["openapi.json"]);
      expect(map().paths["openapi.json"]?.class).toBe("text");
      s.write("catalog.yaml", CATALOG);
      s.git("add", "catalog.yaml");
      expect(map().paths["openapi.json"]?.class).toBe("generated");
    });

    describe("when the catalog is itself conflicted", () => {
      beforeEach(() => {
        s.overlay("drive:\n  change_areas_catalog: catalog.yaml\n");
        conflictEverywhere(["catalog.yaml", "openapi.json"]);
      });

      function resolveCatalog(): void {
        s.write("catalog.yaml", CATALOG);
        s.git("add", "catalog.yaml");
      }

      it("maps without it, says why, and reclassifies once it is resolved", () => {
        const first = map();
        expect(first.warning).toContain("the change-area catalog");
        expect(first.paths["catalog.yaml"]?.class).toBe("text");
        expect(first.paths["openapi.json"]?.class).toBe("text");
        resolveCatalog();
        expect(map().paths["openapi.json"]).toMatchObject({
          class: "generated",
          regenerate: { command: "bun run gen:openapi", source: "catalog" },
        });
      });

      it("reclassifies a path hand-merged and staged before the catalog was resolved", () => {
        map();
        s.write("openapi.json", "hand merged\n");
        s.git("add", "openapi.json");
        expect(s.script("record.ts", ["openapi.json", "combined"]).code).toBe(
          0,
        );
        resolveCatalog();
        const r = s.script("conflict-map.ts");
        expect(r.stdout).toContain(
          "cleared the decision for openapi.json, whose class or regeneration command changed",
        );
        const m = map();
        expect(m.warning).not.toContain("could not be read");
        expect(m.paths["openapi.json"]).toMatchObject({
          class: "generated",
          regenerate: { source: "catalog" },
          resolution: { decision: null },
        });
        const check = s.script("check-resolution.ts");
        expect(check.code).toBe(1);
        expect(check.stdout).toContain(
          "PROBLEM openapi.json: no decision recorded",
        );
      });

      it("refuses the check until the map runs again with the catalog readable", () => {
        map();
        s.write("openapi.json", "hand merged\n");
        s.git("add", "openapi.json");
        expect(s.script("record.ts", ["openapi.json", "combined"]).code).toBe(
          0,
        );
        resolveCatalog();
        expect(s.script("record.ts", ["catalog.yaml", "combined"]).code).toBe(
          0,
        );
        const before = s.script("check-resolution.ts");
        expect(before.code).toBe(1);
        expect(before.stdout).toContain(
          "PROBLEM (conflict map): the generated files the configuration and change-area catalog declare could not all be read when the conflicts were mapped",
        );
        expect(map().catalogIncomplete).toBeNull();
        const after = s.script("check-resolution.ts");
        expect(after.stdout).not.toContain("(conflict map)");
        expect(after.stdout).toContain(
          "PROBLEM openapi.json: no decision recorded",
        );
      });
    });

    it("gives a staged derived path the command the catalog declares once it is resolved, and asks for that regeneration again", () => {
      s.overlay("drive:\n  change_areas_catalog: catalog.yaml\n");
      conflictEverywhere(["catalog.yaml", "bun.lock"]);
      expect(map().paths["bun.lock"]?.regenerate?.source).toBe("built-in");
      s.git("add", "bun.lock");
      expect(s.script("record.ts", ["bun.lock", "regenerated"]).code).toBe(0);
      s.write(
        "catalog.yaml",
        CATALOG.replace(
          "outputs: [openapi.json, docs/api.md]",
          "outputs: [bun.lock]",
        ),
      );
      s.git("add", "catalog.yaml");
      expect(map().paths["bun.lock"]).toMatchObject({
        class: "generated",
        regenerate: { command: "bun run gen:openapi", source: "catalog" },
        resolution: { decision: null },
      });
      expect(s.script("check-resolution.ts").stdout).toContain(
        "PROBLEM bun.lock: no decision recorded",
      );
    });

    it("keeps a decision recorded under the class and command the path still has", () => {
      useCatalog();
      conflictEverywhere(["openapi.json"]);
      map();
      s.git("add", "openapi.json");
      expect(s.script("record.ts", ["openapi.json", "regenerated"]).code).toBe(
        0,
      );
      expect(map().paths["openapi.json"]?.resolution.decision).toBe(
        "regenerated",
      );
    });

    it("classifies a staged path by the other rules once the catalog no longer declares it", () => {
      useCatalog();
      conflictEverywhere(["openapi.json"]);
      expect(map().paths["openapi.json"]?.class).toBe("generated");
      s.git("add", "openapi.json");
      expect(s.script("record.ts", ["openapi.json", "regenerated"]).code).toBe(
        0,
      );
      s.write(
        "catalog.yaml",
        CATALOG.replace(
          "outputs: [openapi.json, docs/api.md]",
          "outputs: [docs/api.md]",
        ),
      );
      s.git("add", "catalog.yaml");
      expect(map().paths["openapi.json"]).toMatchObject({
        class: "text",
        regenerate: null,
        resolution: { decision: null },
      });
    });

    it("reports an output that is not a literal file path, and ignores its entry", () => {
      useCatalog(CATALOG.replace("outputs: [schema.sql]", 'outputs: ["**"]'));
      conflictEverywhere(["schema.sql", "src/a.ts"]);
      const m = map();
      expect(m.warning).toContain(
        'catalog area api.generated[1].outputs: "**" is not a literal repository-relative file path',
      );
      expect(m.paths["schema.sql"]?.class).toBe("text");
      expect(m.paths["src/a.ts"]?.class).toBe("text");
      expect(m.catalogIncomplete).toContain('"**" is not a literal');
    });

    it("refuses the check while an entry's outputs are malformed, a valid output beside them included", () => {
      useCatalog(
        CATALOG.replace(
          "outputs: [openapi.json, docs/api.md]",
          'outputs: [openapi.json, "**"]',
        ),
      );
      conflictEverywhere(["openapi.json"]);
      expect(map().paths["openapi.json"]?.class).toBe("text");
      s.write("openapi.json", "hand merged\n");
      s.git("add", "openapi.json");
      expect(s.script("record.ts", ["openapi.json", "combined"]).code).toBe(0);
      const r = s.script("check-resolution.ts");
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(
        'PROBLEM (conflict map): the generated files the configuration and change-area catalog declare could not all be read when the conflicts were mapped (catalog area api.generated[0].outputs: "**" is not a literal',
      );
      useCatalog();
      s.git("add", "catalog.yaml", ".config/jig.yaml");
      expect(map().catalogIncomplete).toBeNull();
      expect(s.script("check-resolution.ts").stdout).not.toContain(
        "(conflict map)",
      );
    });

    it("reports an entry whose outputs are not a list of paths", () => {
      useCatalog(
        CATALOG.replace("outputs: [schema.sql]", "outputs: schema.sql"),
      );
      conflictEverywhere(["schema.sql"]);
      const m = JSON.parse(
        s.script("conflict-map.ts", ["--json"]).stdout,
      ) as Map;
      expect(m.warning).toContain(
        "catalog area api.generated[1].outputs is not a nonempty list of paths",
      );
      expect(m.catalogIncomplete).toContain(
        "api.generated[1].outputs is not a nonempty list of paths",
      );
      expect(m.paths["schema.sql"]?.class).toBe("text");
    });

    it("refuses a catalog path that is not a string", () => {
      s.overlay("drive:\n  change_areas_catalog: [a, b]\n");
      conflictEverywhere(["a.txt"]);
      const r = s.script("conflict-map.ts", ["--json"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("drive.change_areas_catalog must be a path");
    });
  });

  it("binary when a side's content has a zero byte", () => {
    s.commit("Base", { "logo.dat": "a\0b" });
    s.git("checkout", "-q", "-b", "feature");
    s.commit("Feature", { "logo.dat": "a\0feature" });
    s.git("checkout", "-q", "main");
    s.commit("Main", { "logo.dat": "a\0main" });
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    expect(map().paths["logo.dat"]).toMatchObject({
      class: "binary",
      hunks: [],
    });
  });

  for (const [name, text, expected] of [
    [
      "an unknown key",
      "resolve_conflicts:\n  generate: []\n",
      "resolve_conflicts.generate is not a known key",
    ],
    [
      "paths that are not a list",
      'resolve_conflicts:\n  generated:\n    - paths: "src/**"\n      command: make\n',
      "resolve_conflicts.generated[0].paths must be a nonempty list",
    ],
    [
      "a missing command",
      'resolve_conflicts:\n  generated:\n    - paths: ["src/**"]\n',
      "resolve_conflicts.generated[0].command must be a nonempty string",
    ],
    [
      "a glob that compiles to no pattern",
      'resolve_conflicts:\n  generated:\n    - paths: ["src/{a,b"]\n      command: make\n',
      'resolve_conflicts.generated[0].paths[0]: "src/{a,b" is not a valid glob',
    ],
    [
      "an unknown entry key",
      'resolve_conflicts:\n  generated:\n    - paths: ["a"]\n      command: make\n      when: always\n',
      "resolve_conflicts.generated[0].when is not a known key",
    ],
  ] as const)
    it(`refuses a configuration with ${name}`, () => {
      s.overlay(text);
      conflictEverywhere(["a.txt"]);
      const r = s.script("conflict-map.ts", ["--json"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(expected);
    });
});

describe("the snapshot", () => {
  it("is kept with its decisions when the same operation is mapped again", () => {
    mergeConflict(s);
    map();
    expect(
      s.script("record.ts", [
        "src/config.ts",
        "theirs",
        "--reason",
        "main supersedes it",
      ]).code,
    ).toBe(0);
    s.write("src/config.ts", s.read("src/config.ts")); // still unmerged
    const again = s.script("conflict-map.ts");
    expect(again.stdout).toContain("kept 1 recorded decision");
    expect(s.snapshot()).toMatchObject({
      paths: {
        "src/config.ts": {
          resolution: { decision: "theirs", reason: "main supersedes it" },
        },
      },
    });

    // A staged path drops out of the index's unmerged list, but its entry
    // and decision stay.
    s.git("add", "src/config.ts");
    expect(Object.keys(map().paths)).toEqual(["src/config.ts"]);
  });

  it("is readable by the next step whatever pull request number a subject names", () => {
    s.commit("Add the service configuration", { "src/config.ts": CONFIG_BASE });
    s.git("checkout", "-q", "-b", "feature");
    s.commit("Add a timeout override option", {
      "src/config.ts": CONFIG_BASE.replace("retries: 3", "retries: 4"),
    });
    s.git("checkout", "-q", "main");
    s.commit("Adjust configuration (#0)", {
      "src/config.ts": CONFIG_BASE.replace("retries: 3", "retries: 5"),
    });
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);

    const commits = map().paths["src/config.ts"]?.intent.theirs.commits;
    expect(commits?.map((c) => c.pr)).toEqual([null]);
    expect(
      s.script("record.ts", [
        "src/config.ts",
        "theirs",
        "--reason",
        "main wins",
      ]).code,
    ).toBe(0);
  });

  it("is replaced, and says so, when a different operation is mapped", () => {
    mergeConflict(s);
    map();
    s.git("merge", "--abort");
    expect(s.gitTry("cherry-pick", "main~1").code).not.toBe(0);
    const r = s.script("conflict-map.ts");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "replaced the snapshot of a different operation",
    );
    expect(s.snapshot()).toMatchObject({ operation: { kind: "cherry-pick" } });
  });

  it("is never replaced when it is unreadable", () => {
    mergeConflict(s);
    map();
    s.git("add", "src/config.ts");
    const file = s
      .git(
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "jig/conflicts.json",
      )
      .trim();
    writeFileSync(file, "{ damaged");
    const r = s.script("conflict-map.ts");
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("the stored snapshot is unreadable");
    expect(readFileSync(file, "utf8")).toBe("{ damaged");
  });

  // Permission bits do not stop root, and Windows ignores them.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "is never replaced when the file cannot be read",
    () => {
      mergeConflict(s);
      map();
      s.git("add", "src/config.ts");
      const file = s
        .git(
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "jig/conflicts.json",
        )
        .trim();
      const before = readFileSync(file, "utf8");
      chmodSync(file, 0o000);
      try {
        const r = s.script("conflict-map.ts");
        expect(r.code).toBe(3);
        expect(r.stderr).toContain("the stored snapshot is unreadable");
      } finally {
        chmodSync(file, 0o644);
      }
      expect(readFileSync(file, "utf8")).toBe(before);
    },
  );

  function snapshotFile(): string {
    return s
      .git(
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "jig/conflicts.json",
      )
      .trim();
  }

  it("is refused, by the map and the check alike, when its path map is not an object", () => {
    mergeConflict(s);
    map();
    s.git("add", "src/config.ts");
    const file = snapshotFile();
    const damaged = JSON.stringify({
      ...JSON.parse(readFileSync(file, "utf8")),
      paths: [],
    });
    writeFileSync(file, damaged);
    const mapped = s.script("conflict-map.ts");
    expect(mapped.code).toBe(3);
    expect(mapped.stderr).toContain("the path map is not an object");
    const checked = s.script("check-resolution.ts");
    expect(checked.code).toBe(3);
    expect(checked.stderr).toContain("the path map is not an object");
    expect(readFileSync(file, "utf8")).toBe(damaged);
  });

  it("is refused when a path entry lacks what the check walks", () => {
    mergeConflict(s);
    map();
    const file = snapshotFile();
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    snapshot.paths["src/config.ts"].hunks = null;
    writeFileSync(file, JSON.stringify(snapshot));
    const r = s.script("check-resolution.ts");
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('path "src/config.ts" has no hunk list');
  });

  it("is refused when a marker size is not a positive integer", () => {
    mergeConflict(s);
    map();
    const file = snapshotFile();
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    snapshot.paths["src/config.ts"].markerSize = 7.5;
    writeFileSync(file, JSON.stringify(snapshot));
    const r = s.script("check-resolution.ts");
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(
      'path "src/config.ts" has a marker size that is not a positive integer',
    );
  });

  it("is refused when a path's stages do not match its kind", () => {
    mergeConflict(s);
    map();
    const file = snapshotFile();
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    snapshot.paths["src/config.ts"].stages = {
      base: null,
      ours: null,
      theirs: null,
    };
    writeFileSync(file, JSON.stringify(snapshot));
    const empty = s.script("check-resolution.ts");
    expect(empty.code).toBe(3);
    expect(empty.stderr).toContain('path "src/config.ts" has no stage at all');
    const stage = { mode: "100644", blob: "0".repeat(40) };
    snapshot.paths["src/config.ts"].stages = {
      base: null,
      ours: stage,
      theirs: stage,
    };
    writeFileSync(file, JSON.stringify(snapshot));
    const mismatched = s.script("check-resolution.ts");
    expect(mismatched.code).toBe(3);
    expect(mismatched.stderr).toContain(
      'path "src/config.ts" is recorded as both-modified, but its stages are those of both-added',
    );
  });

  it.skipIf(process.platform === "win32")(
    "is never replaced when it is a symlink whose target is gone",
    () => {
      mergeConflict(s);
      map();
      s.git("add", "src/config.ts");
      const file = snapshotFile();
      const target = `${file}.moved`;
      rmSync(file);
      symlinkSync(target, file);
      const r = s.script("conflict-map.ts");
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("the stored snapshot is unreadable");
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
      expect(readlinkSync(file)).toBe(target);
    },
  );

  it("keeps a path named __proto__ as an ordinary path", () => {
    const merged = mergeSnapshot(
      null,
      JSON.parse(
        '{"version":1,"operation":{"kind":"merge","head":"a","incoming":"b"},"paths":{"__proto__":{"kind":"both-added","resolution":{"decision":null}}}}',
      ),
    );
    const again = mergeSnapshot(merged.snapshot, merged.snapshot);
    expect(Object.keys(again.snapshot.paths)).toEqual(["__proto__"]);
    expect(JSON.parse(JSON.stringify(again.snapshot)).paths).toHaveProperty(
      ["__proto__", "kind"],
      "both-added",
    );
  });
});

it("exits 3 when no operation is in progress", () => {
  s.commit("Base", { "a.txt": "a\n" });
  const r = s.script("conflict-map.ts");
  expect(r.code).toBe(3);
  expect(r.stderr).toContain("no merge, rebase, cherry-pick or revert");
});

it("exits 2 on an unknown option", () => {
  expect(s.script("conflict-map.ts", ["--bogus"]).code).toBe(2);
});
