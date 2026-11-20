import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parseSync } from "oxc-parser";
import { loadLayeredConfig, valueAt } from "../plugin/shared/config-layers.ts";
import { dispatchedFrom } from "../plugin/shared/launched-session.ts";

const { basename, dirname, extname, normalize } = posix;
const testSuffix = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** What a session of the line carries and a test must not read as its own. */
const lineVariable = /^(?:JIG_LAUNCH$|JIG_DISPATCHED_FROM$|DRIVE_PR_)/;
const moduleExtensions = [".ts", ".tsx", ".mts", ".js", ".mjs"];
const moduleSuffixes = [
  ...moduleExtensions,
  ...moduleExtensions.map((extension) => `/index${extension}`),
];

/** A string, or a template without an interpolation: one fixed specifier. */
function literalSpecifier(source: string): string | undefined {
  const { program } = parseSync("specifier.ts", `(${source});`);
  const statement = program.body[0];
  if (statement?.type !== "ExpressionStatement") return undefined;
  const expression =
    statement.expression.type === "ParenthesizedExpression"
      ? statement.expression.expression
      : statement.expression;
  if (expression.type === "Literal")
    return typeof expression.value === "string" ? expression.value : undefined;
  if (
    expression.type === "TemplateLiteral" &&
    expression.expressions.length === 0
  )
    return expression.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

/**
 * How many test files a targeted run takes. A file run alone takes seconds, so
 * this keeps a run outside the lock to minutes when a change reaches a widely
 * used module.
 */
export const DISPATCH_TEST_LIMIT = 40;

/** The tests a targeted run takes, and how many it leaves to CI. */
export interface DispatchTests {
  tests: string[];
  leftToCi: number;
}

export function dispatchFastEnabled(
  setting: unknown,
  env: Record<string, string | undefined>,
): boolean {
  return (
    setting === true &&
    env.CI !== "1" &&
    env.CI !== "true" &&
    dispatchedFrom(env) !== null
  );
}

export function useDispatchFastGates(
  root: string,
  env: Record<string, string | undefined>,
): boolean {
  if (!dispatchFastEnabled(true, env)) return false;
  const { values } = loadLayeredConfig(root, env);
  return dispatchFastEnabled(valueAt(values, "gates.dispatch_fast"), env);
}

/** The targeted tests' environment: outside the lock, as nobody's session. */
export function dispatchTestEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([name]) => !lineVariable.test(name)),
    ),
    RESOURCE_LOCK_BYPASS: "1",
  };
}

class DispatchTestPathsError extends Error {}

function gitPaths(root: string, args: string[]): string[] {
  const child = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
  if (child.exitCode !== 0)
    throw new DispatchTestPathsError(
      `git ${args.join(" ")}: ${child.stderr.toString().trim()}`,
    );
  return child.stdout.toString().split("\0").filter(Boolean);
}

function isRelatedTest(test: string, source: string): boolean {
  const testDir = dirname(test);
  const sourceDir = dirname(source);
  const scope = basename(testDir) === "__tests__" ? dirname(testDir) : testDir;
  if (scope !== sourceDir && !sourceDir.startsWith(`${scope}/`)) return false;
  const stem = basename(source, extname(source));
  const testStem = basename(test).replace(testSuffix, "");
  return testStem === stem || testStem.startsWith(`${stem}-`);
}

export function selectDispatchTests(
  changed: string[],
  files: string[],
  importsFor: (test: string) => string[],
  limit = DISPATCH_TEST_LIMIT,
): DispatchTests {
  const touched = new Set(changed);
  const sources = changed.filter((path) => !testSuffix.test(path));
  const candidates = [...new Set(files)]
    .filter(
      (path) =>
        testSuffix.test(path) &&
        !/(^|\/)(fixtures?|\.context|dist|seeds)\//.test(path),
    )
    .sort(byPath);
  const changedTests = candidates.filter((path) => touched.has(path));
  const nearby = candidates.filter(
    (path) =>
      !touched.has(path) &&
      sources.some((source) => isRelatedTest(path, source)),
  );
  const named = new Set([...changedTests, ...nearby]);
  const importers = candidates.filter(
    (path) =>
      !named.has(path) &&
      importsFor(path).some((source) => touched.has(source)),
  );
  const ordered = [...changedTests, ...nearby, ...importers];
  return {
    tests: ordered.slice(0, limit).sort(byPath),
    leftToCi: Math.max(0, ordered.length - limit),
  };
}

/** Code-point order, so a selection never depends on the host's locale. */
function byPath(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The files a relative import may name: as written, or as it resolves. */
function importedFiles(test: string, specifier: string): string[] {
  const path = normalize(`${dirname(test)}/${specifier}`);
  return [
    path,
    path.replace(/\.[cm]?js$/, ".ts"),
    ...moduleSuffixes.map((suffix) => `${path}${suffix}`),
  ];
}

function testImports(root: string, test: string): string[] {
  const code = readFileSync(join(root, test), "utf8");
  const { errors, module } = parseSync(test, code);
  // A file the parser cannot read would otherwise look like one importing
  // nothing, and drop out of the run unnoticed.
  if (errors.length)
    throw new DispatchTestPathsError(
      `${test}: cannot read its imports: ${errors[0]?.message}`,
    );
  const { staticImports, dynamicImports } = module;
  return [
    ...staticImports.map(({ moduleRequest }) => moduleRequest.value),
    ...dynamicImports.flatMap(({ moduleRequest: { start, end } }) => {
      const path = literalSpecifier(code.slice(start, end));
      return path === undefined ? [] : [path];
    }),
  ]
    .filter((path) => path.startsWith("./") || path.startsWith("../"))
    .flatMap((path) => importedFiles(test, path));
}

export function dispatchTestPaths(root: string): DispatchTests {
  const untracked = gitPaths(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const changed = [
    ...gitPaths(root, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      "origin/main...HEAD",
      "--",
    ]),
    ...gitPaths(root, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      "HEAD",
      "--",
    ]),
    ...untracked,
  ];
  const files = [...gitPaths(root, ["ls-files", "-z"]), ...untracked];
  // The website's tests need its own dependencies, which CI's website job
  // installs and a dispatched worktree usually lacks.
  const websiteInstalled = existsSync(join(root, "website/node_modules"));
  const present = files.filter((path) => existsSync(join(root, path)));
  const importsFor = (test: string) => testImports(root, test);
  const selection = selectDispatchTests(
    changed,
    present.filter((path) => websiteInstalled || !path.startsWith("website/")),
    importsFor,
  );
  if (websiteInstalled) return selection;
  // The tests left out for want of dependencies are CI's, and counted so.
  const excluded = selectDispatchTests(
    changed,
    present.filter((path) => path.startsWith("website/")),
    importsFor,
    Number.POSITIVE_INFINITY,
  );
  return {
    tests: selection.tests,
    leftToCi: selection.leftToCi + excluded.tests.length,
  };
}
