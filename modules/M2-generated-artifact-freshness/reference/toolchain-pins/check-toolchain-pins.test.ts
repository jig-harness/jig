import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  checkTool,
  parseDeclaration,
  readPins,
  readSource,
} from "./check-toolchain-pins.ts";

const gate = join(import.meta.dir, "check-toolchain-pins.ts");
const fix = join(import.meta.dir, "fixtures");
const tree = (name: string) => join(fix, name);

/** Run the gate on a fixture tree, outside GitHub Actions unless a test asks. */
function run(args: string[], cwd = fix, env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, gate, ...args], {
    cwd,
    env: { ...process.env, GITHUB_ACTIONS: "false", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
/** A throwaway tree holding the given files, for one test. */
function scratch(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "toolchain-pins-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const onTree = (name: string, env?: Record<string, string>) =>
  run(["--root", tree(name), join(tree(name), "pins.yaml")], fix, env);

describe("outcomes", () => {
  test("every pin equal to its source passes and says what it read", () => {
    const r = onTree("agree");
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(
      "OK — bun: 5 pin(s) equal mise.toml's 1.4.3 (4 file(s) read, 1 exception(s) registered)",
    );
    expect(r.stdout).toContain(
      "OK — node: 2 pin(s) equal .node-version's 24.3.0 (3 file(s) read)",
    );
  });

  test("each kind of finding is reported with its place and remedy", () => {
    const r = onTree("drift");
    expectSpawnExit(r, 1);
    const { stderr } = r;
    expect(stderr).toContain(
      "package.json: [toolchain-pins] bun is pinned to 1.4.2 here (json path devDependencies.@types/bun); mise.toml says 1.4.3.",
    );
    expect(stderr).toContain(
      ".github/workflows/ci.yml:8: [toolchain-pins] bun is set up here without a version (uses: oven-sh/setup-bun@<sha>), so it floats to the tool's default",
    );
    expect(stderr).toContain(
      "Dockerfile: [toolchain-pins] bun's pin is gone: pattern ^ARG BUN_VERSION=(\\S+)$ matches nothing in Dockerfile.",
    );
    expect(stderr).toContain(
      "pins.yaml: [toolchain-pins] The exception for package.json allows 1.4.3, which is mise.toml's value now",
    );
    expect(stderr).toContain(
      "The exception for .github/workflows/ci.yml allows 1.4.1, but no bun pin there holds it",
    );
    expect(stderr).toContain(
      "package.json: [toolchain-pins] bun's pin site holds a value the pattern ^=(.+)$ does not read (json path engines.bun (>=1.4)); mise.toml says 1.4.3.",
    );
    expect(stderr).toContain("fix: Set it to 1.4.3, or register the value");
    expect(stderr).toContain("fix: Remove the exception: it excuses nothing.");
    expect(stderr).toContain(
      ".github/workflows/ci.yml:16: [toolchain-pins] bun is set up here without a version (uses: oven-sh/setup-bun@<sha>)",
    );
    expect(stderr).toContain(
      ".github/workflows/ci.yml:19: [toolchain-pins] bun is set up here from .bun-version (uses: oven-sh/setup-bun@<sha>), not from its source mise.toml",
    );
    // The commented-out step on lines 9-11 is no step, so its version is no pin.
    expect(stderr).not.toContain("ci.yml:9:");
    expect(stderr).toContain("toolchain-pins: 8 finding(s) across 1 tool(s)");
    expect(r.stdout).toBe("");
  });

  test("a registered exception excuses exactly its value in its file", () => {
    // The drift tree's canary pin is excused; the pass tree's too.
    for (const name of ["agree", "drift"])
      expect(onTree(name).stderr).not.toContain("canary.yml");
  });

  test.each([
    ["no-source", "mise.toml, the source of bun's version, does not exist"],
    ["source-empty", "mise.toml holds no bun version at toml path tools.bun"],
    [
      "site-absent",
      "no file matches Dockerfile: the declaration names a pin site that is not there",
    ],
  ])("%s could not be checked", (name, reason) => {
    const r = onTree(name);
    expectSpawnExit(r, 2, name);
    expect(r.stderr).toContain(`toolchain-pins: could not check: ${reason}`);
  });

  test.each(readdirSync(join(fix, "malformed")).map((f): [string] => [f]))(
    "a malformed declaration (%s) could not be checked",
    (file) => {
      const r = run(["--root", tree("agree"), join(fix, "malformed", file)]);
      expectSpawnExit(r, 2, file);
      expect(r.stderr).toContain("could not check");
      expect(r.stderr).toContain("declaration:");
    },
  );

  test("the malformed declarations each name their defect", () => {
    const reasons: [string, string][] = [
      ["empty.yaml", "is empty"],
      ["not-yaml.yaml", "not YAML"],
      ["no-tools.yaml", "has no `tools` map"],
      ["no-sites.yaml", "tools.bun.sites must list at least one pin site"],
      ["two-readers.yaml", "names more than one of toml, json, yaml, step"],
      ["no-reader.yaml", "needs one of toml, json, yaml, step or a pattern"],
      ["bad-pattern.yaml", "pattern is not a regular expression"],
      ["no-reason.yaml", "exceptions[0].reason must be a non-empty string"],
    ];
    expect(reasons.map(([f]) => f).sort()).toEqual(
      readdirSync(join(fix, "malformed")).sort(),
    );
    for (const [file, reason] of reasons)
      expect(
        run(["--root", tree("agree"), join(fix, "malformed", file)]).stderr,
      ).toContain(reason);
  });
});

describe("command line", () => {
  test.each([
    [[]],
    [["--frobnicate", "pins.yaml"]],
    [["a.yaml", "b.yaml"]],
    [["--root"]],
  ])("%j is a usage error", (args) => {
    const r = run(args);
    expectSpawnExit(r, 2, JSON.stringify(args));
    expect(r.stderr).toContain("usage:");
  });

  test("the root defaults to the working directory", () =>
    expectSpawnExit(run(["pins.yaml"], tree("agree")), 0));

  test("a declaration that is not there could not be checked", () => {
    const r = run(["missing.yaml"], tree("agree"));
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("could not check: missing.yaml: does not exist");
  });

  test("under GitHub Actions each finding is also an annotation", () => {
    const r = onTree("drift", { GITHUB_ACTIONS: "true" });
    expectSpawnExit(r, 1);
    expect(r.stdout).toContain(
      "::error file=.github/workflows/ci.yml,line=8,title=toolchain-pins::",
    );
    expect(
      r.stdout.split("\n").filter((l) => l.startsWith("::error")),
    ).toHaveLength(8);
  });
});

describe("readPins", () => {
  test("a path reader yields one pin, and a pattern beside it reads the value", () => {
    const content =
      '{ "packageManager": "bun@1.4.3", "engines": { "bun": ">=1.4" } }';
    expect(
      readPins({ format: "json", path: "packageManager" }, content, "p"),
    ).toEqual([
      { file: "p", where: "json path packageManager", value: "bun@1.4.3" },
    ]);
    expect(
      readPins(
        { format: "json", path: "packageManager", pattern: /^bun@(.+)$/gm },
        content,
        "p",
      ),
    ).toEqual([
      {
        file: "p",
        where: "json path packageManager (bun@1.4.3)",
        value: "1.4.3",
      },
    ]);
    expect(
      readPins({ format: "json", path: "engines.node" }, content, "p"),
    ).toEqual([]);
    expect(
      readPins(
        { format: "json", path: "packageManager", pattern: /^node@(.+)$/gm },
        content,
        "p",
      )[0],
    ).toEqual({
      file: "p",
      where: "json path packageManager (bun@1.4.3)",
      value: undefined,
      unread: "^node@(.+)$",
    });
  });

  test("a number at a path reads as its text; a map or list does not", () => {
    expect(
      readPins({ format: "yaml", path: "a.b" }, "a:\n  b: 24\n", "y")[0]?.value,
    ).toBe("24");
    expect(
      readPins({ format: "yaml", path: "a" }, "a:\n  b: 24\n", "y"),
    ).toEqual([]);
    expect(
      readPins(
        { format: "toml", path: "tools.bun" },
        '[tools]\nbun = ["1", "2"]\n',
        "t",
      ),
    ).toEqual([]);
  });

  test("a text pattern yields every match with its line, undefined when the group did not capture", () => {
    const content =
      "FROM node:24.3.0\nARG X=1\nFROM node:22.1.0 AS b\nFROM alpine\n";
    const pins = readPins(
      { pattern: /^FROM node:(\d+\.\d+\.\d+)|^FROM (?:alpine)/gm },
      content,
      "D",
    );
    expect(pins.map((p) => [p.line, p.value])).toEqual([
      [1, "24.3.0"],
      [3, "22.1.0"],
      [4, undefined],
    ]);
    expect(pins[2]?.where).toBe("FROM alpine");
  });

  test("a step reader reads each step that uses the action, from the parsed file", () => {
    const workflow = [
      "jobs:",
      "  a:",
      "    steps:",
      "      # - uses: actions/setup-node@v4",
      "      #   with: { node-version: 9.9.9 }",
      "      - uses: Actions/Setup-Node@v4",
      "        with:",
      "          node-version: 24",
      "      - name: no version",
      "        uses: actions/setup-node@v4",
      "      - uses: actions/setup-node@v4",
      "        with: { node-version-file: ./.node-version }",
      "      - uses: actions/setup-nodex@v1",
      "        with: { node-version: 1.0.0 }",
      "      - run: 'echo node-version: 7.7.7'",
      "",
    ].join("\n");
    const step = {
      action: "actions/setup-node",
      input: "node-version",
      fileInput: "node-version-file",
    };
    expect(
      readPins({ step }, workflow, "w.yml").map((p) => [
        p.line,
        p.value,
        p.versionFile,
      ]),
    ).toEqual([
      [6, "24", undefined],
      [10, undefined, undefined],
      [11, undefined, "./.node-version"],
    ]);
    const action =
      "runs:\n  steps:\n    - uses: actions/setup-node@v4\n      with: { node-version: v24.3.0 }\n";
    expect(
      readPins({ step, pattern: /^v(.+)$/gm }, action, "action.yml")[0],
    ).toMatchObject({ line: 3, value: "24.3.0" });
  });

  test("an empty value holds no version", () => {
    expect(
      readPins({ format: "json", path: "a" }, '{ "a": " " }', "p")[0]?.value,
    ).toBeUndefined();
    expect(
      readPins({ pattern: /^bun@(.*)$/gm }, "bun@\n", "p")[0]?.value,
    ).toBeUndefined();
    expect(
      readPins(
        { step: { action: "oven-sh/setup-bun", input: "bun-version" } },
        'jobs:\n  a:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with: { bun-version: "" }\n',
        "w.yml",
      )[0]?.value,
    ).toBeUndefined();
  });

  test("a file that is not its format throws, naming the file", () => {
    expect(() =>
      readPins({ format: "json", path: "a" }, "{", "x.json"),
    ).toThrow("x.json is not JSON");
    expect(() =>
      readPins({ format: "toml", path: "a" }, "[a\n", "x.toml"),
    ).toThrow("x.toml is not TOML");
    expect(() =>
      readPins({ format: "yaml", path: "a" }, "a: [", "x.yaml"),
    ).toThrow("x.yaml is not YAML");
  });
});

describe("parseDeclaration", () => {
  const minimal = `
tools:
  bun:
    source: { file: mise.toml, toml: tools.bun }
    sites:
      - { files: package.json, json: packageManager, pattern: '^bun@(.+)$' }
`;
  test("reads a tool with its source, sites and no exceptions", () => {
    const [bun] = parseDeclaration(minimal);
    expect(bun?.name).toBe("bun");
    expect(bun?.source).toMatchObject({
      file: "mise.toml",
      format: "toml",
      path: "tools.bun",
    });
    expect(bun?.sites[0]?.files).toEqual(["package.json"]);
    expect(bun?.sites[0]?.pattern?.source).toBe("^bun@(.+)$");
    expect(bun?.exceptions).toEqual([]);
  });

  test.each([
    ["tools: {}\n", "`tools` names no tool"],
    ["tools:\n  bun: 3\n", "tools.bun must be a map"],
    [
      "tools:\n  bun:\n    source: 3\n    sites: [{ files: a, json: b }]\n",
      "tools.bun.source must be a map",
    ],
    [
      "tools:\n  bun:\n    source: { toml: a }\n    sites: [{ files: a, json: b }]\n",
      "tools.bun.source.file must be a non-empty string",
    ],
    [
      "tools:\n  bun:\n    source: { file: m, toml: a }\n    sites: [{ files: [], json: b }]\n",
      "sites[0].files is empty",
    ],
    [
      "tools:\n  bun:\n    source: { file: m, toml: a }\n    sites: [{ files: a, step: o/s@v1, with: v }]\n",
      "sites[0].step names the action without its @ref",
    ],
    [
      "tools:\n  bun:\n    source: { file: m, toml: a }\n    sites: [{ files: a, step: o/s }]\n",
      "sites[0].with must be a non-empty string",
    ],
    [
      "tools:\n  bun:\n    source: { file: m, toml: a }\n    sites: [{ files: a, pattern: x, with: v }]\n",
      "sites[0].with names a step input, but there is no step",
    ],
    [
      "tools:\n  bun:\n    source: { file: m, toml: a }\n    sites: [{ files: a, json: b, step: o/s, with: v }]\n",
      "names more than one of toml, json, yaml, step",
    ],
    [
      "tools:\n  bun:\n    source: { file: m, toml: a }\n    sites: [{ files: a, json: b }]\n    exceptions: 1\n",
      "exceptions must be a list",
    ],
    [
      "tools:\n  bun:\n    source: { file: m, toml: a }\n    sites: [{ files: a, json: b }]\n    exceptions: [{ file: a, reason: r }]\n",
      "exceptions[0].value must be a non-empty string",
    ],
    [
      "tools:\n  bun:\n    source: { file: m, toml: a }\n    sites: [{ files: a, json: b }]\n    exceptions: [{ file: a, value: v, reason: ' ' }]\n",
      "exceptions[0].reason must be a non-empty string",
    ],
  ])("rejects %j", (content, reason) =>
    expect(() => parseDeclaration(content)).toThrow(reason),
  );
});

describe("readSource and checkTool", () => {
  const [bun] = parseDeclaration(`
tools:
  bun:
    source: { file: mise.toml, pattern: '^bun = "(.+)"$' }
    sites:
      - { files: mise.toml, pattern: '^bun = "(.+)"$' }
`);
  if (bun === undefined) throw new Error("fixture declaration did not parse");

  test("a source read by pattern must hold exactly one value", () => {
    expect(readSource(tree("agree"), bun)).toBe("1.4.3");
    const twice = {
      ...bun,
      source: { ...bun.source, pattern: /^(\w+) = "(?:.+)"$/gm },
    };
    expect(() => readSource(tree("agree"), twice)).toThrow(
      "holds 2 bun versions",
    );
  });

  test("a pin site may be the source itself and agrees by construction", () => {
    const { findings, pins } = checkTool(
      tree("agree"),
      bun,
      "1.4.3",
      "pins.yaml",
    );
    expect(findings).toEqual([]);
    expect(pins).toBe(1);
  });

  test("an exception is matched by file and value, so one file's other pins stay checked", () => {
    const [tool] = parseDeclaration(`
tools:
  bun:
    source: { file: mise.toml, toml: tools.bun }
    sites:
      - { files: package.json, json: packageManager, pattern: '^bun@(.+)$' }
      - { files: package.json, json: devDependencies.@types/bun }
    exceptions:
      - { file: package.json, value: "1.4.2", reason: the types package lags }
`);
    if (tool === undefined) throw new Error("declaration did not parse");
    const { findings } = checkTool(tree("drift"), tool, "1.4.3", "pins.yaml");
    expect(findings).toEqual([]);
    const { findings: strict } = checkTool(
      tree("drift"),
      { ...tool, exceptions: [] },
      "1.4.3",
      "pins.yaml",
    );
    expect(strict.map((f) => f.problem)).toEqual([
      "bun is pinned to 1.4.2 here (json path devDependencies.@types/bun); mise.toml says 1.4.3.",
    ]);
  });

  const declared = (sites: string) => {
    const [tool] = parseDeclaration(
      `tools:\n  bun:\n    source: { file: mise.toml, toml: tools.bun }\n    sites:\n${sites}`,
    );
    if (tool === undefined) throw new Error("declaration did not parse");
    return tool;
  };
  const mise = '[tools]\nbun = "1.4.3"\n';

  test("every file a path reader names must hold its pin", () => {
    const root = scratch({
      "mise.toml": mise,
      "a/package.json": '{ "packageManager": "bun@1.4.3" }',
      "b/package.json": "{}",
    });
    const tool = declared(
      "      - { files: '*/package.json', json: packageManager, pattern: '^bun@(.+)$' }\n",
    );
    expect(
      checkTool(root, tool, "1.4.3", "pins.yaml").findings.map((f) => [
        f.file,
        f.problem,
      ]),
    ).toEqual([
      [
        "b/package.json",
        "bun's pin is gone: json path packageManager, pattern ^bun@(.+)$ matches nothing in b/package.json.",
      ],
    ]);
  });

  test("every glob a site lists must match a file", () => {
    const root = scratch({
      "mise.toml": mise,
      "package.json": '{ "packageManager": "bun@1.4.3" }',
    });
    const tool = declared(
      "      - { files: [package.json, other/package.json], json: packageManager, pattern: '^bun@(.+)$' }\n",
    );
    expect(() => checkTool(root, tool, "1.4.3", "pins.yaml")).toThrow(
      "no file matches other/package.json",
    );
  });

  test("an empty source value is no source, and an empty pin floats", () => {
    const root = scratch({
      "mise.toml": '[tools]\nbun = ""\n',
      "package.json": '{ "packageManager": "bun@" }',
    });
    const tool = declared(
      "      - { files: package.json, json: packageManager, pattern: '^bun@(.*)$' }\n",
    );
    expect(() => readSource(root, tool)).toThrow("holds no bun version");
    expect(
      checkTool(root, tool, "1.4.3", "pins.yaml").findings[0]?.problem,
    ).toContain("without a version");
  });

  const nodeTool = () => {
    const [tool] = parseDeclaration(
      "tools:\n  node:\n    source: { file: .node-version, pattern: '^v?(\\S+)$' }\n    sites:\n      - { files: .github/workflows/*.yml, step: actions/setup-node, with: node-version, with-file: node-version-file, pattern: '^v?(\\d+\\.\\d+\\.\\d+)$' }\n",
    );
    if (tool === undefined) throw new Error("declaration did not parse");
    return tool;
  };
  const steps = (...withs: string[]) =>
    `jobs:\n  a:\n    steps:\n${withs.map((w) => `      - uses: actions/setup-node@v4\n        with: ${w}\n`).join("")}`;

  test("a step that reads a version-file source agrees; one reading another file does not", () => {
    const root = scratch({
      ".node-version": "24.3.0\n",
      ".github/workflows/ci.yml": steps(
        "{ node-version-file: ./.node-version }",
        "{ node-version-file: .nvmrc }",
      ),
    });
    expect(
      checkTool(root, nodeTool(), "24.3.0", "pins.yaml").findings.map(
        (f) => f.line,
      ),
    ).toEqual([6]);
  });

  test("an explicit version is the pin even beside a file, and is checked first", () => {
    const root = scratch({
      ".node-version": "24.3.0\n",
      ".github/workflows/ci.yml": steps(
        "{ node-version: '22.0.0', node-version-file: .node-version }",
        "{ node-version: 'lts/*', node-version-file: .node-version }",
      ),
    });
    expect(
      checkTool(root, nodeTool(), "24.3.0", "pins.yaml").findings.map(
        (f) => f.problem,
      ),
    ).toEqual([
      "node is pinned to 22.0.0 here (uses: actions/setup-node@v4 (22.0.0)); .node-version says 24.3.0.",
      "node's pin site holds a value the pattern ^v?(\\d+\\.\\d+\\.\\d+)$ does not read (uses: actions/setup-node@v4 (lts/*)); .node-version says 24.3.0.",
    ]);
  });

  test("a pattern that reads one field of a structured file does not make it a version file", () => {
    const [tool] = parseDeclaration(
      `tools:\n  node:\n    source: { file: package.json, pattern: '"engines": \\{ "node": "(\\d+\\.\\d+\\.\\d+)"' }\n    sites:\n      - { files: .github/workflows/*.yml, step: actions/setup-node, with: node-version, with-file: node-version-file }\n`,
    );
    if (tool === undefined) throw new Error("declaration did not parse");
    const root = scratch({
      "package.json": `{\n  "volta": { "node": "22.0.0" },\n  "engines": { "node": "24.3.0" }\n}\n`,
      ".github/workflows/ci.yml": steps("{ node-version-file: package.json }"),
    });
    expect(readSource(root, tool)).toBe("24.3.0");
    expect(
      checkTool(root, tool, "24.3.0", "pins.yaml").findings.map(
        (f) => f.problem,
      ),
    ).toEqual([
      expect.stringContaining("a file holding more than the version"),
    ]);
  });

  test("a node version file agrees when setup-node's own reader takes the source's value from it", () => {
    for (const [content, agrees] of [
      ["# pinned\nv24.3.0\n", true],
      ["nodejs 24.3.0\n", true],
      ["nodejs 24.3.0\npython 3.12.1\n", true],
      ["python 3.12.1\nnodejs 24.3.0\n", true],
      ["nodejs 22.0.0\n", false],
      ["24.3.0 # current\n", false],
      ["24.3.0\n22.0.0\n", true],
      ["22.0.0\n24.3.0\n", false],
      ['note = """\n24.3.0\n"""\n[tools]\nnode = "22.0.0"\n', false],
    ] as const) {
      const root = scratch({
        ".node-version": content,
        ".github/workflows/ci.yml": steps(
          "{ node-version-file: .node-version }",
        ),
      });
      const [tool] = parseDeclaration(
        "tools:\n  node:\n    source: { file: .node-version, pattern: '(\\d+\\.\\d+\\.\\d+)' }\n    sites:\n      - { files: .github/workflows/*.yml, step: actions/setup-node, with: node-version, with-file: node-version-file }\n",
      );
      if (tool === undefined) throw new Error("declaration did not parse");
      expect(checkTool(root, tool, "24.3.0", "pins.yaml").findings.length).toBe(
        agrees ? 0 : 1,
      );
    }
  });

  test("a setup step's reader is found however the step spells the action", () => {
    const [tool] = parseDeclaration(
      "tools:\n  node:\n    source: { file: .node-version, pattern: '^(\\S+)$' }\n    sites:\n      - { files: .github/workflows/*.yml, step: Actions/Setup-Node, with: node-version, with-file: node-version-file }\n",
    );
    if (tool === undefined) throw new Error("declaration did not parse");
    const root = scratch({
      ".node-version": "24.3.0\n",
      ".github/workflows/ci.yml": steps("{ node-version-file: .node-version }"),
    });
    expect(checkTool(root, tool, "24.3.0", "pins.yaml").findings).toEqual([]);
  });

  test("setup-bun reads a version file by its name: a file it does not read never agrees", () => {
    const bunTool = (file: string) => {
      const [tool] = parseDeclaration(
        `tools:\n  bun:\n    source: { file: ${file}, pattern: '^(\\S+)$' }\n    sites:\n      - { files: .github/workflows/*.yml, step: oven-sh/setup-bun, with: bun-version, with-file: bun-version-file }\n`,
      );
      if (tool === undefined) throw new Error("declaration did not parse");
      return tool;
    };
    const problems = (file: string) =>
      checkTool(
        scratch({
          [file]: "1.4.3\n",
          ".github/workflows/ci.yml": `jobs:\n  a:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with: { bun-version-file: ${file} }\n`,
        }),
        bunTool(file),
        "1.4.3",
        "pins.yaml",
      ).findings.map((f) => f.problem);
    expect(problems(".bun-version")).toEqual([]);
    expect(problems("version.txt")).toEqual([
      expect.stringContaining("a file holding more than the version"),
    ]);
  });

  test("an action whose version-file reader the check does not carry never agrees", () => {
    const [tool] = parseDeclaration(
      "tools:\n  python:\n    source: { file: .python-version, pattern: '^(\\S+)$' }\n    sites:\n      - { files: .github/workflows/*.yml, step: actions/setup-python, with: python-version, with-file: python-version-file }\n",
    );
    if (tool === undefined) throw new Error("declaration did not parse");
    const root = scratch({
      ".python-version": "3.12.1\n",
      ".github/workflows/ci.yml":
        "jobs:\n  a:\n    steps:\n      - uses: actions/setup-python@v5\n        with: { python-version-file: .python-version }\n",
    });
    expect(
      checkTool(root, tool, "3.12.1", "pins.yaml").findings.map(
        (f) => f.problem,
      ),
    ).toEqual([
      expect.stringContaining(
        "does not know how actions/setup-python reads a version file",
      ),
    ]);
  });

  test("a step that reads a structured source is a finding: the action picks its own field", () => {
    const root = scratch({
      "mise.toml": mise,
      ".github/workflows/ci.yml":
        "jobs:\n  a:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with: { bun-version-file: ./mise.toml }\n",
    });
    const tool = declared(
      "      - { files: .github/workflows/*.yml, step: oven-sh/setup-bun, with: bun-version, with-file: bun-version-file }\n",
    );
    const { findings } = checkTool(root, tool, "1.4.3", "pins.yaml");
    expect(findings.map((f) => f.problem)).toEqual([
      "bun is set up here from ./mise.toml (uses: oven-sh/setup-bun@v2), a file holding more than the version this check reads at toml path tools.bun; which value the action reads there is not something this check can confirm.",
    ]);
  });
});
