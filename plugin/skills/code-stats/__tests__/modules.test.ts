import { describe, expect, test } from "bun:test";
import { parseCodeStatsConfig } from "../scripts/lib/config.ts";
import {
  cargoMembers,
  detectModules,
  goWorkMembers,
  gradleMembers,
  moduleOf,
  packageJsonMembers,
  pnpmMembers,
  uvMembers,
} from "../scripts/lib/modules.ts";
import { temporary, write } from "./helpers.ts";

/** A folder holding `files` (no git needed: modules read the root's manifests). */
function tree(files: Record<string, string>): string {
  const root = temporary("code-stats-modules-");
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  return root;
}

const modulesOf = (
  files: Record<string, string>,
  configured: string[] | null = null,
) => {
  const root = tree(files);
  const patterns =
    configured === null
      ? null
      : parseCodeStatsConfig({ modules: configured }).modules;
  const map = detectModules(root, Object.keys(files), patterns);
  return (path: string) => moduleOf(path, map);
};

describe("manifest readers", () => {
  test("pnpm-workspace.yaml packages, with negations", () => {
    expect(
      pnpmMembers(
        "packages:\n  - 'apps/*'\n  - packages/*\n  - '!packages/old'\n",
      ),
    ).toMatchObject({
      include: ["apps/*", "packages/*"],
      exclude: ["packages/old"],
    });
  });

  test("package.json workspaces as a list or as {packages}", () => {
    expect(packageJsonMembers('{"workspaces":["apps/*"]}').include).toEqual([
      "apps/*",
    ]);
    expect(
      packageJsonMembers('{"workspaces":{"packages":["libs/*"]}}').include,
    ).toEqual(["libs/*"]);
    expect(packageJsonMembers('{"name":"x"}').include).toEqual([]);
  });

  test("go.work use directives, block and single forms", () => {
    expect(
      goWorkMembers(
        "go 1.22\n\nuse (\n\t./cmd/api\n\t./internal/store // store\n)\nuse ./tools\n",
      ).include,
    ).toEqual(["cmd/api", "internal/store", "tools"]);
  });

  test("go.work quoted paths keep their spaces", () => {
    expect(
      goWorkMembers(
        'use "./my modules/api"\nuse (\n\t"./my modules/web" // web\n\t`./raw dir`\n\t./plain\n)\n',
      ).include,
    ).toEqual(["my modules/api", "my modules/web", "raw dir", "plain"]);
    expect(goWorkMembers("use ( ./a ./b )\nuse ./c\n").include).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("Cargo workspace members and exclude, with a root package", () => {
    expect(
      cargoMembers(
        '[package]\nname = "root"\n\n[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/legacy"]\n',
      ),
    ).toMatchObject({ include: ["crates/*", ""], exclude: ["crates/legacy"] });
    expect(cargoMembers('[package]\nname = "x"\n').include).toEqual([]);
  });

  test("Gradle include statements", () => {
    expect(
      gradleMembers(
        'rootProject.name = "shop"\ninclude(":app", ":libs:core")\ninclude \':cli\'\n',
        "settings.gradle.kts",
      ).include,
    ).toEqual(["app", "libs/core", "cli"]);
  });

  test("Gradle include statements that span lines", () => {
    const of = (text: string) => gradleMembers(text, "settings.gradle").include;
    expect(of('include(\n  ":app",\n  ":libs:core"\n)\n')).toEqual([
      "app",
      "libs/core",
    ]);
    expect(
      of("include ':app',\n    ':libs:core'\nrootProject.name = 'x'\n"),
    ).toEqual(["app", "libs/core"]);
    expect(
      of(
        "include ':a'\ninclude(':b', ':c:d')\ninclude(\n  ':e',\n)\nprintln('not :included')\n",
      ),
    ).toEqual(["a", "b", "c/d", "e"]);
  });

  test("an include inside a string or a comment is not one", () => {
    const of = (text: string) => gradleMembers(text, "settings.gradle").include;
    expect(
      of(
        'println("include(\':domain:fake\')")\ninclude(":app") // include(":old")\n/* include ":gone" */\n',
      ),
    ).toEqual(["app"]);
    expect(of('include(":a)b", ":c")\n')).toEqual(["a)b", "c"]);
  });

  test("uv workspace members and exclude", () => {
    expect(
      uvMembers(
        '[project]\nname = "x"\n\n[tool.uv.workspace]\nmembers = ["packages/*"]\nexclude = ["packages/scratch"]\n',
      ),
    ).toMatchObject({ include: ["packages/*"], exclude: ["packages/scratch"] });
  });

  test("a manifest that cannot be read is an error naming it", () => {
    expect(() => cargoMembers("[workspace\n")).toThrow(/Cargo.toml/);
  });
});

describe("configured module globs", () => {
  test("a glob escape matches the literal folder", () => {
    const of = modulesOf({ "work/a[b]/src/x.ts": "", "work/ab/y.ts": "" }, [
      "work/a\\[b\\]",
    ]);
    const module = of("work/a[b]/src/x.ts");
    expect(module.value).toBe("work/a[b]");
    expect(module.rule).toStartWith("code_stats.modules glob");
    expect(of("work/ab/y.ts").rule).toStartWith("fallback:");
  });
});

describe("module of a file", () => {
  test("pnpm members that hold a package.json are modules; the deepest wins", () => {
    const of = modulesOf({
      "pnpm-workspace.yaml": "packages: ['packages/**', '!packages/old']\n",
      "packages/core/package.json": "{}",
      "packages/core/src/a.ts": "",
      "packages/core/plugins/x/package.json": "{}",
      "packages/core/plugins/x/src/b.ts": "",
      "packages/core/src/notes/c.ts": "",
      "packages/old/package.json": "{}",
      "packages/old/d.ts": "",
    });
    expect(of("packages/core/src/a.ts")).toEqual({
      value: "packages/core",
      rule: 'pnpm-workspace.yaml packages "packages/**"',
    });
    expect(of("packages/core/plugins/x/src/b.ts").value).toBe(
      "packages/core/plugins/x",
    );
    expect(of("packages/core/src/notes/c.ts").value).toBe("packages/core");
    expect(of("packages/old/d.ts").rule).toStartWith("fallback:");
  });

  test("Cargo, Go, Gradle and uv members", () => {
    expect(
      modulesOf({
        "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
        "crates/parse/Cargo.toml": "",
        "crates/parse/src/lib.rs": "",
      })("crates/parse/src/lib.rs").rule,
    ).toBe('Cargo workspace members "crates/*"');
    expect(
      modulesOf({
        "go.work": "use ./services/api\n",
        "services/api/main.go": "",
      })("services/api/main.go").value,
    ).toBe("services/api");
    expect(
      modulesOf({
        "settings.gradle": "include ':app'\n",
        "app/src/main/java/A.java": "",
      })("app/src/main/java/A.java").value,
    ).toBe("app");
    expect(
      modulesOf({
        "pyproject.toml": '[tool.uv.workspace]\nmembers = ["libs/*"]\n',
        "libs/parse/pyproject.toml": "",
        "libs/parse/src/a.py": "",
      })("libs/parse/src/a.py").value,
    ).toBe("libs/parse");
  });

  test("without a manifest: two folders under a container folder, else the first", () => {
    const of = modulesOf({ "apps/web/src/main.tsx": "" });
    expect(of("apps/web/src/main.tsx")).toEqual({
      value: "apps/web",
      rule: "fallback: the first two folders under the container folder apps/",
    });
    expect(of("services/api/x/y.go").value).toBe("services/api");
    expect(of("docs/adr/ADR-1.md").value).toBe("docs");
    expect(of("apps/README.md").value).toBe("apps");
    expect(of("package.json")).toEqual({
      value: "<root>",
      rule: "fallback: a file at the root",
    });
  });

  test("code_stats.modules replaces the manifests", () => {
    const of = modulesOf(
      {
        "pnpm-workspace.yaml": "packages: ['packages/*']\n",
        "packages/core/package.json": "{}",
        "packages/core/src/a.ts": "",
        "domains/billing/src/b.ts": "",
      },
      ["domains/*"],
    );
    expect(of("domains/billing/src/b.ts")).toEqual({
      value: "domains/billing",
      rule: 'code_stats.modules glob "domains/*"',
    });
    expect(of("packages/core/src/a.ts").rule).toBe(
      "fallback: the first two folders under the container folder packages/",
    );
  });
});
