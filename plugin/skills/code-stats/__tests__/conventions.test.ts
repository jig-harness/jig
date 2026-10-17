/** The built-in convention table: one case per ecosystem rule. */
import { describe, expect, test } from "bun:test";
import { CONVENTIONS } from "../scripts/lib/conventions.ts";
import { classified } from "./helpers.ts";

const TEST_CASES = [
  [
    "JavaScript/TypeScript",
    "*.test.* or *.spec.*",
    "apps/web/src/cart.test.ts",
  ],
  [
    "JavaScript/TypeScript",
    "*.test.* or *.spec.*",
    "apps/web/src/cart.spec.tsx",
  ],
  [
    "JavaScript/TypeScript",
    "__tests__/ folder",
    "packages/core/src/__tests__/sum.ts",
  ],
  ["Python", "test_*.py or *_test.py", "services/api/app/test_orders.py"],
  ["Python", "test_*.py or *_test.py", "services/api/app/orders_test.py"],
  ["Python", "conftest.py", "services/api/conftest.py"],
  ["Go", "*_test.go", "internal/store/store_test.go"],
  [
    "Java/Kotlin",
    "src/test/ or src/integrationTest/ folder",
    "services/billing/src/test/java/BillTest.java",
  ],
  [
    "Java/Kotlin",
    "src/test/ or src/integrationTest/ folder",
    "services/billing/src/integrationTest/kotlin/Flow.kt",
  ],
  ["Rust", "benches/ folder", "crates/core/benches/parse.rs"],
  ["Ruby", "spec/ folder or *_spec.rb", "spec/models/user.rb"],
  ["Ruby", "spec/ folder or *_spec.rb", "lib/orders/order_spec.rb"],
  ["PHP", "*Test.php", "src/Billing/InvoiceTest.php"],
  ["C#", "*.Tests/ folder", "src/Api.Tests/OrderControllerSpecs.cs"],
  ["Elixir", "*_test.exs", "lib/shop/cart_test.exs"],
  ["Shell", "*.bats", "scripts/install.bats"],
  [
    "Python, Rust, JavaScript/TypeScript and others",
    "tests/ or test/ folder",
    "crates/core/tests/round_trip.rs",
  ],
  [
    "Python, Rust, JavaScript/TypeScript and others",
    "tests/ or test/ folder",
    "services/api/tests/orders.py",
  ],
] as const;

describe("test conventions", () => {
  test.each(TEST_CASES)("%s %s: %s is a test", (ecosystem, rule, path) => {
    expect(classified(path).kind).toEqual({
      value: "test",
      rule: `convention: ${ecosystem} ${rule}`,
    });
  });

  test("a file in a test folder that is not code is a fixture, or docs", () => {
    expect(classified("crates/core/tests/data/input.json").kind.value).toBe(
      "fixture",
    );
    expect(classified("services/api/tests/README.md").kind.value).toBe("docs");
    expect(classified("spec/fixtures.yml").kind.rule).toContain(
      "a file that is not code is a fixture",
    );
  });
});

describe("fixture conventions", () => {
  test.each([
    ["Go", "testdata/ folder", "internal/parse/testdata/sample.go"],
    [
      "Any",
      "__fixtures__/, fixtures/ or test-fixtures/ folder",
      "apps/web/src/__fixtures__/user.ts",
    ],
    [
      "JavaScript/TypeScript",
      "__snapshots__/ or snapshots/ folder, or *.snap",
      "apps/web/src/cart.test.ts.snap",
    ],
    ["Any", "mocks/ or __mocks__/ folder", "apps/web/src/__mocks__/api.ts"],
  ] as const)("%s %s: %s is a fixture", (ecosystem, rule, path) => {
    expect(classified(path).kind).toEqual({
      value: "fixture",
      rule: `convention: ${ecosystem} ${rule}`,
    });
  });

  test("Go testdata is a fixture even where it holds test-shaped names", () => {
    expect(classified("internal/parse/testdata/case_test.go").kind.value).toBe(
      "fixture",
    );
  });
});

describe("the table", () => {
  test("every row is reached by some path", () => {
    const reached = new Set(
      [
        ...TEST_CASES.map(([, , p]) => p),
        "internal/parse/testdata/a.txt",
        "a/fixtures/b.json",
        "a/b.snap",
        "a/mocks/b.ts",
        "a/generated/b.ts",
        "a/b.gen.ts",
        "a/b_pb2.py",
        "packages/db/drizzle/meta/_journal.json",
        "packages/x/dist/index.d.ts",
        "vendor/a.go",
        "third_party/a.c",
        "node_modules/a/index.js",
        "bun.lock",
        "poetry.lock",
        "go.sum",
        "Cargo.lock",
        "Gemfile.lock",
        "composer.lock",
        "gradle.lockfile",
        "packages.lock.json",
        "mix.lock",
        "Package.resolved",
        "pubspec.lock",
        "flake.lock",
      ].flatMap((path) => {
        const filename = path.split("/").pop() ?? "";
        const row = CONVENTIONS.find((c) => c.matches(path, filename));
        return row ? [`${row.ecosystem} ${row.rule}`] : [];
      }),
    );
    expect(CONVENTIONS.map((c) => `${c.ecosystem} ${c.rule}`)).toEqual(
      CONVENTIONS.map((c) => `${c.ecosystem} ${c.rule}`).filter((r) =>
        reached.has(r),
      ),
    );
  });
});
