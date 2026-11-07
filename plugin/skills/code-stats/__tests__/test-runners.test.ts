/**
 * The test-runner readers, each a pure function from the repository's
 * files to the rules its runner's configuration declares, and the layer's
 * place between built-in detection and the `code_stats` configuration.
 */
import { describe, expect, test } from "bun:test";
import { parseCodeStatsConfig } from "../scripts/lib/config.ts";
import { globMatcher } from "../scripts/lib/test-runners/glob.ts";
import { readGradle } from "../scripts/lib/test-runners/gradle.ts";
import {
  type Reading,
  type RepoFiles,
  readTestRunners,
  runnerRuleFor,
} from "../scripts/lib/test-runners/index.ts";
import { readJest } from "../scripts/lib/test-runners/jest.ts";
import { exportedObject } from "../scripts/lib/test-runners/js-literal.ts";
import { readMaven } from "../scripts/lib/test-runners/maven.ts";
import { readPytest } from "../scripts/lib/test-runners/pytest.ts";
import { readVitest } from "../scripts/lib/test-runners/vitest.ts";
import { classified, DEFAULTS, facts } from "./helpers.ts";
import { classify } from "../scripts/lib/classify.ts";

/** The repository files a reader sees: the given texts, plus paths it only lists. */
function repo(texts: Record<string, string>, listed: string[] = []): RepoFiles {
  return {
    paths: [...Object.keys(texts), ...listed],
    read: (path) => texts[path] ?? null,
    bytes: (path) => {
      const text = texts[path];
      return text === undefined ? null : new TextEncoder().encode(text);
    },
  };
}

/** The paths among `paths` the reading claims as tests. */
const claimed = (reading: Reading, paths: string[]) =>
  paths.filter((p) => runnerRuleFor(reading, p) !== null);

describe("the runners' glob dialect", () => {
  test("jest's and vitest's default patterns, with their extended forms", () => {
    const jest = globMatcher("**/?(*.)+(spec|test).?([mc])[jt]s?(x)");
    expect(jest("src/a.test.ts")).toBe(true);
    expect(jest("a.spec.mjs")).toBe(true);
    expect(jest("src/a.ts")).toBe(false);
    const tests = globMatcher("**/__tests__/**/*.?([mc])[jt]s?(x)");
    expect(tests("pkg/__tests__/deep/a.jsx")).toBe(true);
    expect(tests("pkg/__tests__/a.json")).toBe(false);
    const vitest = globMatcher("**/*.{test,spec}.?(c|m)[jt]s?(x)");
    expect(vitest("a.test.cts")).toBe(true);
    expect(vitest("a.check.ts")).toBe(false);
  });

  test("* and ? stay inside one folder; ** spans any number", () => {
    expect(globMatcher("src/*.ts")("src/a/b.ts")).toBe(false);
    expect(globMatcher("src/**/*.ts")("src/b.ts")).toBe(true);
    expect(globMatcher("src/**")("src/a/b.ts")).toBe(true);
    expect(globMatcher("[!a]*.py")("b.py")).toBe(true);
    expect(globMatcher("[!a]*.py")("a.py")).toBe(false);
  });

  test("a form it does not read is refused, never read another way", () => {
    expect(() => globMatcher("!(a).ts")).toThrow("!(…)");
    expect(() => globMatcher("a{1..3}.ts")).toThrow("range");
    expect(() => globMatcher("a{b.ts")).toThrow("never closes");
  });
});

describe("a configuration read as text", () => {
  test("module.exports, export default, defineConfig and a declared variable", () => {
    const forms = [
      "module.exports = { testMatch: ['a'] };",
      "export default { testMatch: ['a'] }",
      "export default defineConfig({ testMatch: ['a'] })",
      "import type { Config } from 'jest';\nconst config: Config = { testMatch: ['a'] };\nexport default config;",
      "const c = { testMatch: [`a`] } satisfies Config;\nexport default defineConfig(c);",
    ];
    for (const text of forms)
      expect(exportedObject(text).entries.get("testMatch")).toEqual(["a"]);
  });

  test("a value that is not a literal is kept as computed, not read", () => {
    const obj = exportedObject(
      `module.exports = { a: path.join(x, 'y'), b: \`t\${x}\`, c: 'k' + v, d: [1, 'z'] }`,
    );
    for (const key of ["a", "b", "c"])
      expect(obj.entries.get(key)).toHaveProperty("computed");
    expect(obj.entries.get("d")).toEqual([1, "z"]);
  });

  test("a function, another call, or a changed variable is refused with its reason", () => {
    expect(() => exportedObject("module.exports = async () => ({})")).toThrow(
      "exports a function",
    );
    expect(() =>
      exportedObject("export default defineConfig(({ mode }) => ({}))"),
    ).toThrow("passes a function");
    expect(() => exportedObject("export default merge(a, b)")).toThrow(
      "merge(…)",
    );
    expect(() =>
      exportedObject(
        "const c = { roots: [] };\nc.roots.push('x');\nmodule.exports = c;",
      ),
    ).toThrow("uses c again after declaring it");
    expect(() => exportedObject("const x = 1;")).toThrow("no export");
  });

  test("comments are not read, and strings that hold comment markers are", () => {
    const obj = exportedObject(
      "// module.exports = { testMatch: ['no'] }\nmodule.exports = { /* a */ testMatch: ['//x', '/*y*/'] };",
    );
    expect(obj.entries.get("testMatch")).toEqual(["//x", "/*y*/"]);
  });
});

describe("jest", () => {
  test("testMatch under roots, less testPathIgnorePatterns", () => {
    const reading = readJest(
      repo({
        "web/jest.config.ts": `export default {
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.check.ts", "!**/skip/**"],
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/src/slow/"],
};`,
      }),
    );
    expect(reading.unreadable).toEqual([]);
    expect(
      claimed(reading, [
        "web/src/a.check.ts",
        "web/src/deep/b.check.ts",
        "web/src/skip/c.check.ts",
        "web/src/slow/d.check.ts",
        "web/other/e.check.ts",
        "f.check.ts",
        "web/src/a.ts",
      ]),
    ).toEqual(["web/src/a.check.ts", "web/src/deep/b.check.ts"]);
    expect(runnerRuleFor(reading, "web/src/a.check.ts")).toMatchObject({
      reader: "jest",
      file: "web/jest.config.ts",
      key: "testMatch",
      pattern: "**/*.check.ts",
    });
  });

  test("<rootDir> patterns, rootDir itself, and testRegex", () => {
    const reading = readJest(
      repo({
        "config/jest.config.json": JSON.stringify({
          rootDir: "..",
          testMatch: ["<rootDir>/checks/**/*.js"],
          testRegex: ["/specs/.*\\.js$"],
        }),
      }),
    );
    expect(
      claimed(reading, ["checks/a/b.js", "lib/specs/c.js", "lib/d.js"]),
    ).toEqual(["checks/a/b.js", "lib/specs/c.js"]);
  });

  test("roots alone apply jest's default testMatch under them", () => {
    const reading = readJest(
      repo({
        "jest.config.js": "module.exports = { roots: ['<rootDir>/app'] };",
      }),
    );
    expect(
      claimed(reading, [
        "app/x.test.js",
        "app/__tests__/y.js",
        "lib/z.test.js",
      ]),
    ).toEqual(["app/x.test.js", "app/__tests__/y.js"]);
    expect(runnerRuleFor(reading, "app/x.test.js")?.key).toBe("roots");
  });

  test("the package.json jest key, only where no jest.config file is beside it", () => {
    const pkg = JSON.stringify({ jest: { testMatch: ["**/*.pkg.js"] } });
    const reading = readJest(
      repo({
        "a/package.json": pkg,
        "b/package.json": pkg,
        "b/jest.config.js": "module.exports = { testMatch: ['**/*.cfg.js'] };",
        "c/package.json": JSON.stringify({ name: "c" }),
      }),
    );
    expect(
      claimed(reading, [
        "a/x.pkg.js",
        "b/x.pkg.js",
        "b/x.cfg.js",
        "c/x.pkg.js",
      ]),
    ).toEqual(["a/x.pkg.js", "b/x.cfg.js"]);
    expect(runnerRuleFor(reading, "a/x.pkg.js")?.file).toBe("a/package.json");
  });

  test("a configuration that declares none of the keys claims nothing", () => {
    const reading = readJest(
      repo({ "jest.config.js": "module.exports = { verbose: true };" }),
    );
    expect(reading).toEqual({ rules: [], unreadable: [] });
  });

  test("what it cannot read is reported unreadable, with nothing claimed", () => {
    const reading = readJest(
      repo({
        "a/jest.config.js":
          "module.exports = async () => ({ testMatch: ['**/*.js'] });",
        "b/jest.config.js": "module.exports = { ...base, verbose: true };",
        "c/jest.config.js": "module.exports = { testMatch: [pattern] };",
        "d/jest.config.js": "module.exports = { testMatch: ['src/*.js'] };",
        "e/jest.config.js": "module.exports = { testRegex: '^/home/.*' };",
      }),
    );
    expect(reading.rules).toEqual([]);
    expect(reading.unreadable.map((u) => [u.path, u.why])).toEqual([
      ["a/jest.config.js", expect.stringContaining("exports a function")],
      [
        "b/jest.config.js",
        expect.stringContaining("testMatch may come from a spread"),
      ],
      [
        "c/jest.config.js",
        expect.stringContaining(
          "testMatch holds a value that is not a string (pattern)",
        ),
      ],
      [
        "d/jest.config.js",
        expect.stringContaining("matched against absolute paths"),
      ],
      [
        "e/jest.config.js",
        expect.stringContaining("anchored to an absolute path"),
      ],
    ]);
  });
});

describe("vitest", () => {
  test("test.include less test.exclude, a configDefaults spread read as vitest's defaults", () => {
    const reading = readVitest(
      repo({
        "pkg/vitest.config.mts": `import { configDefaults, defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/**/*.check.ts"],
    exclude: [...configDefaults.exclude, "src/legacy/**"],
  },
});`,
      }),
    );
    expect(
      claimed(reading, [
        "pkg/src/a.check.ts",
        "pkg/src/legacy/b.check.ts",
        "pkg/src/node_modules/c.check.ts",
        "pkg/d.check.ts",
        "src/e.check.ts",
      ]),
    ).toEqual(["pkg/src/a.check.ts"]);
    expect(runnerRuleFor(reading, "pkg/src/a.check.ts")).toMatchObject({
      reader: "vitest",
      file: "pkg/vitest.config.mts",
      key: "test.include",
    });
  });

  test("vite.config is read only in a folder with no vitest.config", () => {
    const vite = "export default { test: { include: ['**/*.vite.ts'] } }";
    const reading = readVitest(
      repo({
        "a/vite.config.ts": vite,
        "b/vite.config.ts": vite,
        "b/vitest.config.ts":
          "export default { test: { include: ['**/*.vt.ts'] } }",
      }),
    );
    expect(
      claimed(reading, ["a/x.vite.ts", "b/x.vite.ts", "b/x.vt.ts"]),
    ).toEqual(["a/x.vite.ts", "b/x.vt.ts"]);
  });

  test("test.dir moves the base; a vite.config about something else is not a test configuration", () => {
    const reading = readVitest(
      repo({
        "vitest.config.ts":
          "export default { test: { dir: 'packages', include: ['*/x.ts'] } }",
        "web/vite.config.ts": "export default ({ mode }) => ({ base: mode })",
      }),
    );
    expect(reading.unreadable).toEqual([]);
    expect(claimed(reading, ["packages/a/x.ts", "a/x.ts"])).toEqual([
      "packages/a/x.ts",
    ]);
  });

  test("a function configuration is unreadable", () => {
    const reading = readVitest(
      repo({
        "vitest.config.ts":
          "export default defineConfig(({ mode }) => ({ test: { include: ['**/*.ts'] } }))",
      }),
    );
    expect(reading.rules).toEqual([]);
    expect(reading.unreadable[0]).toMatchObject({
      reader: "vitest",
      path: "vitest.config.ts",
      why: expect.stringContaining("passes a function"),
    });
  });
});

describe("pytest", () => {
  test("testpaths and python_files from pyproject.toml", () => {
    const reading = readPytest(
      repo({
        "pyproject.toml":
          '[tool.pytest.ini_options]\ntestpaths = ["checks", "more/checks"]\npython_files = "check_*.py *_check.py"\n',
      }),
    );
    expect(
      claimed(reading, [
        "checks/check_a.py",
        "checks/deep/b_check.py",
        "more/checks/check_c.py",
        "checks/helpers.py",
        "app/check_d.py",
      ]),
    ).toEqual([
      "checks/check_a.py",
      "checks/deep/b_check.py",
      "more/checks/check_c.py",
    ]);
    expect(runnerRuleFor(reading, "checks/check_a.py")).toMatchObject({
      reader: "pytest",
      file: "pyproject.toml",
      key: "[tool.pytest.ini_options] testpaths and python_files",
    });
  });

  test("python_files alone applies under the configuration's folder", () => {
    const reading = readPytest(
      repo({ "svc/pytest.ini": "[pytest]\npython_files = check_*.py\n" }),
    );
    expect(
      claimed(reading, ["svc/a/check_x.py", "check_y.py", "svc/z.py"]),
    ).toEqual(["svc/a/check_x.py"]);
  });

  test("testpaths alone keeps pytest's default python_files; a file it names is a test", () => {
    const reading = readPytest(
      repo({
        "setup.cfg":
          "[metadata]\nname = x\n\n[tool:pytest]\ntestpaths =\n    verify\n    smoke.py\n",
      }),
    );
    expect(
      claimed(reading, [
        "verify/test_a.py",
        "verify/b.py",
        "smoke.py",
        "test_c.py",
      ]),
    ).toEqual(["verify/test_a.py", "smoke.py"]);
  });

  test("pytest's order of files: the first that holds its section decides", () => {
    const reading = readPytest(
      repo({
        "setup.cfg": "[tool:pytest]\npython_files = cfg_*.py\n",
        "tox.ini":
          "[tox]\nenvlist = py3\n\n[pytest]\npython_files = tox_*.py\n",
        "pyproject.toml": '[project]\nname = "x"\n',
      }),
    );
    expect(claimed(reading, ["tox_a.py", "cfg_a.py"])).toEqual(["tox_a.py"]);
  });

  test("a configuration that sets neither claims nothing; invalid TOML is unreadable", () => {
    expect(
      readPytest(repo({ "pytest.ini": "[pytest]\naddopts = -q\n" })),
    ).toEqual({ rules: [], unreadable: [] });
    const broken = readPytest(
      repo({ "pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = [\n" }),
    );
    expect(broken.unreadable[0]?.why).toContain("not valid TOML");
  });
});

describe("Gradle", () => {
  test("the convention, and srcDirs = replacing it for its language", () => {
    const reading = readGradle(
      repo({
        "build.gradle": `sourceSets {
    test {
        java { srcDirs = ['qa/java'] }
        resources { srcDir 'qa/resources' }
    }
}
test { useJUnitPlatform() }
`,
      }),
    );
    expect(reading.unreadable).toEqual([]);
    expect(
      claimed(reading, [
        "qa/java/A.java",
        "src/test/java/B.java",
        "src/test/kotlin/C.kt",
        "qa/resources/D.java",
        "src/main/java/E.java",
      ]),
    ).toEqual(["qa/java/A.java", "src/test/kotlin/C.kt"]);
    expect(runnerRuleFor(reading, "qa/java/A.java")).toMatchObject({
      reader: "Gradle",
      file: "build.gradle",
      key: "sourceSets.test.java.srcDirs",
      pattern: "qa/java",
    });
  });

  test("the Kotlin script forms add folders beside the convention", () => {
    const reading = readGradle(
      repo({
        "app/build.gradle.kts": `sourceSets {
    getByName("test") { kotlin.srcDir("checks") }
}
sourceSets["test"].java.srcDirs(listOf("more", file("extra")))
`,
      }),
    );
    expect(
      claimed(reading, [
        "app/checks/A.kt",
        "app/more/B.java",
        "app/extra/C.java",
        "app/src/test/kotlin/D.kt",
        "checks/E.kt",
      ]),
    ).toEqual([
      "app/checks/A.kt",
      "app/more/B.java",
      "app/extra/C.java",
      "app/src/test/kotlin/D.kt",
    ]);
  });

  test("folders built when the build runs are unreadable, and nothing is claimed", () => {
    const reading = readGradle(
      repo({
        "a/build.gradle":
          "def dirs = ['qa']\nsourceSets.test.java.srcDirs = dirs.collect { file(it) }\n",
        "b/build.gradle.kts":
          'sourceSets { test { java.srcDir("$buildDir/generated-checks") } }\n',
        "c/build.gradle": `sourceSets.all { set -> set.java.srcDir "src/\${set.name}/extra" }\n`,
      }),
    );
    expect(reading.rules).toEqual([]);
    expect(reading.unreadable.map((u) => [u.path, u.why])).toEqual([
      [
        "a/build.gradle",
        expect.stringContaining(
          "sourceSets.test.java.srcDirs is computed when the build runs",
        ),
      ],
      [
        "b/build.gradle.kts",
        expect.stringContaining(
          "sourceSets.test.java.srcDir is computed when the build runs",
        ),
      ],
      ["c/build.gradle", expect.stringContaining("in a loop")],
    ]);
  });
});

describe("Maven", () => {
  test("testSourceDirectory, or the src/test/java default", () => {
    const reading = readMaven(
      repo({
        "pom.xml": `<project><build><testSourceDirectory>\${project.basedir}/qa</testSourceDirectory></build></project>`,
        "lib/pom.xml": "<project><artifactId>lib</artifactId></project>",
        "parent/pom.xml": "<project><packaging>pom</packaging></project>",
      }),
    );
    expect(
      claimed(reading, [
        "qa/A.java",
        "src/test/java/B.java",
        "lib/src/test/java/C.java",
        "parent/src/test/java/D.java",
      ]),
    ).toEqual(["qa/A.java", "lib/src/test/java/C.java"]);
    expect(runnerRuleFor(reading, "lib/src/test/java/C.java")).toMatchObject({
      reader: "Maven",
      file: "lib/pom.xml",
      key: "the src/test/java default",
    });
  });

  test("a value inside a profile or a comment is not read; a property is unreadable", () => {
    const reading = readMaven(
      repo({
        "a/pom.xml":
          "<project><!-- <testSourceDirectory>x</testSourceDirectory> --><profiles><profile><build><testSourceDirectory>y</testSourceDirectory></build></profile></profiles></project>",
        "b/pom.xml": `<project><build><testSourceDirectory>\${checks.dir}</testSourceDirectory></build></project>`,
      }),
    );
    expect(
      claimed(reading, ["a/x/A.java", "a/y/B.java", "a/src/test/java/C.java"]),
    ).toEqual(["a/src/test/java/C.java"]);
    expect(reading.unreadable).toEqual([
      {
        reader: "Maven",
        path: "b/pom.xml",
        why: `testSourceDirectory "\${checks.dir}" is built from a property`,
      },
    ]);
  });

  test("a comment ends at its first -->, and markup inside it is not read", () => {
    const reading = readMaven(
      repo({
        "pom.xml":
          "<project><build><!-- old: <testSourceDirectory>x</testSourceDirectory> --><testSourceDirectory>qa</testSourceDirectory></build></project>",
      }),
    );
    expect(reading.unreadable).toEqual([]);
    expect(claimed(reading, ["qa/A.java", "x/B.java"])).toEqual(["qa/A.java"]);
  });

  test("a comment holding --, a <!-- inside it included, makes the file unreadable", () => {
    const reading = readMaven(
      repo({
        "pom.xml":
          "<project><build><!-- old: <!-- x --><testSourceDirectory>qa</testSourceDirectory></build></project>",
      }),
    );
    expect(reading.rules).toEqual([]);
    expect(reading.unreadable).toEqual([
      {
        reader: "Maven",
        path: "pom.xml",
        why: "has a comment holding -- (<!-- -- -->)",
      },
    ]);
  });

  test("markup at <! that is no comment, CDATA section or document type declaration makes the file unreadable", () => {
    const reading = readMaven(
      repo({
        "pom.xml":
          "<project><build><!<!-- x -->--<testSourceDirectory>y</testSourceDirectory>--></build></project>",
      }),
    );
    expect(reading.rules).toEqual([]);
    expect(reading.unreadable).toEqual([
      {
        reader: "Maven",
        path: "pom.xml",
        why: 'has malformed markup ("<!<!-- x -->--<testS")',
      },
    ]);
  });

  test("a comment that never closes makes the file unreadable", () => {
    const reading = readMaven(
      repo({
        "pom.xml":
          "<project><build><testSourceDirectory>qa</testSourceDirectory><!-- unfinished",
      }),
    );
    expect(reading.rules).toEqual([]);
    expect(reading.unreadable).toEqual([
      {
        reader: "Maven",
        path: "pom.xml",
        why: "has a comment (<!--) it never closes",
      },
    ]);
  });
});

describe("the layer", () => {
  test("configuration in a vendored or fixture folder is not read", () => {
    const reading = readTestRunners(
      repo({
        "vendor/lib/jest.config.js":
          "module.exports = { testMatch: ['**/*.js'] };",
        "tests/fixtures/app/pom.xml": "<project/>",
      }),
    );
    expect(reading).toEqual({ rules: [], unreadable: [] });
  });

  const reading = readTestRunners(
    repo({
      "jest.config.js": "module.exports = { testMatch: ['**/*.check.js'] };",
    }),
  );
  const kind = (
    path: string,
    config = DEFAULTS,
    attributes?: Record<string, string>,
  ) =>
    classify(facts(path, "", attributes), config, new Map(), undefined, reading)
      .kind;

  test("overrides built-in detection, naming the reader, file and key", () => {
    expect(classified("src/a.check.js").kind.value).toBe("code");
    expect(kind("src/a.check.js")).toEqual({
      value: "test",
      rule: 'test runner jest: jest.config.js testMatch "**/*.check.js"',
    });
    expect(kind("fixtures/b.check.js").value).toBe("test");
  });

  test("does not turn a vendored, generated or non-code file into a test", () => {
    expect(kind("vendor/a.check.js").value).toBe("vendored");
    expect(
      kind("a.check.js", DEFAULTS, { "linguist-generated": "set" }).value,
    ).toBe("generated");
    expect(
      kind("a.check.js", DEFAULTS, { "linguist-documentation": "set" }).value,
    ).toBe("docs");
  });

  test("the code_stats kinds and the classify command override it", () => {
    const config = parseCodeStatsConfig({ kinds: { code: ["src/**"] } });
    expect(kind("src/a.check.js", config)).toEqual({
      value: "code",
      rule: 'code_stats.kinds.code glob "src/**"',
    });
    const byCommand = classify(
      facts("src/a.check.js"),
      DEFAULTS,
      new Map(),
      { kind: "docs" },
      reading,
    ).kind;
    expect(byCommand).toEqual({ value: "docs", rule: "classify_command" });
  });
});
