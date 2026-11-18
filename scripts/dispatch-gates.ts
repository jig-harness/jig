import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parseSync } from "oxc-parser";
import { readConfigFile, valueAt } from "../plugin/shared/config-layers.ts";
import { launchOf } from "../plugin/shared/launched-session.ts";
import { LAUNCH_RECORD_ID_PATTERN } from "../plugin/shared/records/forge-claim-shapes.ts";

const { basename, dirname, extname, normalize } = posix;
const dispatchLaunchId = new RegExp(LAUNCH_RECORD_ID_PATTERN);
const testSuffix = /\.(test|spec)\.[cm]?[jt]sx?$/;

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

export function useDispatchFastGates(root: string): boolean {
  if (!dispatchFastEnabled(true, process.env)) return false;
  const config = readConfigFile(join(root, ".config/jig.yaml"));
  return dispatchFastEnabled(
    valueAt(config ?? {}, "gates.dispatch_fast"),
    process.env,
  );
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
): string[] {
  const touched = new Set(changed);
  const sources = changed.filter((path) => !testSuffix.test(path));
  return [...new Set(files)]
    .filter(
      (path) =>
        testSuffix.test(path) &&
        !/(^|\/)(fixtures?|\.context|dist|seeds)\//.test(path) &&
        (touched.has(path) ||
          sources.some((source) => isRelatedTest(path, source)) ||
          importsFor(path).some((source) => touched.has(source))),
    )
    .sort();
}

function testImports(root: string, test: string): string[] {
  const code = readFileSync(join(root, test), "utf8");
  return parseSync(test, code)
    .module.staticImports.map(({ moduleRequest }) => moduleRequest.value)
    .filter((path) => path.startsWith("./") || path.startsWith("../"))
    .map((path) => normalize(`${dirname(test)}/${path}`));
}

export function dispatchTestPaths(root: string): string[] {
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
  return selectDispatchTests(
    changed,
    files.filter((path) => existsSync(join(root, path))),
    (test) => testImports(root, test),
  );
}
