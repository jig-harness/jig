import { expect, test } from "bun:test";
import { fileReader, runnableTests, testReach } from "./test-reach.ts";

const BUNFIG = `[test]
pathIgnorePatterns = ["**/fixtures/**"]
preload = ["./lib/preload.ts"]
`;

/** A repository of `files`, as the walk reads one; `null` cannot be read. */
function repo(files: Record<string, string | null>) {
  const tree: Record<string, string | null> = {
    "bunfig.toml": BUNFIG,
    "lib/preload.ts": 'import "./preload-helper.ts";\n',
    "lib/preload-helper.ts": "export {};\n",
    ...files,
  };
  return {
    tracked: Object.keys(tree),
    read: (file: string) => {
      const text = tree[file];
      if (text === undefined || text === null)
        throw new Error(`cannot read ${file}`);
      return text;
    },
  };
}

function reach(files: Record<string, string | null>, ...changed: string[]) {
  const { tracked, read } = repo(files);
  return testReach(changed, tracked, read);
}

test("a test that imports the changed file is reached, directly or through other files", () => {
  const files = {
    "src/core.ts": "export const core = 1;\n",
    "src/user.ts":
      'import { core } from "./core.ts";\nexport const u = core;\n',
    "tests/direct.test.ts": 'import "../src/core.ts";\n',
    "tests/indirect.test.ts": 'import { u } from "../src/user.ts";\nu;\n',
    "tests/other.test.ts": "export {};\n",
  };
  expect(reach(files, "src/core.ts").tests).toEqual([
    "tests/direct.test.ts",
    "tests/indirect.test.ts",
  ]);
  expect(reach(files, "src/user.ts").tests).toEqual(["tests/indirect.test.ts"]);
});

test("a re-export chain through several files carries the dependency", () => {
  const files = {
    "src/leaf.ts": "export const leaf = 1;\n",
    "src/one.ts": 'export { leaf } from "./leaf.ts";\n',
    "src/two.ts": 'export * from "./one.ts";\n',
    "src/three.ts": 'export * as all from "./two.ts";\n',
    "tests/chain.test.ts": 'import { all } from "../src/three.ts";\nall;\n',
  };
  expect(reach(files, "src/leaf.ts").tests).toEqual(["tests/chain.test.ts"]);
});

test("a type-only import gives no edge, and an import used only as a type does", () => {
  const files = {
    "src/types.ts": "export type T = 1;\nexport const value = 1;\n",
    "tests/statement.test.ts": 'import type { T } from "../src/types.ts";\n',
    "tests/inline.test.ts": 'import { type T } from "../src/types.ts";\n',
    "tests/reexport.test.ts": 'export type { T } from "../src/types.ts";\n',
    "tests/value.test.ts":
      'import { value } from "../src/types.ts";\nlet v: typeof value;\n',
  };
  expect(reach(files, "src/types.ts").tests).toEqual(["tests/value.test.ts"]);
});

test("require, literal dynamic imports and specifiers without their extension resolve", () => {
  const files = {
    "src/a.ts": "export {};\n",
    "src/b.tsx": "export {};\n",
    "src/c/index.ts": "export {};\n",
    "src/d.ts": "export {};\n",
    "src/e.json": "{}\n",
    "tests/require.test.ts": 'require("../src/a.ts");\n',
    "tests/dynamic.test.ts": 'await import("../src/b");\n',
    "tests/index.test.ts": 'import "../src/c";\n',
    "tests/compiled.test.ts": 'import "../src/d.js";\n',
    "tests/data.test.ts": 'import "../src/e.json";\n',
  };
  expect(reach(files, "src/a.ts").tests).toEqual(["tests/require.test.ts"]);
  expect(reach(files, "src/b.tsx").tests).toEqual(["tests/dynamic.test.ts"]);
  expect(reach(files, "src/c/index.ts").tests).toEqual(["tests/index.test.ts"]);
  expect(reach(files, "src/d.ts").tests).toEqual(["tests/compiled.test.ts"]);
  expect(reach(files, "src/e.json").tests).toEqual(["tests/data.test.ts"]);
});

test("TypeScript a TSX parse would refuse, and a script's first line, are scanned", () => {
  const files = {
    "src/a.ts": "export {};\n",
    "src/unrelated.ts": "export {};\n",
    "src/generic.ts":
      'import "./a.ts";\nexport const f = <T>(x: unknown) => <T>x;\n',
    "src/script.ts": '#!/usr/bin/env bun\nimport "./a.ts";\n',
    "tests/generic.test.ts": 'import "../src/generic.ts";\n',
    "tests/script.test.ts": 'import "../src/script.ts";\n',
  };
  expect(reach(files, "src/a.ts").tests).toEqual([
    "tests/generic.test.ts",
    "tests/script.test.ts",
  ]);
  // Neither counts as unscannable, which would reach them from any change.
  expect(reach(files, "src/unrelated.ts").tests).toEqual([]);
});

test("a declaration file loads nothing and is no reason to run more", () => {
  const files = {
    "src/a.ts": "export {};\n",
    "src/vendor.d.mts": "export const broken: number;\n",
    "tests/vendor.test.ts": 'import "../src/vendor.d.mts";\n',
  };
  expect(reach(files, "src/a.ts").tests).toEqual([]);
});

test("a test, or a helper beside the tests, that names a script's file is reached through it", () => {
  const files = {
    "scripts/run-me.ts": "export {};\n",
    "scripts/lonely.sh": "#!/bin/sh\n",
    "tests/spawns.test.ts": 'Bun.spawnSync(["bun", "scripts/run-me.ts"]);\n',
    "tests/shell.test.ts": 'Bun.spawnSync(["sh", "scripts/lonely.sh"]);\n',
    "tests/longer.test.ts": 'const other = "not-run-me.ts";\nother;\n',
    "tests/__tests__/harness.ts": 'export const script = "run-me.ts";\n',
    "tests/through-harness.test.ts":
      'import { script } from "./__tests__/harness.ts";\nscript;\n',
    "src/names-it.ts": 'export const script = "run-me.ts";\n',
    "tests/imports-names-it.test.ts": 'import "../src/names-it.ts";\n',
  };
  expect(reach(files, "scripts/run-me.ts").tests).toEqual([
    "tests/spawns.test.ts",
    "tests/through-harness.test.ts",
  ]);
  expect(reach(files, "scripts/lonely.sh").tests).toEqual([
    "tests/shell.test.ts",
  ]);
});

test("a file name two files share leads on from the file whose path the text spells and from a bare name, not from another path", () => {
  const files = {
    "one/cli.ts": "export {};\n",
    "two/cli.ts": "export {};\n",
    "tests/names.test.ts": 'Bun.spawnSync(["bun", "./one/cli.ts"]);\n',
    "tests/bare.test.ts": 'const script = "cli.ts";\nscript;\n',
    "tests/imports.test.ts": 'import "../two/cli.ts";\n',
  };
  expect(reach(files, "one/cli.ts").tests).toEqual([
    "tests/bare.test.ts",
    "tests/names.test.ts",
  ]);
  expect(reach(files, "two/cli.ts").tests).toEqual([
    "tests/bare.test.ts",
    "tests/imports.test.ts",
  ]);
});

test("a data file or a Markdown fixture leads to the tests naming it, and other Markdown does not", () => {
  const files = {
    "config/rules.yaml": "a: 1\n",
    "config/table.json": "{}\n",
    "config/tool.toml": "a = 1\n",
    "config/rows.tsv": "a\n",
    "config/list.txt": "a\n",
    "m/fixtures/good.md": "# Good\n",
    "docs/page.md": "# Page\n",
    "tests/rules.test.ts":
      'const names = ["rules.yaml", "table.json", "tool.toml", "rows.tsv", "list.txt", "good.md", "page.md"];\nnames;\n',
  };
  for (const data of [
    "config/rules.yaml",
    "config/table.json",
    "config/tool.toml",
    "config/rows.tsv",
    "config/list.txt",
    "m/fixtures/good.md",
  ])
    expect(reach(files, data).tests).toEqual(["tests/rules.test.ts"]);
  expect(reach(files, "docs/page.md").tests).toEqual([]);
});

test("a name does not lead on from a test to the tests that mention it", () => {
  const files = {
    "src/a.ts": "export {};\n",
    "tests/first.test.ts": 'import "../src/a.ts";\n',
    "tests/roll-call.test.ts": 'const all = ["first.test.ts"];\nall;\n',
  };
  expect(reach(files, "src/a.ts").tests).toEqual(["tests/first.test.ts"]);
});

test("a changed test is selected, a deleted file's importers still are, and an ignored test never is", () => {
  const files = {
    "tests/changed.test.ts": "export {};\n",
    "tests/uses-deleted.test.ts": 'import "../src/gone.ts";\n',
    "src/fixtures/sample.test.ts": 'import "../gone.ts";\n',
  };
  expect(reach(files, "tests/changed.test.ts").tests).toEqual([
    "tests/changed.test.ts",
  ]);
  expect(reach(files, "src/gone.ts").tests).toEqual([
    "tests/uses-deleted.test.ts",
  ]);
  expect(reach(files, "src/fixtures/sample.test.ts").tests).toEqual([]);
});

test("a file that cannot be scanned or read counts as reached, with what imports it", () => {
  const files = {
    "src/a.ts": "export {};\n",
    "src/broken.ts": "export const = ;\n",
    "src/unreadable.ts": null,
    "tests/uses-broken.test.ts": 'import "../src/broken.ts";\n',
    "tests/uses-unreadable.test.ts": 'import "../src/unreadable.ts";\n',
    "tests/broken.test.ts": "import {\n",
    "tests/unrelated.test.ts": "export {};\n",
  };
  expect(reach(files, "src/a.ts").tests).toEqual([
    "tests/broken.test.ts",
    "tests/uses-broken.test.ts",
    "tests/uses-unreadable.test.ts",
  ]);
});

test("what every test run loads is reported apart from the tests it reaches", () => {
  const files = {
    "src/a.ts": "export {};\n",
    "tests/a.test.ts": 'import "../src/a.ts";\n',
  };
  expect(reach(files, "src/a.ts").everyRun).toEqual([]);
  for (const file of [
    "bunfig.toml",
    "scripts/test.ts",
    "lib/preload.ts",
    "lib/preload-helper.ts",
  ])
    expect(reach(files, "src/a.ts", file).everyRun).toEqual([file]);
});

test("run configuration that cannot be read counts every changed file as loaded by every run", () => {
  expect(
    reach({ "bunfig.toml": "not = [toml", "src/a.ts": "" }, "src/a.ts")
      .everyRun,
  ).toEqual(["src/a.ts"]);
  expect(
    reach({ "bunfig.toml": null, "src/a.ts": "" }, "src/a.ts").everyRun,
  ).toEqual(["src/a.ts"]);
  // A preload that cannot be scanned may load the changed file.
  expect(
    reach({ "lib/preload.ts": "import {\n", "src/a.ts": "" }, "src/a.ts")
      .everyRun,
  ).toEqual(["src/a.ts"]);
});

test("a change that touches no code reaches nothing, and no change reads nothing", () => {
  const files = {
    "README.md": "# Read `run-me.ts`\n",
    "docs/guide.md": "text\n",
    "tests/a.test.ts": 'const doc = "README.md";\ndoc;\n',
  };
  expect(reach(files, "README.md", "docs/guide.md")).toEqual({
    tests: [],
    everyRun: [],
  });
  expect(
    testReach([], ["a.ts"], () => {
      throw new Error("read");
    }),
  ).toEqual({ tests: [], everyRun: [] });
});

test("the runnable tests leave out what the run configuration ignores", () => {
  const { tracked, read } = repo({
    "a.test.ts": "",
    "b.test.tsx": "",
    "c/fixtures/d.test.ts": "",
    "e.ts": "",
  });
  expect(runnableTests(tracked, read)).toEqual(["a.test.ts", "b.test.tsx"]);
});

test("the file reader reads under its root and refuses what is not a file", () => {
  const read = fileReader(import.meta.dir);
  expect(read("test-reach.test.ts")).toContain("the file reader reads");
  expect(() => read("no-such-file.ts")).toThrow();
  expect(() => read("../scripts")).toThrow();
});
