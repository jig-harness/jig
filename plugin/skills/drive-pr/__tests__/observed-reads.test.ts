/**
 * The pull-request readers an evaluation observes with share one reading per
 * resource within the evaluation (`lib/paged-read.ts`), and a guard read
 * still asks the forge itself.
 *
 * `bun test` runs uncached (`NODE_ENV=test` with no `JIG_GH_CACHE_DIR`), so
 * every reading here is the reader's own whole `gh api --paginate --slurp`
 * call, counted at `proc.ghCall`. The page-by-page revalidation across
 * evaluations is `shared/__tests__/observed-pages.test.ts`'s.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as proc from "../scripts/lib/proc.ts";
import {
  ghCacheDir,
  withObservedEvaluation,
} from "../scripts/lib/gh-conditional.ts";
import {
  checkRunsFor,
  reviewerStickyMarkers,
} from "../scripts/lib/status/evidence.ts";
import { commentDraftSkip } from "../scripts/lib/status/comment-draft-skip.ts";

const SHA = "c".repeat(40);
const COMMENTS = "repos/acme/widgets/issues/7/comments?per_page=100";
const CHECKS = `repos/acme/widgets/commits/${SHA}/check-runs?per_page=100`;

const PAGES: Record<string, unknown> = {
  [COMMENTS]: [[{ user: { login: "someone" }, body: "a comment" }]],
  [CHECKS]: [
    {
      total_count: 1,
      check_runs: [
        { id: 1, name: "ci", status: "completed", conclusion: "success" },
      ],
    },
  ],
};

let sent: string[];
let restore: () => void;

beforeEach(() => {
  sent = [];
  const spy = spyOn(proc, "ghCall");
  spy.mockImplementation(async (args: string[]) => {
    const path = args.at(-1) ?? "";
    sent.push(path);
    const pages = PAGES[path];
    return {
      code: pages === undefined ? 1 : 0,
      stdout: pages === undefined ? "" : JSON.stringify(pages),
      stderr: pages === undefined ? "gh: Not Found (HTTP 404)\n" : "",
      stderrTail: "",
      timedOut: false,
      bufferExceeded: false,
      spawnFailed: false,
    };
  });
  restore = () => spy.mockRestore();
});

afterEach(() => restore());

const count = (path: string) => sent.filter((p) => p === path).length;

describe("observed pull-request reads", () => {
  it("runs uncached under bun test", () => {
    expect(ghCacheDir()).toBeNull();
  });

  it("one evaluation reads the comments and the check runs once, whichever readers ask", async () => {
    await withObservedEvaluation(async () => {
      const [sticky, skip, runs] = await Promise.all([
        reviewerStickyMarkers("acme", "widgets", "7"),
        commentDraftSkip("acme", "widgets", "7", "coderabbitai"),
        checkRunsFor("acme", "widgets", SHA, "observed"),
        checkRunsFor("acme", "widgets", SHA, "observed"),
      ]);
      expect(sticky).not.toBeNull();
      expect(skip).toBe(false);
      expect(runs?.map((r) => r.name)).toEqual(["ci"]);
      expect(await reviewerStickyMarkers("acme", "widgets", "7")).toEqual(
        sticky,
      );
    });
    expect(count(COMMENTS)).toBe(1);
    expect(count(CHECKS)).toBe(1);
  });

  it("a guard read after an observation in the same evaluation sends its own request", async () => {
    await withObservedEvaluation(async () => {
      await checkRunsFor("acme", "widgets", SHA, "observed");
      // The default is the fresh read a CI-green proof or a hold release takes.
      await checkRunsFor("acme", "widgets", SHA);
      await checkRunsFor("acme", "widgets", SHA, "fresh");
    });
    expect(count(CHECKS)).toBe(3);
  });

  it("observations outside an evaluation share nothing", async () => {
    await reviewerStickyMarkers("acme", "widgets", "7");
    await reviewerStickyMarkers("acme", "widgets", "7");
    expect(count(COMMENTS)).toBe(2);
  });
});
