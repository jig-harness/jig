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

  test("a template's interpolation is lexed as code: its strings and templates are not syntax", () => {
    expect(() =>
      exportedObject(
        `const c = { testMatch: ['a'] };\nconst label = \`\${"}" + (c.testMatch = [])}\`;\nexport default c;`,
      ),
    ).toThrow("uses c again");
    for (const text of [
      `const c = { testMatch: ['a'], label: \`\${"c"}\` };\nexport default c;`,
      `const c = { testMatch: ['a'], label: \`\${\`\${'}'}\`}\` };\nexport default c;`,
    ])
      expect(exportedObject(text).entries.get("testMatch")).toEqual(["a"]);
  });

  test("deeply nested templates are lexed in linear time", () => {
    let label = "'x'";
    for (let n = 0; n < 40; n++) label = `\`\${${label}}\``;
    const started = performance.now();
    const read = exportedObject(
      `module.exports = { testMatch: ['a'], label: ${label} };`,
    );
    expect(read.entries.get("testMatch")).toEqual(["a"]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("an export or declaration that may not run, or runs inside something else, is unreadable", () => {
    for (const text of [
      "if (false) module.exports = { testMatch: ['a'] };",
      "if (false)\n  module.exports = { testMatch: ['a'] };",
      "if (x) {} else module.exports = { testMatch: ['a'] };",
      "function f() { module.exports = { testMatch: ['a'] }; }",
      "const f = () => module.exports = { testMatch: ['a'] };",
      "if (x) { var c = { testMatch: ['a'] }; }\nmodule.exports = c;",
      "while (x)\n  module.exports = { testMatch: ['a'] };",
      "for (const k of ks)\nmodule.exports = { testMatch: ['a'] };",
      "for await (const k of ks)\nmodule.exports = { testMatch: ['a'] };",
      "if (check(x))\nmodule.exports = { testMatch: ['a'] };",
    ])
      expect(() => exportedObject(text)).toThrow("may change when it runs");
    for (const text of [
      "const a = 'x'\nmodule.exports = { testMatch: ['a'] }",
      "console.info(\"config\")\nmodule.exports = { testMatch: ['a'] };",
      "const re = /x/\nmodule.exports = { testMatch: ['a'] };",
      "const re = /x/g\nmodule.exports = { testMatch: ['a'] };",
      "const t = `x`\nmodule.exports = { testMatch: ['a'] };",
      "const n = (1 + 2)\nmodule.exports = { testMatch: ['a'] };",
      "if (x) (setup())\nmodule.exports = { testMatch: ['a'] };",
      "obj.if(x)\nmodule.exports = { testMatch: ['a'] };",
      "if (x) { setup(); }\nmodule.exports = { testMatch: ['a'] };",
      "export const c = { testMatch: ['a'] };\nexport default c;",
    ])
      expect(exportedObject(text).entries.get("testMatch")).toEqual(["a"]);
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

  test("with roots alone, each root's rule claims only files under that root", () => {
    const reading = readJest(
      repo({
        "jest.config.js":
          "module.exports = { roots: ['<rootDir>/a', '<rootDir>/b'] };",
      }),
    );
    expect(runnerRuleFor(reading, "b/x.test.js")?.pattern).toBe("<rootDir>/b");
    expect(runnerRuleFor(reading, "a/x.test.js")?.pattern).toBe("<rootDir>/a");
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

  test("pytest.toml comes before every other source, even empty", () => {
    const tox = "[pytest]\npython_files = verify_*.py\n";
    const named = readPytest(
      repo({
        "pytest.toml": "[pytest]\npython_files = ['check_*.py']\n",
        "tox.ini": tox,
      }),
    );
    expect(named.rules[0]?.key).toBe("[pytest] python_files");
    expect(claimed(named, ["check_a.py", "verify_a.py"])).toEqual([
      "check_a.py",
    ]);
    const empty = readPytest(repo({ ".pytest.toml": "", "tox.ini": tox }));
    expect(empty).toEqual({ rules: [], unreadable: [] });
  });

  test("pyproject.toml's native [tool.pytest] table is read", () => {
    const reading = readPytest(
      repo({
        "pyproject.toml": "[tool.pytest]\npython_files = ['check_*.py']\n",
        "setup.cfg": "[tool:pytest]\npython_files = verify_*.py\n",
      }),
    );
    expect(reading.rules[0]?.key).toBe("[tool.pytest] python_files");
    expect(claimed(reading, ["check_a.py", "verify_a.py"])).toEqual([
      "check_a.py",
    ]);
  });

  test("a pyproject.toml setting both [tool.pytest] and its ini_options is unreadable", () => {
    const reading = readPytest(
      repo({
        "pyproject.toml":
          "[tool.pytest]\npython_files = ['a_*.py']\n[tool.pytest.ini_options]\npython_files = 'b_*.py'\n",
      }),
    );
    expect(reading.rules).toEqual([]);
    expect(whys(reading)[0]).toContain("both");
  });

  test("an empty [tool.pytest] is no configuration, and pytest looks on", () => {
    const reading = readPytest(
      repo({
        "pyproject.toml": "[tool.pytest]\n",
        "setup.cfg": "[tool:pytest]\npython_files = check_*.py\n",
      }),
    );
    expect(reading.rules[0]?.file).toBe("setup.cfg");
    expect(claimed(reading, ["check_a.py"])).toEqual(["check_a.py"]);
  });

  test("an empty ini_options beside a native table is no conflict, and stops the search", () => {
    const native = readPytest(
      repo({
        "pyproject.toml":
          "[tool.pytest]\npython_files = ['check_*.py']\n[tool.pytest.ini_options]\n",
      }),
    );
    expect(native.unreadable).toEqual([]);
    expect(claimed(native, ["check_a.py"])).toEqual(["check_a.py"]);
    const ini = readPytest(
      repo({
        "pyproject.toml": "[tool.pytest.ini_options]\n",
        "setup.cfg": "[tool:pytest]\npython_files = check_*.py\n",
      }),
    );
    expect(ini).toEqual({ rules: [], unreadable: [] });
  });

  test("the pytest table is found however the TOML spells its key", () => {
    for (const toml of [
      "tool.pytest = { python_files = ['check_*.py'] }\n",
      '["tool"."pytest"]\npython_files = ["check_*.py"]\n',
      "[tool]\npytest.python_files = ['check_*.py']\n",
      '[tool."py\\u0074est"]\npython_files = ["check_*.py"]\n',
    ]) {
      const reading = readPytest(
        repo({
          "pyproject.toml": toml,
          "setup.cfg": "[tool:pytest]\npython_files = verify_*.py\n",
        }),
      );
      expect(claimed(reading, ["check_a.py", "verify_a.py"])).toEqual([
        "check_a.py",
      ]);
    }
  });

  test("a native table's setting must be a list; ini_options also takes a string", () => {
    for (const texts of [
      { "pytest.toml": "[pytest]\npython_files = 'check_*.py'\n" },
      { "pyproject.toml": "[tool.pytest]\ntestpaths = 'qa'\n" },
    ]) {
      const reading = readPytest(repo(texts));
      expect(reading.rules).toEqual([]);
      expect(whys(reading)[0]).toContain("not a list");
    }
    const ini = readPytest(
      repo({
        "pyproject.toml":
          "[tool.pytest.ini_options]\npython_files = 'check_*.py'\n",
      }),
    );
    expect(claimed(ini, ["check_a.py"])).toEqual(["check_a.py"]);
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

  test("a reference in a value is read as the character it stands for", () => {
    const reading = readMaven(
      repo({
        "pom.xml": pom(
          "<build><testSourceDirectory>qa&amp;checks&#47;j&#x61;va</testSourceDirectory></build>",
        ),
      }),
    );
    expect(reading.unreadable).toEqual([]);
    expect(claimed(reading, ["qa&checks/java/C.java"])).toEqual([
      "qa&checks/java/C.java",
    ]);
  });

  test("an entity a DTD would declare, or a bare &, is unreadable", () => {
    for (const value of [
      "qa&dir;",
      "qa & checks",
      "qa&constructor;",
      "qa&toString;",
      "qa&__proto__;",
    ]) {
      const reading = readMaven(
        repo({
          "pom.xml": pom(
            `<build><testSourceDirectory>${value}</testSourceDirectory></build>`,
          ),
        }),
      );
      expect(reading.rules).toEqual([]);
      expect(whys(reading)).toHaveLength(1);
    }
  });

  test("a character reference XML forbids is unreadable, even outside the read element", () => {
    for (const ref of [
      "&#0;",
      "&#xD800;",
      "&#xFFFF;",
      "&#X61;",
      "&#x110000;",
    ]) {
      const reading = readMaven(
        repo({
          "pom.xml": pom(
            `<description>a${ref}</description><build><testSourceDirectory>qa</testSourceDirectory></build>`,
          ),
        }),
      );
      expect(reading.rules).toEqual([]);
      expect(whys(reading)).toHaveLength(1);
    }
    const allowed = readMaven(
      repo({
        "pom.xml": pom(
          "<description>&#9;&#xA;&#xd7ff;&#xE000;&#x10000;</description><build><testSourceDirectory>qa</testSourceDirectory></build>",
        ),
      }),
    );
    expect(allowed.unreadable).toEqual([]);
    expect(claimed(allowed, ["qa/Check.java"])).toEqual(["qa/Check.java"]);
  });

  test("a character or reference XML forbids anywhere in the POM is unreadable, in CDATA, a comment, an attribute value or around the root element", () => {
    const build =
      "<build><testSourceDirectory>qa</testSourceDirectory></build>";
    for (const text of [
      `<project bad="&#0;">${build}</project>`,
      `<project bad='a&dir;'>${build}</project>`,
      `<project><build a="x" b="&#xFFFF;"><testSourceDirectory>qa</testSourceDirectory></build></project>`,
      `<project>${build}</project>&#0;`,
      `<project>${build}</project>&dir;`,
      `&#0;<project>${build}</project>`,
      `<project><build><testSourceDirectory>qa\u0001</testSourceDirectory></build></project>`,
      `<project><build><testSourceDirectory><![CDATA[qa\u0001]]></testSourceDirectory></build></project>`,
      `<project><!-- \u0001 -->${build}</project>`,
      `<project bad="￿">${build}</project>`,
      `<project>${build}</project>\uD800`,
    ]) {
      const reading = readMaven(repo({ "pom.xml": text }));
      expect(reading.rules).toEqual([]);
      expect(whys(reading)).toHaveLength(1);
    }
    const allowed = readMaven(
      repo({
        "pom.xml": `<?xml version="1.0"?>\n<project a="x &amp; &#x3e; '" b='"'>${build}</project>\n`,
      }),
    );
    expect(allowed.unreadable).toEqual([]);
    expect(claimed(allowed, ["qa/Check.java"])).toEqual(["qa/Check.java"]);
  });

  test("a POM with an element still open at the end, or no element, is unreadable", () => {
    for (const text of [
      "<project><build><testSourceDirectory>qa</testSourceDirectory>",
      "<project><build>",
      "<?xml version='1.0'?>",
    ]) {
      const reading = readMaven(repo({ "pom.xml": text }));
      expect(reading.rules).toEqual([]);
      expect(whys(reading)).toHaveLength(1);
    }
  });
});
