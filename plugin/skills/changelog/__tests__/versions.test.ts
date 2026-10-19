import { describe, expect, test } from "bun:test";
import { KEEP_A_CHANGELOG } from "../scripts/formats.ts";
import {
  currentVersion,
  derivedFiles,
  highestTag,
  isVersionFile,
  readVersion,
  resolveVersionSource,
  type VersionFile,
  type VersionSource,
  versionSpan,
  withVersion,
} from "../scripts/versions.ts";

const file = (path: string, key = "version"): VersionFile => ({ path, key });

describe("a version kept in a file", () => {
  test("JSON: only the value at the key changes, at its own object", () => {
    const text = `{\n  "name": "p",\n  "engines": { "version": "1.0.0" },\n  "version": "1.0.0",\n  "dependencies": {"version": "1.0.0"}\n}\n`;
    expect(readVersion(file("package.json"), text)).toBe("1.0.0");
    expect(withVersion(file("package.json"), text, "1.0.0", "1.1.0")).toBe(
      text.replace('"version": "1.0.0",', '"version": "1.1.0",'),
    );
    // A nested key is addressed by its path.
    expect(
      withVersion(
        file("package.json", "engines.version"),
        text,
        "1.0.0",
        "2.0.0",
      ),
    ).toBe(
      text.replace(
        '"engines": { "version": "1.0.0" }',
        '"engines": { "version": "2.0.0" }',
      ),
    );
  });

  test("JSON: a key written twice is ambiguous and stops the release", () => {
    expect(() =>
      withVersion(
        file("package.json"),
        `{"version": "1.0.0", "version": "1.0.0"}`,
        "1.0.0",
        "1.1.0",
      ),
    ).toThrow("found 2");
  });

  test("JSON: a version in an array's object is not the top-level key", () => {
    const text = `{"list": [{"version": "1.0.0"}], "version": "1.0.0"}`;
    expect(withVersion(file("package.json"), text, "1.0.0", "1.1.0")).toBe(
      `{"list": [{"version": "1.0.0"}], "version": "1.1.0"}`,
    );
  });

  test("TOML: the key of its own table changes, not a dependency's version", () => {
    const text = `[package]\nname = "p"\n# the version\nversion = "1.0.0" # kept\n\n[dependencies]\nserde = { version = "1.0.0" }\nother = "1.0.0"\n\n[dependencies.x]\nversion = "1.0.0"\n`;
    const key = file("Cargo.toml", "package.version");
    expect(readVersion(key, text)).toBe("1.0.0");
    expect(withVersion(key, text, "1.0.0", "1.1.0")).toBe(
      text.replace('version = "1.0.0" # kept', 'version = "1.1.0" # kept'),
    );
  });

  test("TOML: pyproject's two homes, a dotted key, and a multi-line string that looks like a key", () => {
    const poetry = `[tool.poetry]\nname = "p"\nversion = "0.3.0"\n`;
    expect(
      withVersion(
        file("pyproject.toml", "tool.poetry.version"),
        poetry,
        "0.3.0",
        "0.4.0",
      ),
    ).toBe(poetry.replace("0.3.0", "0.4.0"));
    const dotted = `package.version = "1.0.0"\n`;
    expect(
      withVersion(
        file("Cargo.toml", "package.version"),
        dotted,
        "1.0.0",
        "1.0.1",
      ),
    ).toBe(`package.version = "1.0.0"\n`.replace("1.0.0", "1.0.1"));
    const tricky = `[project]\ndescription = """\nversion = "1.0.0"\n"""\nkeywords = [\n  "a",\n]\nversion = "1.0.0"\n`;
    expect(
      withVersion(
        file("pyproject.toml", "project.version"),
        tricky,
        "1.0.0",
        "1.0.1",
      ),
    ).toBe(tricky.replace(/\nversion = "1\.0\.0"\n$/, '\nversion = "1.0.1"\n'));
  });

  test("TOML: a version inside an inline table is not edited in place", () => {
    expect(() =>
      withVersion(
        file("Cargo.toml", "package.version"),
        `package = { version = "1.0.0" }\n`,
        "1.0.0",
        "1.0.1",
      ),
    ).toThrow("inline table");
  });

  test("YAML: the key at its own nesting changes, comments and quotes stay", () => {
    const text = `name: p\ninfo:\n  title: t\n  version: "1.0.0" # api\nversion: 1.0.0\nitems:\n  - version: 1.0.0\n`;
    expect(withVersion(file("chart.yaml"), text, "1.0.0", "1.1.0")).toBe(
      text.replace("\nversion: 1.0.0\n", "\nversion: 1.1.0\n"),
    );
    expect(
      withVersion(file("chart.yaml", "info.version"), text, "1.0.0", "2.0.0"),
    ).toBe(text.replace('version: "1.0.0" # api', 'version: "2.0.0" # api'));
  });

  test("YAML: a value the edit cannot reach, or that moves more than itself, stops the release", () => {
    // Written by an alias, so there is nothing to edit at the key.
    expect(() =>
      withVersion(
        file("chart.yaml", "app.version"),
        `base: &b\n  version: 1.0.0\napp:\n  <<: *b\n`,
        "1.0.0",
        "1.1.0",
      ),
    ).toThrow("found 0");
    // An alias would carry the edit to a second path too.
    expect(() =>
      withVersion(
        file("chart.yaml", "info.version"),
        `info: &shared\n  version: 1.0.0\nother: *shared\n`,
        "1.0.0",
        "1.1.0",
      ),
    ).toThrow("did not change exactly that value");
    // Aliases that double at every level expand without bound; the edit is
    // refused before the expansion is built.
    const doubling = Array.from(
      { length: 40 },
      (_, i) => `l${i + 1}: &l${i + 1} [*l${i}, *l${i}]`,
    ).join("\n");
    expect(() =>
      withVersion(
        file("chart.yaml"),
        `version: 1.0.0\nl0: &l0 [x]\n${doubling}\n`,
        "1.0.0",
        "1.1.0",
      ),
    ).toThrow("expand to more than");
    // An alias inside its own anchor never ends.
    expect(() =>
      withVersion(
        file("chart.yaml"),
        "version: 1.0.0\nloop: &c\n  self: *c\n",
        "1.0.0",
        "1.1.0",
      ),
    ).toThrow("refers to its own anchor");
    // An edit that would add a key is caught by parsing the result again.
    expect(() =>
      withVersion(
        file("chart.yaml"),
        "version: 1.0.0\n",
        "1.0.0",
        "1.1.0\nextra: 1",
      ),
    ).toThrow("did not change exactly that value");
  });

  test("a key that holds another value than the version stops the release", () => {
    expect(() =>
      withVersion(
        file("package.json"),
        `{"version": "2.0.0"}`,
        "1.0.0",
        "1.1.0",
      ),
    ).toThrow('holds "2.0.0"');
  });

  test("a plain VERSION file holds the version alone", () => {
    const plain = file("VERSION", "");
    expect(readVersion(plain, "1.2.3\n")).toBe("1.2.3");
    expect(withVersion(plain, "1.2.3\n", "1.2.3", "1.3.0")).toBe("1.3.0\n");
    expect(() => withVersion(plain, "1.2.4\n", "1.2.3", "1.3.0")).toThrow(
      "expected the version 1.2.3",
    );
  });

  test("only JSON, TOML, YAML and VERSION files hold a version", () => {
    expect(
      ["a.json", "b/c.toml", "d.yml", "e.yaml", "VERSION"].map(isVersionFile),
    ).toEqual([true, true, true, true, true]);
    expect(isVersionFile("setup.py")).toBe(false);
  });
});

describe("where the version is written", () => {
  const at = (text: string, span: [number, number] | null) =>
    span === null ? null : [text.slice(0, span[0]), text.slice(...span)];

  test("the one value the release step edits, at its full key", () => {
    const toml = `name = "p"\nproject.version = "1.0.0"\n\n[tool.dep]\nversion = "1.0.0"\n`;
    expect(
      at(toml, versionSpan(file("pyproject.toml", "project.version"), toml)),
    ).toEqual(['name = "p"\nproject.version = "', "1.0.0"]);
    const json = `{\n  "deps": { "version": "1.0.0" },\n  "version": "1.0.0"\n}\n`;
    expect(at(json, versionSpan(file("package.json"), json))?.[0]).toBe(
      `{\n  "deps": { "version": "1.0.0" },\n  "version": "`,
    );
    expect(at("1.2.3\n", versionSpan(file("VERSION", ""), "1.2.3\n"))).toEqual([
      "",
      "1.2.3",
    ]);
  });

  test("none where the release step would refuse or finds no version", () => {
    const twice = `[project]\nversion = "1.0.0"\n[project]\nversion = "1.0.0"\n`;
    expect(versionSpan(file("pyproject.toml", "project.version"), twice)).toBe(
      null,
    );
    const inline = `project = { version = "1.0.0" }\n`;
    expect(versionSpan(file("pyproject.toml", "project.version"), inline)).toBe(
      null,
    );
    expect(versionSpan(file("package.json"), `{"name": "p"}`)).toBe(null);
    // A YAML alias shares the value with another path, which an edit would move too.
    const shared = `info: &shared\n  version: 1.0.0\nother: *shared\n`;
    expect(versionSpan(file("chart.yaml", "info.version"), shared)).toBe(null);
  });

  test("a version that begins as the probe does is still found whole", () => {
    const yaml = `info:\n  version: 0.0.1\n`;
    expect(
      at(yaml, versionSpan(file("chart.yaml", "info.version"), yaml)),
    ).toEqual(["info:\n  version: ", "0.0.1"]);
  });
});

describe("the version files derived when the repository names none", () => {
  const reader = (files: Record<string, string>) => (path: string) =>
    files[path] ?? null;

  test("package.json, pyproject.toml (project, else poetry) and Cargo.toml, each with a written version", () => {
    expect(
      derivedFiles(
        reader({
          "package.json": `{"version": "1.0.0"}`,
          "pyproject.toml": `[project]\nversion = "1.0.0"\n`,
          "Cargo.toml": `[package]\nversion = "1.0.0"\n`,
        }),
      ),
    ).toEqual([
      file("package.json"),
      file("pyproject.toml", "project.version"),
      file("Cargo.toml", "package.version"),
    ]);
    expect(
      derivedFiles(
        reader({ "pyproject.toml": `[tool.poetry]\nversion = "0.1.0"\n` }),
      ),
    ).toEqual([file("pyproject.toml", "tool.poetry.version")]);
  });

  test("a version computed at build time, inherited, or absent is not derived", () => {
    expect(
      derivedFiles(
        reader({
          "package.json": `{"name": "monorepo-root", "workspaces": []}`,
          "pyproject.toml": `[project]\nname = "p"\ndynamic = ["version"]\n`,
          "Cargo.toml": `[package]\nname = "p"\nversion.workspace = true\n`,
        }),
      ),
    ).toEqual([]);
  });

  test("no file left asks for the field", () => {
    expect(() => resolveVersionSource(null, () => null)).toThrow(
      "Set changelog.version",
    );
    const set = { kind: "tags" } as const;
    expect(resolveVersionSource(set, () => null)).toBe(set);
  });
});

describe("the current version", () => {
  const context = (files: Record<string, string>, over = {}) => ({
    read: (path: string) => files[path] ?? null,
    format: KEEP_A_CHANGELOG,
    tagPrefix: "v",
    changelog: "",
    tags: () => [] as string[],
    ...over,
  });

  test("from files, the one every file holds", () => {
    const source: VersionSource = {
      kind: "files",
      files: [file("a.json"), file("b.yaml")],
    };
    expect(
      currentVersion(
        source,
        context({
          "a.json": `{"version":"1.2.0"}`,
          "b.yaml": "version: 1.2.0\n",
        }),
      ),
    ).toBe("1.2.0");
    expect(() =>
      currentVersion(
        source,
        context({
          "a.json": `{"version":"1.2.0"}`,
          "b.yaml": "version: 1.1.0\n",
        }),
      ),
    ).toThrow("the version files disagree: a.json=1.2.0, b.yaml=1.1.0");
  });

  test("from tags, the changelog's newest release heading, else the highest tag, else 0.0.0", () => {
    const tags = { kind: "tags" } as const;
    const listing = [
      "v1.9.0",
      "v1.10.0",
      "v1.2.0",
      "latest",
      "v2.0.0-rc.1",
      "x1.99.0",
    ];
    expect(
      currentVersion(
        tags,
        context(
          {},
          {
            changelog:
              "# C\n\n## [1.3.0] - 2026-01-01\n\n## [1.2.0] - 2025-01-01\n",
            tags: () => listing,
          },
        ),
      ),
    ).toBe("1.3.0");
    // Before the first release there is no heading: the tags decide.
    expect(
      currentVersion(
        tags,
        context({}, { changelog: "# C\n", tags: () => listing }),
      ),
    ).toBe("1.10.0");
    expect(currentVersion(tags, context({}))).toBe("0.0.0");
    expect(highestTag(["v1.9.0", "v1.10.0"], "v")).toBe("1.10.0");
    expect(highestTag(["1.0.0", "v3.0.0"], "")).toBe("1.0.0");
  });
});
