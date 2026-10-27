/**
 * The test-runner layer end to end: each fixture repository's tests are
 * named only by its test runner's configuration, and the CLI classifies
 * them with no `code_stats` section; a computed configuration is reported
 * unreadable and claims nothing.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { repository, runCli } from "./helpers.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "test-runners");

/** A committed repository holding the fixture `name`, plus `extra` files. */
function fixture(name: string, extra: Record<string, string> = {}): string {
  const dir = join(FIXTURES, name);
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true })) {
    const path = String(entry).split("\\").join("/");
    if (statSync(join(dir, path)).isFile())
      files[path] = readFileSync(join(dir, path), "utf8");
  }
  return repository({ ...files, ...extra });
}

interface Explained {
  kind: { value: string; rule: string };
  testRunnersUnreadable: { reader: string; path: string; why: string }[];
}

function explain(root: string, path: string): Explained {
  const run = runCli(root, ["--explain", path, "--json"]);
  expectSpawnExit(run, 0);
  return JSON.parse(run.stdout) as Explained;
}

interface Report {
  byKind: Record<string, { files: number }>;
  testRunners: {
    configurations: { reader: string; file: string }[];
    unreadable: { reader: string; path: string; why: string }[];
  };
}

function report(root: string): Report {
  const run = runCli(root, ["--json"]);
  expectSpawnExit(run, 0);
  return JSON.parse(run.stdout) as Report;
}

/** Each fixture: the files its runner names as tests, and files it does not. */
const CASES: {
  name: string;
  tests: Record<string, string>;
  code: string[];
}[] = [
  {
    name: "jest",
    tests: {
      "src/cart.check.js":
        'test runner jest: jest.config.js testMatch "**/*.check.js"',
      "packages/api/specs/orders.js":
        'test runner jest: packages/api/package.json testRegex "/specs/.*\\\\.js$"',
    },
    code: ["src/cart.js", "src/slow/load.check.js", "lib/stock.check.js"],
  },
  {
    name: "vitest",
    tests: {
      "src/cart.check.ts":
        'test runner vitest: vitest.config.ts test.include "src/**/*.check.ts"',
      "web/app.verify.tsx":
        'test runner vitest: web/vite.config.ts test.include "**/*.verify.tsx"',
    },
    code: ["src/cart.ts", "src/legacy/old.check.ts", "web/app.tsx"],
  },
  {
    name: "pytest",
    tests: {
      "checks/check_orders.py":
        'test runner pytest: pyproject.toml [tool.pytest.ini_options] testpaths and python_files "checks (check_*.py)"',
      "legacy/verify/orders_verify.py":
        'test runner pytest: legacy/setup.cfg [tool:pytest] testpaths and python_files "verify (*_verify.py)"',
    },
    code: [
      "checks/helpers.py",
      "app/check_config.py",
      "legacy/verify/support.py",
    ],
  },
  {
    name: "gradle",
    tests: {
      "qa/java/shop/OrderCheck.java":
        'test runner Gradle: build.gradle sourceSets.test.java.srcDirs "qa/java"',
      "app/checks/shop/CartCheck.kt":
        'test runner Gradle: app/build.gradle.kts sourceSets.test.kotlin.srcDir "checks"',
      "app/src/test/kotlin/shop/CartSuite.kt":
        'test runner Gradle: app/build.gradle.kts the src/test/kotlin convention "src/test/kotlin"',
    },
    code: [
      "src/main/java/shop/Order.java",
      "qa/resources/shop/Seed.java",
      "computed/qa/shop/StockCheck.java",
    ],
  },
  {
    name: "maven",
    tests: {
      "qa/shop/OrderCheck.java": `test runner Maven: pom.xml testSourceDirectory "\${project.basedir}/qa"`,
      "lib/src/test/java/shop/LibSuite.java":
        'test runner Maven: lib/pom.xml the src/test/java default "src/test/java"',
    },
    code: [
      "src/main/java/shop/Order.java",
      "props/checks/shop/PropsCheck.java",
    ],
  },
];

describe("a repository whose tests only its test runner names", () => {
  for (const c of CASES)
    describe(c.name, () => {
      const root = fixture(c.name);

      test("--explain names the reader, the file and the key behind each test", () => {
        for (const [path, rule] of Object.entries(c.tests))
          expect(explain(root, path).kind).toEqual({ value: "test", rule });
      });

      test("files the configuration does not name keep their built-in kind", () => {
        for (const path of c.code)
          expect(explain(root, path).kind.value).toBe("code");
      });

      test("--json counts them as tests and lists the configuration read", () => {
        const json = report(root);
        expect(json.byKind.test?.files).toBe(Object.keys(c.tests).length);
        expect(json.testRunners.configurations.length).toBeGreaterThan(0);
      });
    });
});

describe("a configuration computed when it runs", () => {
  const root = fixture("computed");

  test("is reported unreadable with its reason, in every output", () => {
    const json = report(root);
    expect(json.testRunners.configurations).toEqual([]);
    expect(json.testRunners.unreadable).toEqual([
      {
        reader: "jest",
        path: "base/jest.config.js",
        why: "testMatch may come from a spread or computed key",
      },
      {
        reader: "jest",
        path: "jest.config.js",
        why: "exports a function, so its configuration exists only when it runs",
      },
      {
        reader: "vitest",
        path: "web/vitest.config.ts",
        why: "passes a function to defineConfig, so its configuration exists only when it runs",
      },
    ]);
    const terminal = runCli(root, []);
    expectSpawnExit(terminal, 0);
    expect(terminal.stdout).toContain(
      "Test runner jest: unreadable: jest.config.js (exports a function",
    );
    const text = runCli(root, ["--explain", "src/cart.check.js"]);
    expectSpawnExit(text, 0);
    expect(text.stdout).toContain(
      "Test runner vitest: unreadable: web/vitest.config.ts (passes a function",
    );
  });

  test("claims nothing: the files it would name keep their built-in kind", () => {
    for (const path of [
      "src/cart.check.js",
      "base/stock.check.js",
      "web/app.verify.ts",
    ])
      expect(explain(root, path).kind.value).toBe("code");
    expect(report(root).byKind.test).toBeUndefined();
  });
});

describe("the layer's precedence", () => {
  test("code_stats.kinds overrides a runner's rule", () => {
    const root = fixture("jest", {
      ".config/jig.yaml":
        'code_stats:\n  kinds:\n    code: ["src/cart.check.js"]\n',
    });
    expect(explain(root, "src/cart.check.js").kind).toEqual({
      value: "code",
      rule: 'code_stats.kinds.code glob "src/cart.check.js"',
    });
  });

  test("the classify command overrides both", () => {
    const root = fixture("jest", {
      ".config/jig.yaml": `code_stats:\n  kinds:\n    code: ["src/**"]\n  classify_command: ${JSON.stringify(`"${process.execPath}" classify.ts`)}\n`,
      "classify.ts":
        'const lines = (await Bun.stdin.text()).split("\\n").filter(Boolean);\nfor (const p of lines) if (p.endsWith(".check.js")) console.log(JSON.stringify({ path: p, kind: "docs" }));\n',
    });
    expect(explain(root, "src/cart.check.js").kind).toEqual({
      value: "docs",
      rule: "classify_command",
    });
  });
});
