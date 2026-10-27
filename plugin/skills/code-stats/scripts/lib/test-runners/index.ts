/**
 * The test-runner layer: what the repository's test runners say its tests
 * are, read from their configuration files as text, never run. It sits
 * between built-in detection and the `code_stats` configuration: a rule
 * here makes a code file a test, overriding the conventions, and the
 * `code_stats` kinds and the classify command override it in turn.
 *
 * A configuration file in a vendored or fixture folder belongs to another
 * project or to a test's data, not to this repository, and is not read.
 */
import {
  FIXTURE_CONVENTIONS,
  firstConvention,
  VENDORED_CONVENTIONS,
} from "../conventions.ts";
import { readGradle } from "./gradle.ts";
import { readJest } from "./jest.ts";
import { readMaven } from "./maven.ts";
import type { Reading, RepoFiles, RunnerRule } from "./model.ts";
import { nameOf } from "./model.ts";
import { readPytest } from "./pytest.ts";
import { readVitest } from "./vitest.ts";

export type { Reading, RepoFiles, RunnerRule, Unreadable } from "./model.ts";
export { EMPTY_READING } from "./model.ts";

/** Every reader, in the order its rules are tried. */
const READERS: readonly ((files: RepoFiles) => Reading)[] = [
  readJest,
  readVitest,
  readPytest,
  readGradle,
  readMaven,
];

/** Whether a configuration file is another project's or a test's data. */
function elsewhere(path: string): boolean {
  const name = nameOf(path);
  return (
    firstConvention(VENDORED_CONVENTIONS, path, name) !== null ||
    firstConvention(FIXTURE_CONVENTIONS, path, name) !== null
  );
}

/** What every test runner's configuration says, and what could not be read. */
export function readTestRunners(files: RepoFiles): Reading {
  const own: RepoFiles = {
    paths: files.paths.filter((p) => !elsewhere(p)),
    read: (p) => files.read(p),
  };
  const reading: Reading = { rules: [], unreadable: [] };
  for (const read of READERS) {
    const one = read(own);
    reading.rules.push(...one.rules);
    reading.unreadable.push(...one.unreadable);
  }
  return reading;
}

/** Each reading's rules by scope, with their order, so a path tries only those above it. */
const indexes = new WeakMap<Reading, Map<string, [number, RunnerRule][]>>();

function byScope(reading: Reading): Map<string, [number, RunnerRule][]> {
  let index = indexes.get(reading);
  if (index) return index;
  index = new Map();
  for (const [i, rule] of reading.rules.entries())
    index.set(rule.scope, [...(index.get(rule.scope) ?? []), [i, rule]]);
  indexes.set(reading, index);
  return index;
}

/** The first rule, in reader order, that claims `path` as a test, or null. */
export function runnerRuleFor(
  reading: Reading,
  path: string,
): RunnerRule | null {
  const index = byScope(reading);
  let best: [number, RunnerRule] | null = null;
  const folders = path.split("/").slice(0, -1);
  for (let depth = 0; depth <= folders.length; depth++)
    for (const entry of index.get(folders.slice(0, depth).join("/")) ?? [])
      if ((best === null || entry[0] < best[0]) && entry[1].matches(path))
        best = entry;
  return best?.[1] ?? null;
}

/** How `--explain` names a rule: the reader, the file and the key. */
export function describeRunnerRule(rule: RunnerRule): string {
  return `test runner ${rule.reader}: ${rule.file} ${rule.key} ${JSON.stringify(rule.pattern)}`;
}
