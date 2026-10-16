import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../../../plugin/shared/guarded-git-spawn.ts";
import { testPaths } from "./check-tests-with-changes.ts";

const gate = join(import.meta.dir, "check-tests-with-changes.ts");
const fixtures = join(import.meta.dir, "fixtures");
const tree = join(fixtures, "tree");
// Creating a symbolic link needs extra privileges on Windows.
const posixOnly = test.skipIf(process.platform === "win32");

const LAYOUT = [
  "--source",
  "src/**/*.ts",
  "--test",
  "{dir}/{name}.test.{ext}",
  "--test",
  "{dir}/__tests__/{name}.test.{ext}",
];

/** The environment without anything that points git at another repository. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase())
    )
      env[key] = value;
  return {
    ...env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
}

function run(args: string[], options: { input?: string; cwd?: string } = {}) {
  const r = spawnSync(process.execPath, [gate, ...args], {
    cwd: options.cwd ?? import.meta.dir,
    env: cleanEnv(),
    input: options.input ?? "",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** List mode: the changed paths on standard input, tests looked up in the fixture tree. */
const listed = (changed: string[], extra: string[] = []) =>
  run(["--changed", "-", "--root", tree, ...LAYOUT, ...extra], {
    input: changed.join("\n"),
  });

describe("list mode", () => {
  test("sources with a test beside them or under __tests__ pass", () => {
    const r = listed([
      "src/orders.ts",
      "src/refunds.ts",
      "src/orders.test.ts",
      "docs/guide.md",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("4 changed path(s) checked");
  });

  test("a source without a test fails and names where it looked", () => {
    const r = listed(["src/orders.ts", "src/invoices.ts"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("src/invoices.ts");
    expect(r.err).toContain(
      "src/invoices.test.ts, src/__tests__/invoices.test.ts",
    );
    expect(r.err).not.toContain("src/orders.ts (");
  });

  test("a registered exemption with a reason passes the file", () => {
    expect(listed(["src/generated/schema.ts"]).code).toBe(1);
    expect(
      listed(
        ["src/generated/schema.ts"],
        ["--exemptions", join(fixtures, "exemptions.txt")],
      ).code,
    ).toBe(0);
  });

  test("an exemption without a reason is a usage error, not a pass", () => {
    const r = listed(
      ["src/generated/schema.ts"],
      ["--exemptions", join(fixtures, "exemptions-without-reason.txt")],
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain("needs a reason");
  });

  test("--require-changed wants the test in the same change", () => {
    const flag = ["--require-changed"];
    expect(listed(["src/orders.ts"], flag).code).toBe(1);
    expect(listed(["src/orders.ts", "src/orders.test.ts"], flag).code).toBe(0);
  });

  test("a dotted name the templates cannot make is a source, not a test", () => {
    const r = listed(["src/orders.test.helpers.ts"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("src/orders.test.helpers.ts (");
  });

  /** List mode over a scratch tree with a regular src/orders.test.ts. */
  function scratch(build: (src: string) => void, changed: string) {
    const root = mkdtempSync(join(tmpdir(), "tests-with-changes-list-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "orders.test.ts"), "// covers orders\n");
      build(join(root, "src"));
      return run(["--changed", "-", "--root", root, ...LAYOUT], {
        input: `src/orders.ts\n${changed}`,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  /** List mode over a scratch tree holding exactly the given test files. */
  function withTests(tests: string[], changed: string) {
    const root = mkdtempSync(join(tmpdir(), "tests-with-changes-list-"));
    try {
      for (const path of tests) {
        mkdirSync(join(root, dirname(path)), { recursive: true });
        writeFileSync(join(root, path), "// a test\n");
      }
      return run(["--changed", "-", "--root", root, ...LAYOUT], {
        input: changed,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("a placeholder-like name needs its own test, not the expanded one", () => {
    expect(withTests(["src/ts.test.ts"], "src/{ext}.ts").code).toBe(1);
    expect(withTests(["src/{ext}.test.ts"], "src/{ext}.ts").code).toBe(0);
  });

  test("a placeholder-like directory needs its own test, not the expanded one", () => {
    const source = "src/{name}/orders.ts";
    expect(withTests(["src/orders/orders.test.ts"], source).code).toBe(1);
    expect(withTests(["src/{name}/orders.test.ts"], source).code).toBe(0);
  });

  test("a directory at the test path is not the test", () => {
    const r = scratch(
      (src) => mkdirSync(join(src, "payments.test.ts")),
      "src/payments.ts",
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("1 changed source file(s)");
    expect(r.err).toContain("src/payments.ts (");
  });

  posixOnly("a link at the test path is not the test", () => {
    const r = scratch(
      (src) => symlinkSync("orders.test.ts", join(src, "refunds.test.ts")),
      "src/refunds.ts",
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("1 changed source file(s)");
    expect(r.err).toContain("src/refunds.ts (");
  });

  posixOnly("a test under a linked directory is not the test", () => {
    const r = scratch((src) => {
      mkdirSync(join(src, "..", "elsewhere"));
      writeFileSync(
        join(src, "..", "elsewhere", "refunds.test.ts"),
        "// covers refunds\n",
      );
      symlinkSync(join("..", "elsewhere"), join(src, "__tests__"));
    }, "src/refunds.ts");
    expect(r.code).toBe(1);
    expect(r.err).toContain("1 changed source file(s)");
    expect(r.err).toContain("src/refunds.ts (");
  });
});

describe("usage", () => {
  test.each([
    ["no source glob", ["--changed", "-", "--test", "{dir}/{name}.test.{ext}"]],
    ["no test template", ["--changed", "-", "--source", "src/**"]],
    ["neither --base nor --changed", LAYOUT],
    [
      "both --base and --changed",
      ["--base", "main", "--changed", "-", ...LAYOUT],
    ],
    ["an unknown option", ["--changed", "-", "--sources", "src/**", ...LAYOUT]],
    [
      "an empty source glob",
      ["--changed", "-", "--source", "", "--test", "{dir}/{name}.test.{ext}"],
    ],
    [
      "a blank test template",
      ["--changed", "-", "--source", "src/**", "--test", " "],
    ],
  ])("%s exits 2", (_name, args) => {
    expect(run(args).code).toBe(2);
  });
});

describe("test paths from a template", () => {
  test("a file at the root has no directory prefix", () => {
    expect(testPaths("orders.ts", ["{dir}/{name}.test.{ext}"])).toEqual([
      "orders.test.ts",
    ]);
  });

  test("a mirrored test tree, as Python layouts use", () => {
    expect(
      testPaths("app/billing/orders.py", ["tests/{dir}/test_{name}.py"]),
    ).toEqual(["tests/app/billing/test_orders.py"]);
  });

  test("{dir:FROM=TO} swaps a leading directory, as JVM layouts need", () => {
    const java = ["{dir:src/main/java=src/test/java}/{name}Test.java"];
    expect(testPaths("src/main/java/shop/Orders.java", java)).toEqual([
      "src/test/java/shop/OrdersTest.java",
    ]);
    // A source outside FROM gets no test path from that template.
    expect(testPaths("tools/Build.java", java)).toEqual([]);
  });

  test("a template using {ext} names no test for a file without an extension", () => {
    expect(
      testPaths("bin/release", [
        "{dir}/{name}.test.{ext}",
        "{dir}/{name}_test",
      ]),
    ).toEqual(["bin/release_test"]);
  });

  test("{dir:FROM=TO} with an empty side is a usage error", () => {
    expect(() => testPaths("src/a.ts", ["{dir:=tests}/{name}.ts"])).toThrow(
      "needs both FROM and TO",
    );
    const r = run(
      [
        "--changed",
        "-",
        "--source",
        "src/**",
        "--test",
        "{dir:src=}/{name}.ts",
      ],
      { input: "src/a.ts" },
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain("needs both FROM and TO");
  });

  test("a repeated placeholder stands for the same text in a test's shape", () => {
    const nested = (input: string) =>
      run(
        [
          "--changed",
          "-",
          "--source",
          "src/**/*.ts",
          "--test",
          "{dir}/{name}/{name}.test.{ext}",
        ],
        { input },
      );
    // No source can produce this path: the directory and file name differ.
    const r = nested("src/orders/helpers.test.ts");
    expect(r.code).toBe(1);
    expect(r.err).toContain("src/orders/helpers.test.ts (");
    expect(nested("src/orders/orders.test.ts").code).toBe(0);
  });

  test("a second {dir} placeholder is a usage error", () => {
    expect(() => testPaths("src/a.ts", ["{dir}/{dir}/{name}.ts"])).toThrow(
      "at most one {dir}",
    );
    const r = run(
      [
        "--changed",
        "-",
        "--source",
        "src/**",
        "--test",
        "{dir}/x/{dir:src=tests}/{name}.ts",
      ],
      { input: "src/a.ts" },
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain("at most one {dir}");
  });

  test("a name or extension is inserted literally, and its test is recognised", () => {
    const nested = ["{dir}/{name}/{name}.test.{ext}"];
    expect(testPaths("src/$$orders.ts", nested)).toEqual([
      "src/$$orders/$$orders.test.ts",
    ]);
    expect(testPaths("src/$&.ts", ["{dir}/{name}.test.{ext}"])).toEqual([
      "src/$&.test.ts",
    ]);
    expect(testPaths("src/a.$'", ["{dir}/{name}.test.{ext}"])).toEqual([
      "src/a.test.$'",
    ]);
    const r = run(
      ["--changed", "-", "--source", "src/**/*.ts", "--test", nested[0] ?? ""],
      { input: "src/$$orders/$$orders.test.ts" },
    );
    expect(r.code).toBe(0);
  });

  test("a name or directory that looks like a placeholder is inserted as written", () => {
    const template = ["{dir}/{name}.test.{ext}"];
    expect(testPaths("src/{ext}.ts", template)).toEqual(["src/{ext}.test.ts"]);
    expect(testPaths("src/{name}/orders.ts", template)).toEqual([
      "src/{name}/orders.test.ts",
    ]);
    expect(testPaths("src/{dir}.ts", template)).toEqual(["src/{dir}.test.ts"]);
  });

  test("a template not in normal form is a usage error", () => {
    for (const template of [
      "./{dir}/{name}.test.{ext}",
      "{dir}//{name}.test.{ext}",
      "{dir}/../tests/{name}.test.{ext}",
      "/tests/{dir}/{name}.test.{ext}",
      "{dir}/{name}.test.{ext}/",
      "tests/{dir}",
      "{dir:./src=tests}/{name}.ts",
      "{dir:src=tests/}/{name}.ts",
    ])
      expect(() => testPaths("src/a.ts", [template])).toThrow(
        "not in normal form",
      );
    const r = run(
      [
        "--changed",
        "-",
        "--source",
        "src/**/*.ts",
        "--test",
        "./{dir}/{name}.test.{ext}",
      ],
      { input: "src/orders.ts\nsrc/orders.test.ts" },
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain("not in normal form");
  });

  test("a changed test in a swapped tree is a test, not a source", () => {
    const r = run(
      [
        "--changed",
        "-",
        "--root",
        tree,
        "--source",
        "src/**/*.java",
        "--test",
        "{dir:src/main/java=src/test/java}/{name}Test.java",
      ],
      {
        input:
          "src/test/java/shop/OrdersTest.java\nsrc/main/java/shop/Orders.java",
      },
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("1 changed source file(s)");
    expect(r.err).toContain("src/main/java/shop/Orders.java");
  });
});

describe("git mode", () => {
  const repos: string[] = [];
  afterAll(() => {
    for (const r of repos) rmSync(r, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]) {
    const r = spawnSync("git", args, { cwd, env: cleanEnv() });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }

  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), "tests-with-changes-"));
    repos.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "commit", "-q", "--allow-empty", "-m", "base");
    git(root, "checkout", "-q", "-b", "change");
    return root;
  }

  function commit(root: string, files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "change");
  }

  test("reads the change since the merge base and the tests in HEAD", () => {
    const root = repo();
    commit(root, { "src/orders.ts": "export {};\n" });
    expect(run(["--base", "main", ...LAYOUT], { cwd: root }).code).toBe(1);
    commit(root, { "src/orders.test.ts": "// covers orders\n" });
    expect(run(["--base", "main", ...LAYOUT], { cwd: root }).code).toBe(0);
  });

  test("run from a subdirectory, it still finds the tests in HEAD", () => {
    const root = repo();
    commit(root, {
      "src/orders.ts": "export {};\n",
      "src/orders.test.ts": "// covers orders\n",
    });
    const r = run(["--base", "main", ...LAYOUT], { cwd: join(root, "src") });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  });

  posixOnly(
    "a link replaced by a source file is a change that needs a test",
    () => {
      const root = mkdtempSync(join(tmpdir(), "tests-with-changes-"));
      repos.push(root);
      git(root, "init", "-q", "-b", "main");
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "real.ts"), "export {};\n");
      writeFileSync(join(root, "src", "real.test.ts"), "// covers real\n");
      symlinkSync("real.ts", join(root, "src", "orders.ts"));
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "base");
      git(root, "checkout", "-q", "-b", "change");
      rmSync(join(root, "src", "orders.ts"));
      commit(root, { "src/orders.ts": "export const total = 1;\n" });
      const r = run(["--base", "main", ...LAYOUT], { cwd: root });
      expect(r.code).toBe(1);
      expect(r.err).toContain("src/orders.ts (");
    },
  );

  posixOnly("a link at the test path is not the test", () => {
    const root = repo();
    commit(root, {
      "src/orders.ts": "export {};\n",
      "src/other.test.ts": "// covers other\n",
    });
    symlinkSync("other.test.ts", join(root, "src", "orders.test.ts"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "link");
    expect(run(["--base", "main", ...LAYOUT], { cwd: root }).code).toBe(1);
  });

  posixOnly("a test under a linked directory is not the test", () => {
    const root = repo();
    commit(root, {
      "src/refunds.ts": "export {};\n",
      "elsewhere/refunds.test.ts": "// covers refunds\n",
    });
    symlinkSync(join("..", "elsewhere"), join(root, "src", "__tests__"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "link");
    expect(run(["--base", "main", ...LAYOUT], { cwd: root }).code).toBe(1);
  });

  test("a base git cannot resolve fails closed", () => {
    const root = repo();
    const r = run(["--base", "no-such-ref", ...LAYOUT], { cwd: root });
    expect(r.code).toBe(2);
    expect(r.err).toContain("git diff");
  });
});
