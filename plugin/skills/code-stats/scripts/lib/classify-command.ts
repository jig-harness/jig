/**
 * The repository's classify command, the last classification layer. It runs
 * once from the repository root with the tracked paths on standard input,
 * one per line, and prints one JSON object per line,
 * `{"path": …, "area"?: …, "kind"?: …, "language"?: …, "module"?: …}`,
 * whose values override every earlier layer. It fails closed: a non-zero
 * exit, a line that is not such an object, a path that is not tracked, or an
 * area or kind the report does not know is an error naming the problem.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { readTimeoutEnv, run } from "../../../../shared/proc.ts";
import type { Override } from "./classify.ts";
import { CodeStatsError } from "./errors.ts";
import { isKind } from "./model.ts";

/** The variable that bounds the command, in seconds. */
export const TIMEOUT_ENV = "JIG_CODE_STATS_COMMAND_TIMEOUT_SEC";
const DEFAULT_TIMEOUT_SEC = 300;
const KEYS = ["path", "area", "kind", "language", "module"];

function parseObject(text: string, where: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CodeStatsError(`${where} is not JSON: ${text.slice(0, 200)}`, {
      cause: error,
    });
  }
  if (!isRecord(value))
    throw new CodeStatsError(`${where} is not a JSON object`);
  const unknown = Object.keys(value).find((key) => !KEYS.includes(key));
  if (unknown !== undefined)
    throw new CodeStatsError(
      `${where} has unknown key ${unknown} (known: ${KEYS.join(", ")})`,
    );
  return value;
}

/** The checked value of each field the command may set, by field. */
function fieldChecks(
  areas: ReadonlySet<string>,
): Record<keyof Override, (value: unknown) => string | null> {
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() !== ""
      ? null
      : "that is not a nonempty string";
  return {
    area: (value) =>
      typeof value === "string" && areas.has(value)
        ? null
        : `the unknown area ${JSON.stringify(value)} (known: ${[...areas].join(", ")})`,
    kind: (value) =>
      isKind(value) ? null : `the unknown kind ${JSON.stringify(value)}`,
    language: (value) => (text(value) ? `a language ${text(value)}` : null),
    module: (value) => (text(value) ? `a module ${text(value)}` : null),
  };
}

function parseLine(
  text: string,
  where: string,
  tracked: ReadonlySet<string>,
  areas: ReadonlySet<string>,
): [string, Override] {
  const value = parseObject(text, where);
  const path = value.path;
  if (path === undefined) throw new CodeStatsError(`${where} has no path`);
  if (typeof path !== "string" || !tracked.has(path))
    throw new CodeStatsError(
      `${where} names ${JSON.stringify(path)}, which is not a tracked file`,
    );
  const override: Record<string, unknown> = {};
  for (const [field, check] of Object.entries(fieldChecks(areas))) {
    if (value[field] === undefined) continue;
    const problem = check(value[field]);
    if (problem) throw new CodeStatsError(`${where} gives ${path} ${problem}`);
    override[field] = value[field];
  }
  return [path, override as Override];
}

/** Parse the command's output into an override per path it named. */
export function parseClassifyOutput(
  stdout: string,
  tracked: ReadonlySet<string>,
  areas: ReadonlySet<string>,
): Map<string, Override> {
  const overrides = new Map<string, Override>();
  for (const [i, raw] of stdout.split("\n").entries()) {
    const text = raw.trim();
    if (text === "") continue;
    const where = `code_stats.classify_command output line ${i + 1}`;
    const [path, override] = parseLine(text, where, tracked, areas);
    if (overrides.has(path))
      throw new CodeStatsError(`${where} names ${path} a second time`);
    overrides.set(path, override);
  }
  return overrides;
}

function timeoutSec(): number {
  const read = readTimeoutEnv(TIMEOUT_ENV, DEFAULT_TIMEOUT_SEC);
  if (!read.ok)
    throw new CodeStatsError(
      `${TIMEOUT_ENV} must be a whole number of seconds from 1 to 2147483, not ${JSON.stringify(read.raw)}`,
    );
  return read.seconds;
}

/** Run the command over `paths` from `root`; its overrides by path. */
export async function runClassifyCommand(
  root: string,
  command: string,
  paths: readonly string[],
  areas: ReadonlySet<string>,
): Promise<Map<string, Override>> {
  const odd = paths.find((p) => p.includes("\n"));
  if (odd !== undefined)
    throw new CodeStatsError(
      `the tracked path ${JSON.stringify(odd)} holds a newline, so code_stats.classify_command cannot be given it (it reads one path per line): rename the file, or leave the command out`,
    );
  const seconds = timeoutSec();
  const argv =
    process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", command]
      : ["sh", "-c", command];
  const result = await run(argv, {
    cwd: root,
    stdin: paths.length ? `${paths.join("\n")}\n` : "",
    timeoutSec: seconds,
  });
  if (result.code !== 0) {
    const why = result.timedOut
      ? `still running after ${seconds}s, stopped; ${TIMEOUT_ENV} sets the bound`
      : result.spawnFailed
        ? `could not start: ${result.stderr.trim()}`
        : `exit ${result.code}${result.stderrTail.trim() ? `: ${result.stderrTail.trim()}` : ""}`;
    throw new CodeStatsError(
      `code_stats.classify_command \`${command}\` failed (${why})`,
    );
  }
  return parseClassifyOutput(result.stdout, new Set(paths), areas);
}
