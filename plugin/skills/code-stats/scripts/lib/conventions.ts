/**
 * The path conventions built-in detection reads, as data: each row names the
 * ecosystem it comes from, the rule as a person would write it, and the kind
 * it gives. The same rows classify a file, explain the classification
 * (`--explain`) and list the rules in the HTML report's help.
 */

export type ConventionKind = "test" | "fixture" | "generated" | "vendored";

export interface Convention {
  ecosystem: string;
  rule: string;
  kind: ConventionKind;
  matches: (path: string, filename: string) => boolean;
}

const folder =
  (pattern: RegExp) =>
  (path: string): boolean =>
    pattern.test(path);
const name =
  (pattern: RegExp) =>
  (_path: string, filename: string): boolean =>
    pattern.test(filename);

/**
 * Test conventions. A file one of them matches is a test when it is code;
 * otherwise it is a fixture, or docs when it is documentation, never test
 * lines of code.
 */
export const TEST_CONVENTIONS: readonly Convention[] = [
  {
    ecosystem: "JavaScript/TypeScript",
    rule: "*.test.* or *.spec.*",
    kind: "test",
    matches: name(/\.(test|spec)\.[a-z]+$/i),
  },
  {
    ecosystem: "JavaScript/TypeScript",
    rule: "__tests__/ folder",
    kind: "test",
    matches: folder(/(^|\/)__tests__\//),
  },
  {
    ecosystem: "Python",
    rule: "test_*.py or *_test.py",
    kind: "test",
    matches: name(/^test_.*\.py$|_test\.py$/),
  },
  {
    ecosystem: "Python",
    rule: "conftest.py",
    kind: "test",
    matches: name(/^conftest\.py$/),
  },
  {
    ecosystem: "Go",
    rule: "*_test.go",
    kind: "test",
    matches: name(/_test\.go$/),
  },
  {
    ecosystem: "Java/Kotlin",
    rule: "src/test/ or src/integrationTest/ folder",
    kind: "test",
    matches: folder(/(^|\/)src\/(test|integrationTest)\//),
  },
  {
    ecosystem: "Rust",
    rule: "benches/ folder",
    kind: "test",
    matches: folder(/(^|\/)benches\//),
  },
  {
    ecosystem: "Ruby",
    rule: "spec/ folder or *_spec.rb",
    kind: "test",
    matches: (path, filename) =>
      /(^|\/)spec\//.test(path) || /_spec\.rb$/.test(filename),
  },
  {
    ecosystem: "PHP",
    rule: "*Test.php",
    kind: "test",
    matches: name(/Test\.php$/),
  },
  {
    ecosystem: "C#",
    rule: "*.Tests/ folder",
    kind: "test",
    matches: folder(/(^|\/)[^/]+\.Tests\//),
  },
  {
    ecosystem: "Elixir",
    rule: "*_test.exs",
    kind: "test",
    matches: name(/_test\.exs$/),
  },
  {
    ecosystem: "Shell",
    rule: "*.bats",
    kind: "test",
    matches: name(/\.bats$/),
  },
  {
    ecosystem: "Python, Rust, JavaScript/TypeScript and others",
    rule: "tests/ or test/ folder",
    kind: "test",
    matches: folder(/(^|\/)tests?\//),
  },
];

/** Fixture conventions: data a test reads, whatever its extension. */
export const FIXTURE_CONVENTIONS: readonly Convention[] = [
  {
    ecosystem: "Go",
    rule: "testdata/ folder",
    kind: "fixture",
    matches: folder(/(^|\/)testdata\//),
  },
  {
    ecosystem: "Any",
    rule: "__fixtures__/, fixtures/ or test-fixtures/ folder",
    kind: "fixture",
    matches: folder(/(^|\/)(__fixtures__|fixtures|test-fixtures)\//),
  },
  {
    ecosystem: "JavaScript/TypeScript",
    rule: "__snapshots__/ or snapshots/ folder, or *.snap",
    kind: "fixture",
    matches: (path, filename) =>
      /(^|\/)(__snapshots__|snapshots)\//.test(path) ||
      filename.endsWith(".snap"),
  },
  {
    ecosystem: "Any",
    rule: "mocks/ or __mocks__/ folder",
    kind: "fixture",
    matches: folder(/(^|\/)(mocks|__mocks__)\//),
  },
];

/** Lockfiles, by the ecosystem whose package manager writes them. */
const LOCKFILES: readonly [string, readonly string[]][] = [
  [
    "JavaScript",
    [
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "deno.lock",
    ],
  ],
  ["Python", ["poetry.lock", "uv.lock", "Pipfile.lock", "pdm.lock"]],
  ["Go", ["go.sum"]],
  ["Rust", ["Cargo.lock"]],
  ["Ruby", ["Gemfile.lock"]],
  ["PHP", ["composer.lock"]],
  ["Java/Kotlin", ["gradle.lockfile"]],
  [".NET", ["packages.lock.json"]],
  ["Elixir", ["mix.lock"]],
  ["Swift", ["Package.resolved"]],
  ["Dart", ["pubspec.lock"]],
  ["Nix", ["flake.lock"]],
];

/** Generated-file conventions, checked by path; banners are a separate detector. */
export const GENERATED_CONVENTIONS: readonly Convention[] = [
  {
    ecosystem: "Any",
    rule: "generated/ or _generated/ folder",
    kind: "generated",
    matches: folder(/(^|\/)_?generated\//),
  },
  {
    ecosystem: "Any",
    rule: ".gen/ folder, *.generated.* or *.gen.*",
    kind: "generated",
    matches: (path, filename) =>
      /(^|\/)\.gen\//.test(path) ||
      /\.(generated|gen)(\.[a-z0-9]+)+$/i.test(filename),
  },
  {
    ecosystem: "Protocol Buffers",
    rule: "*.pb.*, *_pb.*, *_pb2.py or *_connect.* output",
    kind: "generated",
    matches: name(
      /\.pb\.(ts|js|go|py|cc|h)$|_pb\.(ts|js|go|py)$|_pb2(_grpc)?\.pyi?$|_connect\.(ts|js)$/i,
    ),
  },
  {
    ecosystem: "Drizzle",
    rule: "drizzle/meta/ snapshots",
    kind: "generated",
    matches: folder(/(^|\/)drizzle\/meta\//),
  },
  {
    ecosystem: "TypeScript",
    rule: "*.d.ts under a dist/ folder",
    kind: "generated",
    matches: (path, filename) =>
      filename.endsWith(".d.ts") && /(^|\/)dist\//.test(path),
  },
  ...LOCKFILES.map(
    ([ecosystem, names]): Convention => ({
      ecosystem,
      rule: `lockfile (${names.join(", ")})`,
      kind: "generated",
      matches: (_path, filename) => names.includes(filename),
    }),
  ),
];

/** Vendored-code conventions: another project's code kept in this one. */
export const VENDORED_CONVENTIONS: readonly Convention[] = [
  {
    ecosystem: "Any",
    rule: "vendor/ folder",
    kind: "vendored",
    matches: folder(/(^|\/)vendor\//),
  },
  {
    ecosystem: "Any",
    rule: "third_party/ or third-party/ folder",
    kind: "vendored",
    matches: folder(/(^|\/)third[_-]party\//),
  },
  {
    ecosystem: "JavaScript",
    rule: "node_modules/ folder",
    kind: "vendored",
    matches: folder(/(^|\/)node_modules\//),
  },
];

/** Every convention, in the order detection applies them. */
export const CONVENTIONS: readonly Convention[] = [
  ...VENDORED_CONVENTIONS,
  ...GENERATED_CONVENTIONS,
  ...FIXTURE_CONVENTIONS,
  ...TEST_CONVENTIONS,
];

/** The first convention of `list` that matches, or null. */
export function firstConvention(
  list: readonly Convention[],
  path: string,
  filename: string,
): Convention | null {
  return list.find((c) => c.matches(path, filename)) ?? null;
}

/** How `--explain` names a convention. */
export function describeConvention(c: Convention): string {
  return `convention: ${c.ecosystem} ${c.rule}`;
}
