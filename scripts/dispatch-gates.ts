import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parseSync } from "oxc-parser";
import { readConfigFile, valueAt } from "../plugin/shared/config-layers.ts";
import { launchOf } from "../plugin/shared/launched-session.ts";
import { LAUNCH_RECORD_ID_PATTERN } from "../plugin/shared/records/forge-claim-shapes.ts";

const { basename, dirname, extname, normalize } = posix;
const dispatchLaunchId = new RegExp(LAUNCH_RECORD_ID_PATTERN);
const testSuffix = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** What a session of the line carries and a test must not read as its own. */
const lineVariable = /^(?:JIG_LAUNCH$|DRIVE_PR_)/;
const moduleSuffixes = [".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts"];
const literalPath = /^(["'`])(\.{1,2}\/[^"'`$]*)\1$/;

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
    dispatchLaunchId.test(launchOf(env) ?? "")
  );
}

export function useDispatchFastGates(
  root: string,
  env: Record<string, string | undefined>,
): boolean {
  if (!dispatchFastEnabled(true, env)) return false;
  const config = readConfigFile(join(root, ".config/jig.yaml"));
  return dispatchFastEnabled(valueAt(config ?? {}, "gates.dispatch_fast"), env);
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
    .sort();
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
    tests: ordered.slice(0, limit).sort(),
    leftToCi: Math.max(0, ordered.length - limit),
  };
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
  const { staticImports, dynamicImports } = parseSync(test, code).module;
  return [
    ...staticImports.map(({ moduleRequest }) => moduleRequest.value),
    ...dynamicImports.flatMap(({ moduleRequest: { start, end } }) => {
      const path = literalPath.exec(code.slice(start, end))?.[2];
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
  return selectDispatchTests(
    changed,
    files.filter(
      (path) =>
        existsSync(join(root, path)) &&
        (websiteInstalled || !path.startsWith("website/")),
    ),
    (test) => testImports(root, test),
  );
}
