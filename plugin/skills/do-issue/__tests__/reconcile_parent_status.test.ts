/**
 * reconcile_parent_status.test.ts — unit coverage for the Step 5a
 * parent-status decision (SKILL.md "Update parent status"), extracted into
 * `reconcileParentStatus` so the state rules — pagination-fed completeness,
 * the least-advanced-child rule, the `manual-ops` cap, and the
 * extract-and-close eligibility check — have a callsite to test against
 * instead of living only as inline pseudocode an agent hand-executes each
 * round (the same gap `select_scout_finding.ts` closed for Step 2
 * in PR #4535).
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  isReconcileInputShape,
  positiveIntEnv,
  type ReconcileChildInput,
  type ReconcileInput,
  reconcileParentStatus,
} from "../scripts/reconcile_parent_status.ts";
import { DEFAULT_VOCABULARY } from "../scripts/reconcile_parent_status.ts";
import { parseTrackerLabels } from "../../resolve-review-comments/scripts/lib/tracker-labels.ts";
import { classifyChildState, issueResult } from "../scripts/get_issue.ts";

// `opts.labels` defaults to `[]`, not `undefined`. The two now decide the
// same way for extract-and-close eligibility (both read as "no tail label" —
// see the "unreadable child labels" describe block below for why treating
// them alike is deliberate and safe), but every existing call site here
// means "this child genuinely has none", so it gets the "confirmed empty"
// shape by default; a test that specifically wants the "missing key" shape
// constructs its child literally instead of through this helper.
function child(
  name: string,
  opts: { type?: string; labels?: ReconcileChildInput["labels"] } = {},
): ReconcileChildInput {
  return { state: { name, type: opts.type }, labels: opts.labels ?? [] };
}

describe("reconcileParentStatus", () => {
  describe("failed or incomplete listing (fail closed)", () => {
    it("refuses to decide when the listing/fetch failed", () => {
      const r = reconcileParentStatus({
        found: false,
        parentLabels: [],
        children: [child("Done", { type: "completed" })],
      });
      expect(r).toEqual({
        verdict: "listing_failed",
        parentState: null,
        parentStateName: null,
        reason: expect.stringContaining("listing failed"),
      });
    });

    it("refuses to decide when pagination did not confirm completeness", () => {
      const r = reconcileParentStatus({
        truncated: true,
        parentLabels: [],
        children: [child("Done", { type: "completed" })],
      });
      expect(r.verdict).toBe("listing_failed");
      expect(r.reason).toContain("incomplete");
    });

    it("found: false wins even if every child looks Done — never reads a failed fetch as vacuously complete", () => {
      const r = reconcileParentStatus({
        found: false,
        parentLabels: ["manual-ops"],
        children: [],
      });
      expect(r.verdict).toBe("listing_failed");
    });
  });

  // `linear issue view --json`'s own `children` connection never carries a
  // per-child `labels` field at all (measured against real linear-cli 2.6.0
  // output — see `reconcileParentStatus`'s own comment above
  // `allIncompleteAreExtractable`), so a still-open child with no readable
  // `labels` is the CLI transport's ordinary case, not a partial fetch. An
  // earlier round failed the whole listing closed here instead
  // (docomply-review round 5, a reference-implementation pull request); reverting to that treats every
  // CLI-transport epic with an open sub-issue as permanently unreadable,
  // which round 8's review caught. These pin the corrected behavior:
  // unreadable-or-missing child labels default to "no tail label" exactly
  // like a confirmed-empty array, never to `listing_failed`.
  describe('unreadable child labels default to "no tail", never to listing_failed', () => {
    it("a still-open child with no `labels` key at all keeps the parent in progress", () => {
      // Constructed literally (not via the `child()` helper) to model the
      // CLI transport's actual shape: the `labels` key is absent, not `[]`.
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [{ state: { name: "Todo", type: "unstarted" } }],
      });
      expect(r.verdict).toBe("keep_in_progress");
    });

    it("a confirmed-empty labels array on an incomplete child decides the same way as a missing key", () => {
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [{ state: { name: "Todo", type: "unstarted" }, labels: [] }],
      });
      expect(r.verdict).toBe("keep_in_progress");
    });

    it("a child with unreadable labels among otherwise-extractable siblings blocks extract-and-close rather than wrongly granting it", () => {
      // If unreadable labels defaulted to a tail match instead of "no tail",
      // this would wrongly reach `extract_and_close_eligible`. Defaulting to
      // "no tail" is the safe direction: it only ever costs an extraction,
      // never grants one it shouldn't.
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [
          child("Todo", { type: "unstarted", labels: ["pr-followup"] }),
          { state: { name: "Todo", type: "unstarted" } }, // labels unreadable
        ],
      });
      expect(r.verdict).toBe("keep_in_progress");
    });
  });

  describe("all sub-issues Done (or Canceled/Duplicate)", () => {
    it("sets Done when the parent has no manual-ops label", () => {
      const r = reconcileParentStatus({
        parentLabels: ["chore"],
        children: [
          child("Done", { type: "completed" }),
          child("Done", { type: "completed" }),
        ],
      });
      expect(r).toEqual({
        verdict: "set_status",
        parentState: "done",
        parentStateName: "Done",
        reason: expect.stringContaining("All sub-issues are Done"),
      });
    });

    it("caps at Ops Pending when the parent carries manual-ops", () => {
      const r = reconcileParentStatus({
        parentLabels: ["manual-ops"],
        children: [child("Done", { type: "completed" })],
      });
      expect(r.verdict).toBe("set_status");
      expect(r.parentState).toBe("ops_pending");
    });

    it("treats Canceled/Duplicate children as terminal, not incomplete — still resolves to Done", () => {
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [
          child("Done", { type: "completed" }),
          child("Canceled", { type: "canceled" }),
          child("Duplicate", { type: "duplicate" }),
        ],
      });
      expect(r).toMatchObject({ verdict: "set_status", parentState: "done" });
    });

    it("an empty children array (no sub-issues) is vacuously all-done", () => {
      const r = reconcileParentStatus({ parentLabels: [], children: [] });
      expect(r).toMatchObject({ verdict: "set_status", parentState: "done" });
    });

    it("accepts parent/child labels as {name} objects, not just strings", () => {
      const r = reconcileParentStatus({
        parentLabels: [{ name: "manual-ops" }],
        children: [child("Done", { type: "completed" })],
      });
      expect(r.parentState).toBe("ops_pending");
    });
  });

  describe("any sub-issue still active", () => {
    it("keeps the parent in progress when a child is still In Progress", () => {
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [
          child("Done", { type: "completed" }),
          child("In Progress", { type: "started" }),
        ],
      });
      expect(r).toEqual({
        verdict: "keep_in_progress",
        parentState: null,
        parentStateName: null,
        reason: expect.stringContaining("Step 4b"),
      });
    });

    it("keeps the parent in progress when a child is still in an unstarted/backlog state", () => {
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [child("Todo", { type: "unstarted" })],
      });
      expect(r.verdict).toBe("keep_in_progress");
    });
  });

  describe("least-advanced child rule (merged-and-parked, not all Done)", () => {
    it('caps the parent at "In Review" when a child is In Review and another is Ops Pending', () => {
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [
          child("In Review", { type: "started" }),
          child("Ops Pending", { type: "started" }),
        ],
      });
      expect(r).toEqual({
        verdict: "set_status",
        parentState: "in_review",
        parentStateName: "In Review",
        reason: expect.stringContaining("In Review"),
      });
    });

    it('caps the parent at "Ops Pending" when every open child is Ops Pending or Done', () => {
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [
          child("Done", { type: "completed" }),
          child("Ops Pending", { type: "started" }),
        ],
      });
      expect(r).toMatchObject({
        verdict: "set_status",
        parentState: "ops_pending",
      });
    });

    it('Canceled/Duplicate children fall out of the ladder and never win as "least advanced"', () => {
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [
          child("Canceled", { type: "canceled" }),
          child("Ops Pending", { type: "started" }),
        ],
      });
      expect(r).toMatchObject({
        verdict: "set_status",
        parentState: "ops_pending",
      });
    });
  });

  describe("extract-and-close eligibility", () => {
    it("is eligible when every incomplete child carries an extractable tail label", () => {
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [
          child("Done", { type: "completed" }),
          child("Todo", { type: "unstarted", labels: ["pr-followup"] }),
        ],
      });
      expect(r).toEqual({
        verdict: "extract_and_close_eligible",
        parentState: null,
        parentStateName: null,
        reason: expect.stringContaining("epic-acceptance-review"),
      });
    });

    it("accepts any of the four tail labels", () => {
      for (const tail of [
        "hitl:legal",
        "manual-ops",
        "hitl:tactical",
        "pr-followup",
      ]) {
        const r = reconcileParentStatus({
          parentLabels: [],
          children: [child("Todo", { type: "unstarted", labels: [tail] })],
        });
        expect(r.verdict).toBe("extract_and_close_eligible");
      }
    });

    it("is NOT eligible when only some incomplete children carry a tail label", () => {
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [
          child("Todo", { type: "unstarted", labels: ["pr-followup"] }),
          child("Todo", { type: "unstarted" }), // no tail label
        ],
      });
      expect(r.verdict).toBe("keep_in_progress");
    });

    it("is NOT eligible when there are no incomplete children at all (vacuous guard)", () => {
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [child("Done", { type: "completed" })],
      });
      expect(r.verdict).toBe("set_status");
    });

    it('takes precedence over the merged-or-parked guard (an extractable tail is never "merged-and-parked")', () => {
      const r = reconcileParentStatus({
        parentLabels: ["manual-ops"],
        children: [
          child("In Review", { type: "started", labels: ["hitl:legal"] }),
        ],
      });
      // A single child bucketed "incomplete" by `classifyChildState` (its
      // `type: 'started'` doesn't resolve to completed/abandoned) carrying a
      // tail label is still eligible — the eligibility check runs before,
      // and independently of, the merged-or-parked computation, regardless
      // of whether "In Review" would itself separately count as
      // merged-and-parked.
      expect(r.verdict).toBe("extract_and_close_eligible");
    });

    it("accepts tail labels as {name} objects, not just strings", () => {
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [
          child("Todo", {
            type: "unstarted",
            labels: [{ name: "pr-followup" }],
          }),
        ],
      });
      expect(r.verdict).toBe("extract_and_close_eligible");
    });

    it("warns about sweep-epic.ts's --close refusal when the PARENT itself carries manual-ops", () => {
      // sweep-epic.ts refuses `--close` outright on a manual-ops epic — the
      // reason must say so, since the plain reading of this verdict ("run
      // sweep-epic.ts") would otherwise dispatch a call that guard rejects.
      const r = reconcileParentStatus({
        parentLabels: ["manual-ops"],
        children: [
          child("Todo", { type: "unstarted", labels: ["pr-followup"] }),
        ],
      });
      expect(r.verdict).toBe("extract_and_close_eligible");
      expect(r.reason).toContain("--no-close");
    });

    it("does not warn about --no-close when the parent has no manual-ops label", () => {
      const r = reconcileParentStatus({
        parentLabels: ["chore"],
        children: [
          child("Todo", { type: "unstarted", labels: ["pr-followup"] }),
        ],
      });
      expect(r.reason).not.toContain("--no-close");
    });
  });

  describe("state classification falls back to name-matching when type is absent (linear-cli transport)", () => {
    it('classifies an untyped "Done"-ish name as completed', () => {
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [{ state: { name: "Done" } }],
      });
      expect(r).toMatchObject({ verdict: "set_status", parentState: "done" });
    });

    it('classifies an untyped "Canceled" name as abandoned, not incomplete', () => {
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [{ state: { name: "Canceled" } }],
      });
      expect(r).toMatchObject({ verdict: "set_status", parentState: "done" });
    });
  });

  describe("allDone/allMergedOrParked/ladder classification stay consistent", () => {
    it('a name-matched-but-unlisted "Closed" child (bucket completed) still resolves to Done, not keep_in_progress', () => {
      // `classifyChildState` buckets "Closed" as completed via its
      // name-substring fallback, but the exact string "Closed" was never in
      // the old raw-name `MERGED_OR_PARKED` list — that mismatch used to
      // make `allMergedOrParked` false for a child `allDone` already
      // considers done.
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [{ state: { name: "Closed" } }],
      });
      expect(r).toMatchObject({ verdict: "set_status", parentState: "done" });
    });

    it('a type-contradicting child ({ name: "Done", type: "started" }) keeps the parent in progress instead of returning an undefined parentState', () => {
      // Old bug: `allMergedOrParked` read the raw name "Done" as parked (it
      // was in the old list), but `classifyChildState` buckets this child
      // "incomplete" because `type: "started"` wins over the name. That
      // combination reached `!allDone` with `ladderIndexes` empty (`"Done"`
      // is not in STATE_LADDER), so `parentState` came back `undefined` and
      // was silently dropped from the JSON output instead of resolving to a
      // real `ParentState`.
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [child("Done", { type: "started" })],
      });
      expect(r.verdict).toBe("keep_in_progress");
      expect(r.parentState).toBeNull();
    });

    it('mixes a "Closed"-bucket-completed child with a genuine "Ops Pending" child and caps at Ops Pending', () => {
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [
          { state: { name: "Closed" } },
          child("Ops Pending", { type: "started" }),
        ],
      });
      expect(r).toMatchObject({
        verdict: "set_status",
        parentState: "ops_pending",
      });
    });

    it('a completed child name-contradicting as "In Progress" does not out-vote a genuine "Ops Pending" child on the ladder', () => {
      // `type: 'completed'` wins the bucket over the name — this child is
      // actually done — but its exact name still matches STATE_LADDER's
      // "In Progress" rung. The ladder must not consider it at all.
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [
          child("In Progress", { type: "completed" }),
          child("Ops Pending", { type: "started" }),
        ],
      });
      expect(r).toMatchObject({
        verdict: "set_status",
        parentState: "ops_pending",
      });
    });

    it('an abandoned child name-contradicting as "In Review" does not out-vote a genuine "Ops Pending" child on the ladder', () => {
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [
          child("In Review", { type: "canceled" }),
          child("Ops Pending", { type: "started" }),
        ],
      });
      expect(r).toMatchObject({
        verdict: "set_status",
        parentState: "ops_pending",
      });
    });

    it('a recognized non-"started" type must not let its name pass as parked-active: "In Review" named but "unstarted" typed keeps the parent in progress', () => {
      // `unstarted` (the `todo` state category) is a KNOWN, recognized
      // type — it must win over the exact name "In Review", which would
      // otherwise let this look "merged and parked" when the type says the
      // work hasn't even started.
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [child("In Review", { type: "unstarted" })],
      });
      expect(r.verdict).toBe("keep_in_progress");
    });

    it('the same guard applies to "Ops Pending" named but "backlog"/"triage" typed children', () => {
      for (const type of ["backlog", "triage"]) {
        const r = reconcileParentStatus({
          parentLabels: [],
          children: [child("Ops Pending", { type })],
        });
        expect(r.verdict).toBe("keep_in_progress");
      }
    });

    it('an UNTYPED "In Review"/"Ops Pending" name still falls back to parked-active (no recognized type to contradict it)', () => {
      // Mirrors `classifyChildState`'s own precedence: an absent/unrecognized
      // type defers to the name, it doesn't refuse it outright.
      const r = reconcileParentStatus({
        parentLabels: [],
        children: [
          { state: { name: "In Review" }, labels: [] },
          { state: { name: "Ops Pending" }, labels: [] },
        ],
      });
      expect(r).toMatchObject({
        verdict: "set_status",
        parentState: "in_review",
      });
    });
  });
});

describe("isReconcileInputShape", () => {
  const valid: ReconcileInput = {
    parentLabels: ["manual-ops"],
    children: [
      { state: { name: "Done", type: "completed" }, labels: ["pr-followup"] },
    ],
  };

  it("accepts a well-formed input, with and without the optional flags", () => {
    expect(isReconcileInputShape(valid)).toBe(true);
    expect(isReconcileInputShape({ ...valid, found: false })).toBe(true);
    expect(isReconcileInputShape({ ...valid, truncated: true })).toBe(true);
  });

  it("accepts an empty children array and empty parentLabels", () => {
    expect(isReconcileInputShape({ parentLabels: [], children: [] })).toBe(
      true,
    );
  });

  it("rejects null, non-objects, and arrays", () => {
    expect(isReconcileInputShape(null)).toBe(false);
    expect(isReconcileInputShape(7)).toBe(false);
    expect(isReconcileInputShape("x")).toBe(false);
    expect(isReconcileInputShape([])).toBe(false);
  });

  it("rejects a missing parentLabels or children", () => {
    expect(isReconcileInputShape({ children: [] })).toBe(false);
    expect(isReconcileInputShape({ parentLabels: [] })).toBe(false);
  });

  it("rejects a non-boolean found/truncated", () => {
    expect(isReconcileInputShape({ ...valid, found: "yes" })).toBe(false);
    expect(isReconcileInputShape({ ...valid, truncated: 1 })).toBe(false);
  });

  it("rejects a child with a malformed state", () => {
    expect(
      isReconcileInputShape({
        parentLabels: [],
        children: [{ state: { name: 7 } }],
      }),
    ).toBe(false);
  });

  it('rejects a child with NO state field at all — a readable-but-absent state must not silently default to "incomplete"', () => {
    // Without this, classifyChildState(undefined) === 'incomplete', and a
    // tail-labeled child with genuinely unknown state would still drive an
    // extract_and_close_eligible verdict.
    expect(
      isReconcileInputShape({
        parentLabels: [],
        children: [{ labels: ["pr-followup"] }],
      }),
    ).toBe(false);
  });

  it("rejects a child with a present-but-EMPTY state ({}) — same unreadable-state gap, one variant later", () => {
    // isState({}) passes (both fields are optional), so the presence-only
    // check above is not enough on its own — the state must also carry at
    // least one non-empty name/type.
    expect(
      isReconcileInputShape({
        parentLabels: [],
        children: [{ state: {}, labels: ["pr-followup"] }],
      }),
    ).toBe(false);
  });

  it("rejects a child whose state has empty-string name AND type — same gap, not just an absent field", () => {
    expect(
      isReconcileInputShape({
        parentLabels: [],
        children: [{ state: { name: "", type: "" }, labels: ["pr-followup"] }],
      }),
    ).toBe(false);
  });

  // Regression for docomply-review round 18, a reference-implementation pull request: a non-empty `type`
  // string alone isn't proof of a readable state. `'unknown'` is
  // get_issue.ts's OWN sentinel for "the type itself was unreadable" — never
  // a real Linear state type — so a blank name paired with it must still be
  // rejected, not accepted merely because `type.length > 0`.
  it('rejects a child whose state has a blank name and the "unknown" sentinel type', () => {
    expect(
      isReconcileInputShape({
        parentLabels: [],
        children: [
          { state: { name: "", type: "unknown" }, labels: ["pr-followup"] },
        ],
      }),
    ).toBe(false);
  });

  it("accepts a recognized type with a blank name (type alone is sufficient when it is a REAL type)", () => {
    expect(
      isReconcileInputShape({
        parentLabels: [],
        children: [{ state: { name: "", type: "completed" } }],
      }),
    ).toBe(true);
  });

  // Regression for docomply-review round 19, a reference-implementation pull request: `get_issue.ts` emits
  // `{ name: 'Unknown', type: 'unknown' }` — a DIFFERENT sentinel than round
  // 18's blank-name variant — when BOTH state fields are absent. `'Unknown'`
  // is itself a non-empty string, so the name-non-blank branch alone
  // wrongly accepted it despite being the exact pair SKILL.md's own
  // `isUnreadableState` treats as unreadable.
  it('rejects a child whose state is the full {name: "Unknown", type: "unknown"} sentinel', () => {
    expect(
      isReconcileInputShape({
        parentLabels: [],
        children: [
          {
            state: { name: "Unknown", type: "unknown" },
            labels: ["pr-followup"],
          },
        ],
      }),
    ).toBe(false);
  });

  it('still accepts a genuine state literally named "Unknown" paired with a recognized type', () => {
    // The sentinel rejection is keyed on the EXACT pair, not on the name
    // alone — an unlikely but possible real state named "Unknown" with a
    // real, recognized type must not be rejected on the name coincidence.
    expect(
      isReconcileInputShape({
        parentLabels: [],
        children: [{ state: { name: "Unknown", type: "completed" } }],
      }),
    ).toBe(true);
  });

  it("rejects a child whose labels are not strings or {name} objects", () => {
    expect(
      isReconcileInputShape({
        parentLabels: [],
        children: [{ state: { name: "Done" }, labels: [7] }],
      }),
    ).toBe(false);
  });

  it("rejects a parentLabels entry that is neither a string nor a {name} object", () => {
    expect(isReconcileInputShape({ parentLabels: [7], children: [] })).toBe(
      false,
    );
  });

  it('rejects a nameless {} label object — both transports always supply `name`, so this is unreadable, not "no label"', () => {
    expect(isReconcileInputShape({ parentLabels: [{}], children: [] })).toBe(
      false,
    );
    expect(
      isReconcileInputShape({
        parentLabels: [],
        children: [{ state: { name: "Done" }, labels: [{}] }],
      }),
    ).toBe(false);
  });
});

const SCRIPTS = join(import.meta.dir, "..", "scripts");

// Same GIT_ scrub as scripts.test.ts — no git subprocess runs here today, but
// every spawn in this suite goes through it for the same reason: a leaked
// GIT_DIR/GIT_WORK_TREE from a git hook must never reach a probe-controlled
// child process.
function gitCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || v === undefined) continue;
    env[k] = v;
  }
  return env;
}

describe("reconcile_parent_status.ts (CLI entrypoint)", () => {
  const run = (
    stdin: string,
    args: string[] = [],
    extraEnv: Record<string, string> = {},
  ) =>
    spawnSync(
      process.execPath,
      [join(SCRIPTS, "reconcile_parent_status.ts"), ...args],
      {
        encoding: "utf8",
        input: stdin,
        env: { ...gitCleanEnv(), ...extraEnv },
      },
    );

  it("decides from stdin JSON and exits 0", () => {
    const r = run(
      JSON.stringify({
        parentLabels: [],
        children: [{ state: { name: "Done", type: "completed" } }],
      }),
    );
    expect({ status: r.status, stderr: r.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    expect(JSON.parse(r.stdout)).toEqual({
      verdict: "set_status",
      parentState: "done",
      parentStateName: "Done",
      reason: expect.stringContaining("All sub-issues are Done"),
    });
  });

  it("refuses to decide without the consumer overlay", () => {
    const r = run(
      JSON.stringify({
        parentLabels: ["manual-ops"],
        children: [{ state: { name: "Done", type: "completed" } }],
      }),
      [],
      { GROUNDWORK_OVERLAY: join(SCRIPTS, "no-such-overlay.yaml") },
    );
    expect({ status: r.status, stdout: r.stdout }).toEqual({
      status: 1,
      stdout: "",
    });
    expect(r.stderr).toContain("Groundwork configuration not found");
  });

  it("rejects a stray positional argument (this script takes none)", () => {
    const r = run("{}", ["extra"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("expected no positional argument, got 1");
  });

  it("rejects unreadable JSON on stdin", () => {
    const r = run("not json");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not valid JSON");
  });

  it("rejects JSON of the wrong shape", () => {
    const r = run(JSON.stringify({ children: [] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not a valid ReconcileInput");
  });

  // Bounds added for docomply-review round 9, a reference-implementation pull request: `readStdin` used to
  // accumulate every chunk with no size cap and await EOF with no deadline —
  // both env-overridable purely so these two tests don't need a real 10MB
  // payload or a real 30s wait.
  it("rejects stdin larger than the configured byte cap", () => {
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, "reconcile_parent_status.ts")],
      {
        encoding: "utf8",
        input: "x".repeat(1000),
        env: { ...gitCleanEnv(), RECONCILE_MAX_STDIN_BYTES: "100" },
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("failed to read stdin");
    expect(r.stderr).toContain("exceeded 100 bytes");
  });

  it("rejects a stalled stdin that never reaches the read deadline", async () => {
    const proc = Bun.spawn(
      [process.execPath, join(SCRIPTS, "reconcile_parent_status.ts")],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...gitCleanEnv(), RECONCILE_STDIN_TIMEOUT_MS: "50" },
      },
    );
    // Deliberately never closed: a stalled producer never sends EOF, so the
    // script must give up on its own deadline rather than hang waiting for
    // one.
    proc.stdin.write('{"partial": true');
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("failed to read stdin");
    expect(stderr).toContain("exceeded 50ms");
  });

  // Regression for coderabbitai, PR #5024: `Number('abc')` is `NaN`, and
  // Node coerces a `NaN` `setTimeout` delay to ~1ms — a typo'd override used
  // to make every run fail almost instantly, even a normal, non-stalled one.
  // A well-formed, promptly-closed stdin must still succeed under an invalid
  // override, proving it fell back to the real 30s default and not to ~1ms.
  it("falls back to the real timeout default on an invalid override, not ~1ms", () => {
    const r = run(
      JSON.stringify({
        parentLabels: [],
        children: [{ state: { name: "Done", type: "completed" } }],
      }),
      [],
      { RECONCILE_STDIN_TIMEOUT_MS: "abc" },
    );
    expect({ status: r.status, stderr: r.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
  });
});

describe("positiveIntEnv", () => {
  const FALLBACK = 30_000;

  it("uses the fallback when the env var is unset", () => {
    expect(positiveIntEnv("DOES_NOT_EXIST_XYZ", FALLBACK)).toBe(FALLBACK);
  });

  it("parses a valid positive integer string", () => {
    process.env.RECONCILE_TEST_ENV_VAR = "42";
    try {
      expect(positiveIntEnv("RECONCILE_TEST_ENV_VAR", FALLBACK)).toBe(42);
    } finally {
      delete process.env.RECONCILE_TEST_ENV_VAR;
    }
  });

  // Regression for coderabbitai, PR #5024: a non-numeric override must fall
  // back, not silently become NaN (which disables a `>` bound entirely and
  // coerces a setTimeout delay to ~1ms).
  for (const bad of ["abc", "", "12.5", "-3", "0", "NaN", "Infinity"]) {
    it(`falls back to the default on an invalid override (${JSON.stringify(bad)})`, () => {
      process.env.RECONCILE_TEST_ENV_VAR = bad;
      try {
        expect(positiveIntEnv("RECONCILE_TEST_ENV_VAR", FALLBACK)).toBe(
          FALLBACK,
        );
      } finally {
        delete process.env.RECONCILE_TEST_ENV_VAR;
      }
    });
  }

  // Regression for docomply-review round 19, a reference-implementation pull request: `Number.isInteger`
  // is `true` for ANY finite whole number regardless of magnitude
  // (`Number.isInteger(1e100)` is `true`), so a huge-but-integer override
  // passed the positive-integer check yet effectively disabled whatever
  // bound it was meant to enforce. Asserted directly on the return value —
  // not via a subprocess timing race — because a prior round's equivalent
  // subprocess-based test could pass even with the clamp removed, if the
  // read happened to finish before the malformed timer fired (docomply-
  // review round 19, PR #5024).
  //
  // These bounds are protective ceilings against a misconfiguration, not a
  // "use as much as is allowed" request — round 19's first fix CLAMPED an
  // over-`max` value to `max` instead of falling back, which for a timeout
  // meant a clearly-mistaken huge override became Node's ~24.8-day setTimeout
  // ceiling instead of the intended 30-second default (the opposite of a
  // safety bound). Round 20 corrected this to fall back to `fallback`, same
  // as any other invalid override (docomply-review round 20, a reference-implementation pull request).
  it("falls back to fallback (not a clamped max) when the override exceeds max", () => {
    process.env.RECONCILE_TEST_ENV_VAR = "1e100";
    try {
      expect(positiveIntEnv("RECONCILE_TEST_ENV_VAR", FALLBACK, 1000)).toBe(
        FALLBACK,
      );
    } finally {
      delete process.env.RECONCILE_TEST_ENV_VAR;
    }
  });

  it("falls back to fallback for an override one past max", () => {
    process.env.RECONCILE_TEST_ENV_VAR = "1001";
    try {
      expect(positiveIntEnv("RECONCILE_TEST_ENV_VAR", FALLBACK, 1000)).toBe(
        FALLBACK,
      );
    } finally {
      delete process.env.RECONCILE_TEST_ENV_VAR;
    }
  });

  it("accepts an override exactly at max", () => {
    process.env.RECONCILE_TEST_ENV_VAR = "1000";
    try {
      expect(positiveIntEnv("RECONCILE_TEST_ENV_VAR", FALLBACK, 1000)).toBe(
        1000,
      );
    } finally {
      delete process.env.RECONCILE_TEST_ENV_VAR;
    }
  });

  it("is unbounded when max is omitted, even for a huge value", () => {
    process.env.RECONCILE_TEST_ENV_VAR = "999999999999";
    try {
      expect(positiveIntEnv("RECONCILE_TEST_ENV_VAR", FALLBACK)).toBe(
        999999999999,
      );
    } finally {
      delete process.env.RECONCILE_TEST_ENV_VAR;
    }
  });

  it("still falls back to the default on an invalid override even when max is given", () => {
    process.env.RECONCILE_TEST_ENV_VAR = "abc";
    try {
      expect(positiveIntEnv("RECONCILE_TEST_ENV_VAR", FALLBACK, 1000)).toBe(
        FALLBACK,
      );
    } finally {
      delete process.env.RECONCILE_TEST_ENV_VAR;
    }
  });
});

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
