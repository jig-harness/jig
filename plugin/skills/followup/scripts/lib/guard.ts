/**
 * The check before every act a follow-up takes outside the pull request:
 * `jig dispatch marker check <PR> --comment <marker>` from this plugin, its
 * exit passed on. Any nonzero exit stops the pass: `1` the forge could not be
 * read, `2` the marker is missing or not trusted, `3` an earlier marker holds
 * the follow-up. A preview acts nowhere outside the pull request, so it is
 * refused before anything is asked.
 */
import { resolve } from "node:path";
import { run, type RunResult } from "../../../../shared/proc.ts";

/** The plugin's root: the directory holding `jig.ts`, three levels above `scripts/lib`. */
const PLUGIN = resolve(import.meta.dir, "../../../..");

/** How long the marker check may take before it counts as unreadable. */
const CHECK_TIMEOUT_SEC = 120;

/** The exit of a preview's guard: nothing may be written outside the pull request. */
export const PREVIEW_EXIT = 4;

export type MarkerRunner = (argv: string[]) => Promise<RunResult>;

/** The command line of the marker check, under the dispatcher's trusted startup. */
export function markerCheckArgv(
  pr: number,
  marker: number,
  repo: string | null,
): string[] {
  return [
    process.execPath,
    "--no-env-file",
    `--config=${resolve(PLUGIN, "dispatch", "bunfig.toml")}`,
    resolve(PLUGIN, "jig.ts"),
    "dispatch",
    "marker",
    "check",
    String(pr),
    "--comment",
    String(marker),
    ...(repo === null ? [] : ["--repo", repo]),
  ];
}

const defaultRunner: MarkerRunner = (argv) =>
  run(argv, { timeoutSec: CHECK_TIMEOUT_SEC });

/** What the guard answers: the exit, and a line for a person. */
export interface GuardAnswer {
  exit: number;
  message: string;
}

/** Check that this run still holds the follow-up of `pr` before an outside write. */
export async function guard(
  pr: number,
  marker: number,
  opts: {
    mode: "post-merge" | "preview";
    repo?: string | null | undefined;
    runner?: MarkerRunner;
  },
): Promise<GuardAnswer> {
  if (opts.mode === "preview")
    return {
      exit: PREVIEW_EXIT,
      message: `PR #${pr} is not merged: a preview carries out nothing outside the pull request; record what the merge will owe instead`,
    };
  const result = await (opts.runner ?? defaultRunner)(
    markerCheckArgv(pr, marker, opts.repo ?? null),
  );
  if (result.code === 0)
    return {
      exit: 0,
      message: `this run holds the follow-up of PR #${pr} (marker ${marker})`,
    };
  const why = (result.stderrTail || result.stderr).trim();
  // A check that never ran, or ran out of time, read nothing: the forge was not read.
  const exit =
    result.spawnFailed || result.timedOut || ![1, 2, 3].includes(result.code)
      ? 1
      : result.code;
  return {
    exit,
    message: `stop: the claim on PR #${pr} could not be confirmed (marker check exited ${result.code}${result.timedOut ? ", out of time" : ""})${why === "" ? "" : `: ${why}`}`,
  };
}
