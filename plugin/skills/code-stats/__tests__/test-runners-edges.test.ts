/**
 * The test-runner readers at their edges: configuration text that reads one
 * way and runs another. Each reader either reads what the runner does or
 * reports the file unreadable and claims nothing from it.
 */
import { describe, expect, test } from "bun:test";
import { globMatcher } from "../scripts/lib/test-runners/glob.ts";
import { readGradle } from "../scripts/lib/test-runners/gradle.ts";
import {
  type Reading,
  type RepoFiles,
  runnerRuleFor,
} from "../scripts/lib/test-runners/index.ts";
import { readJest } from "../scripts/lib/test-runners/jest.ts";
import {
  exportedObject,
  valueAt,
} from "../scripts/lib/test-runners/js-literal.ts";
import { readMaven } from "../scripts/lib/test-runners/maven.ts";
import { readPytest } from "../scripts/lib/test-runners/pytest.ts";
import { readVitest } from "../scripts/lib/test-runners/vitest.ts";

function repo(texts: Record<string, string>): RepoFiles {
  return { paths: Object.keys(texts), read: (path) => texts[path] ?? null };
}

const claimed = (reading: Reading, paths: string[]) =>
  paths.filter((p) => runnerRuleFor(reading, p) !== null);

const whys = (reading: Reading) => reading.unreadable.map((u) => u.why);

describe("glob patterns", () => {
  test("an escaped * or ? stands for itself", () => {
    const star = globMatcher("**/a\\*.check.js");
    expect(star("a*.check.js")).toBe(true);
    expect(star("aaaa.check.js")).toBe(false);
    const mark = globMatcher("a\\?.js");
    expect(mark("a?.js")).toBe(true);
    expect(mark("ab.js")).toBe(false);
  });

  test("a pattern no regular expression can stand for is unreadable, not a crash", () => {
    const reading = readJest(
      repo({
        "jest.config.js": "module.exports = { testMatch: ['**/[z-a].js'] };",
      }),
    );
    expect(reading.rules).toEqual([]);
    expect(whys(reading)[0]).toContain("[z-a]");
  });
});

describe("JavaScript configuration read as text", () => {
  test("a regular expression value is skipped whole, and the read ends", () => {
    const obj = exportedObject(
      "module.exports = { testMatch: ['**/*.check.js'], a: /;/, b: /[}\\/]'/g, c: 'k' };",
    );
    expect(obj.entries.get("testMatch")).toEqual(["**/*.check.js"]);
    expect(obj.entries.get("c")).toBe("k");
  });

  test("a stray delimiter is unreadable rather than read forever", () => {
    expect(() => exportedObject("module.exports = { a: 1; b: 2 };")).toThrow(
      "where a value belongs",
    );
    expect(() => exportedObject("module.exports = { a: [1; 2] };")).toThrow(
      "where a value belongs",
    );
  });

  test("an export written inside a string is not the export", () => {
    const obj = exportedObject(
      "module.exports = { testMatch: ['**/*.check.js'], displayName: 'module.exports = {}' };",
    );
    expect(obj.entries.get("testMatch")).toEqual(["**/*.check.js"]);
  });

  test("an export that goes on past the object is unreadable", () => {
    for (const text of [
      "module.exports = { testMatch: ['a'] } && makeConfig();",
      "export default defineConfig({ testMatch: ['a'] }).extend(x)",
      "export default defineConfig({ testMatch: ['a'] }, other)",
      "const c = { testMatch: ['a'] } || base;\nmodule.exports = c;",
    ])
      expect(() => exportedObject(text)).toThrow("computed when it runs");
  });

  test("an export the file changes, reassigns or aliases is unreadable", () => {
    for (const text of [
      "let c = { testMatch: ['a'] };\nc = makeConfig();\nmodule.exports = c;",
      "const c = { testMatch: ['a'] };\nconst d = c;\nd.testMatch = [];\nmodule.exports = c;",
      "module.exports = { testMatch: ['a'] };\nmodule.exports.testMatch = [];",
      "module.exports = { testMatch: ['a'] };\nObject.assign(module.exports, x);",
      "module.exports = { testMatch: ['a'] };\nexports.testMatch = [];",
      "module.exports = { testMatch: ['a'] };\nmodule['exports'].testMatch = [];",
      "module.exports = { testMatch: ['a'] };\nthis.testMatch = [];",
      "const c = module.exports = { testMatch: ['a'] };\nc.testMatch = [];",
      `const c = { testMatch: ['a'] };\nconsole.log(\`\${c.testMatch = []}\`);\nmodule.exports = c;`,
    ])
      expect(() => exportedObject(text)).toThrow();
  });

  test("a type assertion ends at the type, and a runtime tail after it is unreadable", () => {
    expect(() =>
      exportedObject(
        "export default { testMatch: ['a'] } as Config && makeConfig();",
      ),
    ).toThrow("computed when it runs");
    for (const text of [
      "export default { testMatch: ['a'] } as const satisfies vite.UserConfig<Env>[];",
      "const c = { testMatch: ['a'] };\nexport default c\nexport const label = 'checks';",
      `module.exports = { module: 'x', testMatch: ['a'], label: \`n\${'a'}\` };`,
    ])
      expect(exportedObject(text).entries.get("testMatch")).toEqual(["a"]);
  });

  test("a spread may override every entry before it, not those after", () => {
    const before = exportedObject(
      "module.exports = { testMatch: ['a'], ...shared };",
    );
    expect(() => valueAt(before, ["testMatch"])).toThrow("spread");
    const after = exportedObject(
      "module.exports = { ...shared, testMatch: ['a'] };",
    );
    expect(valueAt(after, ["testMatch"])).toEqual(["a"]);
    const nested = exportedObject(
      "export default { test: { include: ['a'] }, [key]: x }",
    );
    expect(() => valueAt(nested, ["test", "include"])).toThrow("spread");
  });
});

describe("jest testMatch order", () => {
  test("a later pattern overrides an earlier negation", () => {
    const reading = readJest(
      repo({
        "jest.config.js":
          "module.exports = { testMatch: ['!**/legacy/**', '**/*.check.js', '!**/skip/**'] };",
      }),
    );
    expect(
      claimed(reading, ["legacy/a.check.js", "skip/b.check.js", "c.check.js"]),
    ).toEqual(["legacy/a.check.js", "c.check.js"]);
  });

  test("the last positive pattern that matches is the one named", () => {
    const reading = readJest(
      repo({
        "jest.config.js":
          "module.exports = { testMatch: ['**/*.js', '**/*.check.js'] };",
      }),
    );
    expect(runnerRuleFor(reading, "a.check.js")?.pattern).toBe("**/*.check.js");
  });
});

describe("vitest", () => {
  test("a vite.config with a quoted test key is read", () => {
    const reading = readVitest(
      repo({
        "vite.config.ts":
          "import { defineConfig } from 'vite';\nexport default defineConfig({ 'test': { include: ['**/*.check.ts'] } });",
      }),
    );
    expect(reading.unreadable).toEqual([]);
    expect(claimed(reading, ["a.check.ts", "a.ts"])).toEqual(["a.check.ts"]);
  });

  test("an unreadable vite.config about something else stays quiet", () => {
    const reading = readVitest(
      repo({ "vite.config.ts": "export default makeConfig({ plugins: [] })" }),
    );
    expect(reading).toEqual({ rules: [], unreadable: [] });
  });
});

describe("pytest", () => {
  test("testpaths outside the configuration's folder is found under its own folder", () => {
    const reading = readPytest(
      repo({
        "config/pytest.ini":
          "[pytest]\ntestpaths = ../qa\npython_files = check_*.py\n",
      }),
    );
    expect(claimed(reading, ["qa/check_cart.py", "qa/cart.py"])).toEqual([
      "qa/check_cart.py",
    ]);
  });

  test("a pyproject.toml whose pytest table is commented out gives way to setup.cfg", () => {
    const reading = readPytest(
      repo({
        "pyproject.toml":
          "# [tool.pytest.ini_options]\n[project]\nname = 'x'\n",
        "setup.cfg": "[tool:pytest]\npython_files = check_*.py\n",
      }),
    );
    expect(reading.rules[0]?.file).toBe("setup.cfg");
    expect(claimed(reading, ["check_a.py", "test_a.py"])).toEqual([
      "check_a.py",
    ]);
  });

  test("a testpaths or python_files of another type is unreadable", () => {
    for (const value of ["123", "['qa', 1]"]) {
      const reading = readPytest(
        repo({
          "pyproject.toml": `[tool.pytest.ini_options]\ntestpaths = ${value}\npython_files = 'check_*.py'\n`,
        }),
      );
      expect(reading.rules).toEqual([]);
      expect(whys(reading)[0]).toContain("testpaths");
    }
  });
});

describe("Gradle", () => {
  test("setSrcDirs replaces the folders added before it", () => {
    const reading = readGradle(
      repo({
        "build.gradle":
          "sourceSets.test.java.srcDir('oldChecks')\nsourceSets.test.java.setSrcDirs(['newChecks'])\n",
      }),
    );
    expect(
      claimed(reading, [
        "oldChecks/A.java",
        "newChecks/B.java",
        "src/test/java/C.java",
        "src/test/kotlin/D.kt",
      ]),
    ).toEqual(["newChecks/B.java", "src/test/kotlin/D.kt"]);
  });
});

describe("Maven", () => {
  const pom = (inner: string) =>
    `<project><modelVersion>4.0.0</modelVersion>${inner}</project>`;

  test("a comment inside a value adds nothing to it", () => {
    const reading = readMaven(
      repo({
        "pom.xml": pom(
          "<build><testSourceDirectory>qa<!-- why -->/java</testSourceDirectory></build>",
        ),
      }),
    );
    expect(claimed(reading, ["qa/java/Check.java"])).toEqual([
      "qa/java/Check.java",
    ]);
  });

  test("a comment opener inside CDATA is text, not a comment", () => {
    const reading = readMaven(
      repo({
        "pom.xml": pom(
          "<description><![CDATA[Document the <!-- opener]]></description><build><testSourceDirectory>qa</testSourceDirectory></build>",
        ),
      }),
    );
    expect(reading.unreadable).toEqual([]);
    expect(claimed(reading, ["qa/Check.java"])).toEqual(["qa/Check.java"]);
  });

  test("only the project's own build sets the folder, not a plugin's configuration", () => {
    const reading = readMaven(
      repo({
        "pom.xml": pom(
          "<build><plugins><plugin><configuration><testSourceDirectory>qa</testSourceDirectory></configuration></plugin></plugins></build>",
        ),
      }),
    );
    expect(claimed(reading, ["qa/Check.java", "src/test/java/T.java"])).toEqual(
      ["src/test/java/T.java"],
    );
  });

  test("a > inside a quoted attribute does not end the tag", () => {
    const reading = readMaven(
      repo({
        "pom.xml": pom(
          '<build><plugins><plugin><configuration><option value=">"/></configuration></plugin></plugins><testSourceDirectory>qa</testSourceDirectory></build>',
        ),
      }),
    );
    expect(reading.unreadable).toEqual([]);
    expect(claimed(reading, ["qa/Check.java", "src/test/java/T.java"])).toEqual(
      ["qa/Check.java"],
    );
  });

  test("a closing tag that does not match the open element is unreadable", () => {
    const reading = readMaven(
      repo({ "pom.xml": pom("<build><testSourceDirectory>qa</build>") }),
    );
    expect(reading.rules).toEqual([]);
    expect(whys(reading)[0]).toContain("closes <build>");
  });
});
