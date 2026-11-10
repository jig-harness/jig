/**
 * Where the post-merge rule stops (`do_item.post_merge_state`), and the
 * `tracker.ts` operations that honour it: `transition … --post-merge`,
 * `post-merge`, a transition to an optional state left unset, and the claim
 * that refuses a policy the issue link cannot keep.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  closerSentence,
  DEFAULT_POST_MERGE,
  parsePostMerge,
  postMergeTarget,
} from "../scripts/lib/post-merge.ts";

describe("parsePostMerge", () => {
  it("defaults to done with no closer", () => {
    expect(parsePostMerge({})).toEqual(DEFAULT_POST_MERGE);
    expect(parsePostMerge(null)).toEqual(DEFAULT_POST_MERGE);
    expect(parsePostMerge({ do_item: { gates: [] } })).toEqual({
      state: "done",
      closer: null,
    });
  });

  it("reads a state short of done when the pull request only refers to its item", () => {
    expect(
      parsePostMerge({
        do_item: {
          post_merge_state: "in_review",
          post_merge_closer: "the release lead",
        },
        pull_requests: { issue_link: "refs" },
      }),
    ).toEqual({ state: "in_review", closer: "the release lead" });
    expect(
      parsePostMerge({
        do_item: { post_merge_state: "ops_pending" },
        pull_requests: { issue_link: "refs" },
      }).state,
    ).toBe("ops_pending");
  });

  it("refuses a state short of done unless the issue link is refs", () => {
    expect(() =>
      parsePostMerge({ do_item: { post_merge_state: "in_review" } }),
    ).toThrow(
      "do_item.post_merge_state: in_review needs pull_requests.issue_link: refs; with closes, the forge closes the item when the pull request merges",
    );
    expect(() =>
      parsePostMerge({
        do_item: { post_merge_state: "ops_pending" },
        pull_requests: { issue_link: "none" },
      }),
    ).toThrow("with none, the pull request does not name its item");
  });

  it("names a misspelt issue link instead of reading it as closes", () => {
    expect(() =>
      parsePostMerge({
        do_item: { post_merge_state: "in_review" },
        pull_requests: { issue_link: "ref" },
      }),
    ).toThrow(
      'pull_requests.issue_link must be one of closes, refs, none (got "ref")',
    );
  });

  it("refuses a value outside the list and an empty closer", () => {
    expect(() =>
      parsePostMerge({ do_item: { post_merge_state: "pr_open" } }),
    ).toThrow(
      "do_item.post_merge_state must be one of done, ops_pending, in_review",
    );
    expect(() =>
      parsePostMerge({ do_item: { post_merge_closer: " " } }),
    ).toThrow("do_item.post_merge_closer must be a nonempty string");
  });

  it("parks a manual step at ops_pending whatever the policy", () => {
    const policy = { state: "in_review", closer: null } as const;
    expect(postMergeTarget(policy, true)).toBe("ops_pending");
    expect(postMergeTarget(policy, false)).toBe("in_review");
    expect(postMergeTarget(DEFAULT_POST_MERGE, false)).toBe("done");
  });

  it("names who closes an item left short of done", () => {
    expect(closerSentence(DEFAULT_POST_MERGE)).toBeNull();
    expect(closerSentence({ state: "in_review", closer: null })).toBe(
      "A person closes this item once its completion is verified.",
    );
    expect(
      closerSentence({ state: "in_review", closer: "The release lead" }),
    ).toBe(
      "The release lead closes this item once its completion is verified.",
    );
  });
});

describe("tracker.ts and the post-merge policy", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /**
   * Run `tracker.ts` under `overlay`. The GitHub adapter's endpoint is a
   * closed port, so any tracker read or write fails the run: an exit of 0 or
   * 3 shows that nothing was read or written.
   */
  function run(overlay: string, args: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "post-merge-"));
    dirs.push(dir);
    const file = join(dir, "jig.yaml");
    writeFileSync(
      file,
      `issue_tracker:\n  github:\n    repository: example/app\n${overlay}`,
    );
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && !k.startsWith("DRIVE_PR_")) env[k] = v;
    return Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../scripts/tracker.ts"),
        ...args,
      ],
      {
        cwd: dir,
        env: {
          ...env,
          JIG_OVERLAY: file,
          JIG_USER_LAYER: "off",
          JIG_GITHUB_GRAPHQL_URL: "http://127.0.0.1:9/graphql",
          GH_TOKEN: "test-token",
        },
      },
    );
  }

  const SHORT_OF_DONE =
    "do_item:\n  post_merge_state: in_review\n  post_merge_closer: the release lead\npull_requests:\n  issue_link: refs\n";

  it("refuses a post-merge move to done when the policy stops short of it", () => {
    const r = run(SHORT_OF_DONE, ["transition", "#5", "done", "--post-merge"]);
    expectSpawnExit(r, 3);
    expect(JSON.parse(r.stdout.toString())).toEqual({
      issue: "#5",
      state: "done",
      refused:
        "do_item.post_merge_state is in_review: the post-merge rule stops at in_review and a person closes #5",
    });
  });

  it("prints the policy with its closing sentence", () => {
    const r = run(SHORT_OF_DONE, ["post-merge"]);
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout.toString())).toEqual({
      state: "in_review",
      closer: "the release lead",
      closing:
        "the release lead closes this item once its completion is verified.",
    });
  });

  it("refuses the policy before a post-merge move or a claim when the issue link closes the item", () => {
    const overlay = "do_item:\n  post_merge_state: in_review\n";
    for (const args of [
      ["transition", "#5", "in_review", "--post-merge"],
      ["claim", "#5"],
      ["post-merge"],
    ]) {
      const r = run(overlay, args);
      expectSpawnExit(r, 1);
      expect(r.stderr.toString()).toContain(
        "do_item.post_merge_state: in_review needs pull_requests.issue_link: refs",
      );
    }
  });

  it("skips a move to pr_open the repository leaves unset, reading and writing nothing", () => {
    const r = run("", ["transition", "#5", "pr_open"]);
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout.toString())).toEqual({
      issue: "#5",
      state: "pr_open",
      name: null,
      skipped: "issue_tracker.states.pr_open is not set",
    });
  });

  it("leaves a person's direct move alone, and lets a post-merge move to done through under the default", () => {
    // Both reach the tracker, which the closed port refuses: exit 1, not 3.
    for (const [overlay, args] of [
      [SHORT_OF_DONE, ["transition", "#5", "done"]],
      ["", ["transition", "#5", "done", "--post-merge"]],
    ] as const) {
      const r = run(overlay, [...args]);
      expectSpawnExit(r, 1);
      expect(r.stdout.toString()).toBe("");
    }
  });
});
