/**
 * The parent-status decision over the repository's own vocabulary: its
 * state names and labels, the optional `pr_open` and `blocked` states, and
 * `do_item.post_merge_state`.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_VOCABULARY,
  type ReconcileChildInput,
  reconcileParentStatus,
} from "../scripts/reconcile_parent_status.ts";
import { parseTrackerLabels } from "../../../shared/tracker-labels.ts";
import { classifyChildState, issueResult } from "../scripts/get_issue.ts";

function child(
  name: string,
  opts: { type?: string; labels?: ReconcileChildInput["labels"] } = {},
): ReconcileChildInput {
  return {
    state: { name, ...(opts.type === undefined ? {} : { type: opts.type }) },
    labels: opts.labels ?? [],
  };
}

describe("reconcileParentStatus with the consumer's vocabulary", () => {
  const vocabulary = {
    labels: parseTrackerLabels({
      issue_tracker: { labels: { manual_ops: "ops-step", hitl: "human" } },
    }),
    states: {
      ...DEFAULT_VOCABULARY.states,
      in_review: "Reviewing",
      ops_pending: "Awaiting Ops",
    },
  };

  it("caps at the tracker's own name for the least-advanced parked state", () => {
    const r = reconcileParentStatus(
      {
        parentLabels: [],
        children: [
          { state: { name: "Reviewing", type: "started" } },
          { state: { name: "Awaiting Ops", type: "started" } },
        ],
      },
      vocabulary,
    );
    expect(r).toMatchObject({
      verdict: "set_status",
      parentState: "in_review",
      parentStateName: "Reviewing",
    });
  });

  it("does not read the default names as parked", () => {
    const r = reconcileParentStatus(
      {
        parentLabels: [],
        children: [{ state: { name: "In Review", type: "started" } }],
      },
      vocabulary,
    );
    expect(r.verdict).toBe("keep_in_progress");
  });

  it("reads the configured manual-operations label and tails", () => {
    const done = reconcileParentStatus(
      {
        parentLabels: ["ops-step"],
        children: [{ state: { name: "Done", type: "completed" } }],
      },
      vocabulary,
    );
    expect(done).toMatchObject({
      parentState: "ops_pending",
      parentStateName: "Awaiting Ops",
    });
    const tail = reconcileParentStatus(
      {
        parentLabels: [],
        children: [
          {
            state: { name: "Todo", type: "unstarted" },
            labels: ["human:legal"],
          },
        ],
      },
      vocabulary,
    );
    expect(tail.verdict).toBe("extract_and_close_eligible");
    const oldName = reconcileParentStatus(
      {
        parentLabels: [],
        children: [
          {
            state: { name: "Todo", type: "unstarted" },
            labels: ["hitl:legal"],
          },
        ],
      },
      vocabulary,
    );
    expect(oldName.verdict).toBe("keep_in_progress");
  });

  describe("a child state with no category", () => {
    const named = {
      ...DEFAULT_VOCABULARY.states,
      done: "Shipped",
      in_review: "Closed",
    };

    it("reads the configured names before the English fallback", () => {
      expect(classifyChildState({ name: "Shipped", type: "" }, named)).toBe(
        "completed",
      );
      expect(classifyChildState({ name: "closed", type: "" }, named)).toBe(
        "incomplete",
      );
      expect(classifyChildState({ name: "Closed", type: "" })).toBe(
        "completed",
      );
      expect(
        classifyChildState({ name: "Shipped", type: "started" }, named),
      ).toBe("incomplete");
    });

    it("completes a parent whose children are done under the tracker's name", () => {
      const r = reconcileParentStatus(
        {
          parentLabels: [],
          children: [{ state: { name: "Shipped", type: "" } }],
        },
        { ...vocabulary, states: named },
      );
      expect(r).toMatchObject({ verdict: "set_status", parentState: "done" });
    });

    it("caps, never completes, a parent with a parked child named like a done state", () => {
      const r = reconcileParentStatus(
        {
          parentLabels: [],
          children: [
            { state: { name: "Shipped", type: "completed" } },
            { state: { name: "Closed", type: "" } },
          ],
        },
        { ...vocabulary, states: named },
      );
      expect(r).toMatchObject({
        verdict: "set_status",
        parentState: "in_review",
        parentStateName: "Closed",
      });
    });

    it("matches a parked child's name as the classification does: trimmed, any case", () => {
      const r = reconcileParentStatus(
        {
          parentLabels: [],
          children: [
            { state: { name: "Shipped", type: "completed" } },
            { state: { name: " closed ", type: "" } },
          ],
        },
        { ...vocabulary, states: named },
      );
      expect(r).toMatchObject({
        verdict: "set_status",
        parentState: "in_review",
        parentStateName: "Closed",
      });
    });

    it("gives get_issue.ts's sub-issue analysis the same reading", () => {
      const result = issueResult(
        {
          id: "i-1",
          identifier: "ENG-1",
          title: "Epic",
          description: "",
          updatedAt: "2026-10-11T00:00:00.000Z",
          state: { name: "In Progress", type: "started" },
          labels: [],
          url: "https://example.test/ENG-1",
          parent: null,
          children: [
            {
              identifier: "ENG-2",
              title: "a",
              state: { name: "Shipped", type: "" },
            },
            {
              identifier: "ENG-3",
              title: "b",
              state: { name: "Closed", type: "" },
            },
          ],
          assignee: null,
          project: null,
        } as unknown as Parameters<typeof issueResult>[0],
        named,
      );
      expect(result.sub_issue_analysis).toMatchObject({
        completed: 1,
        incomplete: 1,
        all_complete: false,
      });
    });
  });
});

describe("reconcileParentStatus with pr_open", () => {
  const withPrOpen = (prOpen: string | null) => ({
    ...DEFAULT_VOCABULARY,
    states: { ...DEFAULT_VOCABULARY.states, pr_open: prOpen },
  });
  const started = (name: string) => child(name, { type: "started" });

  it("keeps an epic whose children all have open pull requests in progress", () => {
    expect(
      reconcileParentStatus(
        {
          parentLabels: [],
          children: [started("Awaiting Review"), started("Awaiting Review")],
        },
        withPrOpen("Awaiting Review"),
      ).verdict,
    ).toBe("keep_in_progress");
  });

  describe("under a name pr_open shares with in_review", () => {
    // One review status, held while the pull request is open and again
    // after the merge until a person closes the item.
    const shared = {
      ...DEFAULT_VOCABULARY,
      states: {
        ...DEFAULT_VOCABULARY.states,
        pr_open: "In Review",
        in_review: "In Review",
      },
      postMergeState: "in_review" as const,
    };
    const underShared = (
      pullRequest?: ReconcileChildInput["pullRequest"],
    ): ReconcileChildInput => ({
      ...started("In Review"),
      ...(pullRequest === undefined ? {} : { pullRequest }),
    });

    it("rolls an epic whose children have all merged up to in_review", () => {
      expect(
        reconcileParentStatus(
          {
            parentLabels: [],
            children: [underShared("merged"), underShared("merged")],
          },
          shared,
        ),
      ).toMatchObject({
        verdict: "set_status",
        parentState: "in_review",
        parentStateName: "In Review",
      });
    });

    it("reads a merged child beside a done one as in_review", () => {
      expect(
        reconcileParentStatus(
          {
            parentLabels: [],
            children: [
              underShared("merged"),
              child("Done", { type: "completed" }),
            ],
          },
          shared,
        ),
      ).toMatchObject({ verdict: "set_status", parentState: "in_review" });
    });

    for (const [what, fact] of [
      ["whose pull request is still open", "open"],
      ["with no linked pull request", "none"],
      ["whose pull request could not be read", "unreadable"],
      ["with no pull request fact", undefined],
    ] as const) {
      it(`keeps the epic in progress for a child ${what}`, () => {
        const r = reconcileParentStatus(
          {
            parentLabels: [],
            children: [underShared("merged"), underShared(fact)],
          },
          shared,
        );
        expect(r).toMatchObject({
          verdict: "keep_in_progress",
          parentState: null,
        });
        expect(r.reason).toContain('its pullRequest fact is not "merged"');
      });
    }

    it("still caps at in_review once a person closes the children", () => {
      expect(
        reconcileParentStatus(
          {
            parentLabels: [],
            children: [
              child("Done", { type: "completed" }),
              child("Done", { type: "completed" }),
            ],
          },
          shared,
        ),
      ).toMatchObject({ verdict: "set_status", parentState: "in_review" });
    });

    it("names the child workflow's shared review state in its explanation", () => {
      const parentVocabulary = {
        ...shared,
        states: { ...shared.states, pr_open: null, in_review: null },
        statesByType: { Story: shared.states },
      };
      const result = reconcileParentStatus(
        {
          parentLabels: [],
          children: [
            {
              ...underShared("open"),
              nativeType: "Story",
            },
          ],
        },
        parentVocabulary,
      );
      expect(result.reason).toContain('under "In Review"');
      expect(result.reason).not.toContain('under "null"');
    });
  });

  it("ignores a merged pull request fact under a distinct pr_open name", () => {
    expect(
      reconcileParentStatus(
        {
          parentLabels: [],
          children: [
            { ...started("Awaiting Review"), pullRequest: "merged" },
            child("Done", { type: "completed" }),
          ],
        },
        withPrOpen("Awaiting Review"),
      ),
    ).toMatchObject({ verdict: "keep_in_progress", parentState: null });
  });

  it("caps at in_review, as before, while pr_open is unset", () => {
    const r = reconcileParentStatus(
      {
        parentLabels: [],
        children: [started("In Review"), child("Done", { type: "completed" })],
      },
      withPrOpen(null),
    );
    expect(r).toMatchObject({
      verdict: "set_status",
      parentState: "in_review",
    });
  });
});

describe("reconcileParentStatus with blocked", () => {
  const vocabulary = {
    ...DEFAULT_VOCABULARY,
    states: { ...DEFAULT_VOCABULARY.states, blocked: "Blocked" },
  };

  it("a blocked child holds its parent in progress, with or without a category", () => {
    for (const blocked of [
      child("Blocked", { type: "started" }),
      child("Blocked", { type: "unstarted" }),
      child("Blocked"),
    ])
      expect(
        reconcileParentStatus(
          {
            parentLabels: [],
            children: [blocked, child("Done", { type: "completed" })],
          },
          vocabulary,
        ),
      ).toMatchObject({ verdict: "keep_in_progress", parentState: null });
  });
});

describe("reconcileParentStatus with do_item.post_merge_state", () => {
  const done = [
    child("Done", { type: "completed" }),
    child("Canceled", { type: "canceled" }),
  ];

  it("caps an epic whose children are all done at the post-merge state", () => {
    for (const postMergeState of ["in_review", "ops_pending"] as const) {
      const r = reconcileParentStatus(
        { parentLabels: [], children: done },
        { ...DEFAULT_VOCABULARY, postMergeState },
      );
      expect(r).toMatchObject({
        verdict: "set_status",
        parentState: postMergeState,
        parentStateName: DEFAULT_VOCABULARY.states[postMergeState],
      });
      expect(r.reason).toContain("do_item.post_merge_state");
    }
  });

  it("still parks a manual-operations epic at ops_pending", () => {
    expect(
      reconcileParentStatus(
        { parentLabels: ["manual-ops"], children: done },
        { ...DEFAULT_VOCABULARY, postMergeState: "in_review" },
      ).parentState,
    ).toBe("ops_pending");
  });

  it("describes the no-close path for extractable tails when post-merge policy stops short of done", () => {
    const r = reconcileParentStatus(
      {
        parentLabels: [],
        children: [
          child("In Progress", { type: "started", labels: ["pr-followup"] }),
        ],
      },
      { ...DEFAULT_VOCABULARY, postMergeState: "in_review" },
    );

    expect(r).toMatchObject({
      verdict: "extract_and_close_eligible",
      parentState: null,
    });
    expect(r.reason).toContain("extract each tail");
    expect(r.reason).not.toContain("sweep-epic");
    expect(r.reason).toContain('do_item.post_merge_state "In Review"');
  });

  it("moves it to done under the default", () => {
    expect(
      reconcileParentStatus(
        { parentLabels: [], children: done },
        { ...DEFAULT_VOCABULARY, postMergeState: "done" },
      ).parentState,
    ).toBe("done");
  });

  it("reads the post-merge state from the overlay when run as a script", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-post-merge-"));
    try {
      const overlay = join(dir, "jig.yaml");
      writeFileSync(
        overlay,
        "do_item:\n  post_merge_state: in_review\npull_requests:\n  issue_link: refs\n",
      );
      const input = join(dir, "input.json");
      writeFileSync(
        input,
        JSON.stringify({
          parentLabels: [],
          children: [{ state: { name: "Done", type: "completed" } }],
        }),
      );
      const r = spawnSync(
        process.execPath,
        [
          join(import.meta.dir, "../scripts/reconcile_parent_status.ts"),
          "--input",
          input,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, JIG_OVERLAY: overlay, JIG_USER_LAYER: "off" },
        },
      );
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).parentState).toBe("in_review");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
