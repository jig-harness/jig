/**
 * The guard before an outside write passes on the marker check's refusal,
 * and a preview is refused before the marker is asked anything.
 */
import { describe, expect, test } from "bun:test";
import type { RunResult } from "../../../shared/proc.ts";
import {
  guard,
  markerCheckArgv,
  type MarkerRunner,
  PREVIEW_EXIT,
} from "../scripts/lib/guard.ts";

function result(over: Partial<RunResult>): RunResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    bufferExceeded: false,
    spawnFailed: false,
    stderrTail: "",
    ...over,
  };
}

/** A runner that answers `answer` and records each command line it was given. */
function runner(answer: RunResult): { run: MarkerRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (argv) => {
      calls.push(argv);
      return answer;
    },
  };
}

describe("guard", () => {
  test("a held claim passes", async () => {
    const r = runner(result({ code: 0 }));
    const answer = await guard(7, 42, { mode: "post-merge", runner: r.run });
    expect(answer.exit).toBe(0);
    expect(r.calls).toHaveLength(1);
  });

  for (const [code, meaning] of [
    [1, "the forge could not be read"],
    [2, "the marker is missing or not trusted"],
    [3, "an earlier marker holds the follow-up"],
  ] as const)
    test(`marker check exit ${code} (${meaning}) stops the pass with it`, async () => {
      const r = runner(
        result({ code, stderrTail: `jig dispatch marker: ${meaning}` }),
      );
      const answer = await guard(7, 42, { mode: "post-merge", runner: r.run });
      expect(answer.exit).toBe(code);
      expect(answer.message).toContain("stop:");
      expect(answer.message).toContain(meaning);
    });

  test("a check that ran out of time reads as an unreadable forge", async () => {
    const r = runner(result({ code: 124, timedOut: true }));
    const answer = await guard(7, 42, { mode: "post-merge", runner: r.run });
    expect(answer.exit).toBe(1);
  });

  test("a preview is refused and the marker is never asked", async () => {
    const r = runner(result({ code: 0 }));
    const answer = await guard(7, 42, { mode: "preview", runner: r.run });
    expect(answer.exit).toBe(PREVIEW_EXIT);
    expect(r.calls).toEqual([]);
  });

  test("the check is this plugin's marker check, on the pull request and marker given", () => {
    const argv = markerCheckArgv(7, 42, "acme/shop");
    expect(argv.slice(-8)).toEqual([
      "dispatch",
      "marker",
      "check",
      "7",
      "--comment",
      "42",
      "--repo",
      "acme/shop",
    ]);
    expect(argv.some((a) => a.endsWith("jig.ts"))).toBe(true);
  });
});
