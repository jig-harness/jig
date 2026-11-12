// The nightly run's known-failure baseline (`.config/nightly-baseline.yaml`):
// the tests known to fail on macOS or Windows, each under a group that says
// why and which issue owns the fix. scripts/test.ts reads it when the nightly
// workflow names it, so a failure it records does not fail the run and one it
// does not record does; scripts/check-nightly-baseline.ts keeps it valid.
//
// A test is named as bun names it: the file's path from the repository root,
// with forward slashes, and the test's full name, its `describe` blocks and
// its own title joined by ` > `. A hook that fails outside any test is
// `(unnamed)`, under the blocks it sits in.
import { load as loadYaml } from "../../lib/vendor/js-yaml.mjs";
import { isRecord } from "../../lib/record.ts";

/** A nightly command that cannot go on: a usage error, or input it cannot read. */
export class NightlyError extends Error {}

/** Where the nightly runs, by the names the baseline uses. */
export const PLATFORMS = ["linux", "macos", "windows"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** The baseline's name for a `process.platform`. */
export function platformName(platform: string = process.platform): Platform {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

/** One test, by its file and its full name. */
export interface TestId {
  file: string;
  name: string;
}

/** One recorded failure: the test, where it fails, why, and who fixes it. */
export interface BaselineEntry extends TestId {
  platform: Platform;
  reason: string;
  issue: string;
}

/** A test's key: file and full name, which no title can split ambiguously. */
export const testKey = (test: TestId): string => `${test.file}\n${test.name}`;

/** The title bun gives a hook that fails outside any test. */
export const UNNAMED = "(unnamed)";

/** Whether the name is a hook's failure rather than a test's. */
export const isUnnamed = (name: string): boolean =>
  name === UNNAMED || name.endsWith(` > ${UNNAMED}`);

const GROUP_KEYS = new Set(["platform", "issue", "reason", "tests"]);

/** A problem with the baseline's content, located by its group. */
export interface BaselineProblem {
  where: string;
  problem: string;
}

function groupProblems(group: unknown, where: string): BaselineProblem[] {
  if (!isRecord(group))
    return [{ where, problem: "a group must be a mapping" }];
  const problems: BaselineProblem[] = [];
  const say = (problem: string) => problems.push({ where, problem });
  for (const key of Object.keys(group))
    if (!GROUP_KEYS.has(key)) say(`unknown field ${JSON.stringify(key)}`);
  if (!PLATFORMS.some((p) => p === group.platform))
    say(`platform must be one of ${PLATFORMS.join(", ")}`);
  if (typeof group.issue !== "string" || !/^#[1-9][0-9]*$/.test(group.issue))
    say('issue must be the owning issue as "#<number>"');
  if (typeof group.reason !== "string" || !group.reason.trim())
    say("reason must say why the tests fail");
  if (!isRecord(group.tests) || !Object.keys(group.tests).length)
    say("tests must map each test file to the names that fail in it");
  return problems;
}

function fileProblems(
  file: string,
  names: unknown,
  where: string,
): BaselineProblem[] {
  const problems: BaselineProblem[] = [];
  const at = `${where}, ${file}`;
  if (
    file.startsWith("/") ||
    file.includes("\\") ||
    /^[A-Za-z]:/.test(file) ||
    file.split("/").some((part) => part === ".." || part === "." || !part)
  )
    problems.push({
      where: at,
      problem:
        "the file must be a path from the repository root, with forward slashes",
    });
  if (
    !Array.isArray(names) ||
    !names.length ||
    names.some((name) => typeof name !== "string" || !name.trim())
  )
    problems.push({
      where: at,
      problem: "a file must list the full names of its failing tests",
    });
  return problems;
}

/**
 * The baseline's entries, and every problem with it: its shape, a field's
 * value, a test recorded twice for one platform. An entry is kept only when
 * its group and file are sound, so a caller that refuses on any problem never
 * acts on part of a broken baseline.
 */
export function readBaseline(raw: string): {
  entries: BaselineEntry[];
  problems: BaselineProblem[];
} {
  let document: unknown;
  try {
    document = loadYaml(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { entries: [], problems: [{ where: "baseline", problem: reason }] };
  }
  if (
    !isRecord(document) ||
    document.version !== 1 ||
    !Array.isArray(document.groups) ||
    Object.keys(document).some((key) => key !== "version" && key !== "groups")
  )
    return {
      entries: [],
      problems: [
        {
          where: "baseline",
          problem:
            "the baseline must hold `version: 1` and a `groups` list, and nothing else",
        },
      ],
    };
  const entries: BaselineEntry[] = [];
  const problems: BaselineProblem[] = [];
  const seen = new Set<string>();
  document.groups.forEach((group: unknown, index: number) => {
    const where = `group ${index + 1}`;
    const found = groupProblems(group, where);
    problems.push(...found);
    if (found.length || !isRecord(group) || !isRecord(group.tests)) return;
    const { platform, issue, reason } = group as Omit<
      BaselineEntry,
      keyof TestId
    >;
    for (const [file, names] of Object.entries(group.tests)) {
      const wrong = fileProblems(file, names, where);
      problems.push(...wrong);
      if (wrong.length || !Array.isArray(names)) continue;
      for (const name of names as string[]) {
        const key = `${platform}\n${testKey({ file, name })}`;
        if (seen.has(key)) {
          problems.push({
            where: `${where}, ${file}`,
            problem: `${JSON.stringify(name)} is recorded twice for ${platform}`,
          });
          continue;
        }
        seen.add(key);
        entries.push({ platform, issue, reason, file, name });
      }
    }
  });
  return { entries, problems };
}
