import { describe, expect, test } from "bun:test";
import {
  backlogHash,
  checkedRecords,
  recordBelongsToDigest,
  rearmableBySteward,
  stewardBudgetSpent,
  type BacklogMember,
} from "../lib/steward.ts";
import {
  keepStewardRun,
  markStewardEffect,
  submitStewardRecords,
  stewardRecords,
  type StewardDigest,
} from "../lib/steward.ts";
import { stewardRecurrences } from "../lib/steward-recurring.ts";
import { stateDb, closeStateDb } from "../lib/state.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("steward boundaries", () => {
  test("the backlog hash reads the members' facts, never their order", () => {
    const stalled: BacklogMember = {
      kind: "stalled",
      target: "#7",
      facts: "a",
    };
    const rearm: BacklogMember = {
      kind: "rearm",
      target: "PR #8",
      facts: "generation 1, exit 2, heartbeat h",
    };
    expect(backlogHash([stalled, rearm])).toBe(backlogHash([rearm, stalled]));
    expect(backlogHash([{ ...stalled, facts: "b" }, rearm])).not.toBe(
      backlogHash([stalled, rearm]),
    );
  });
  test("the host's rolling hourly budget allows three passes", () => {
    const now = 3_600_000;
    const runs = (n: number, ago: number) =>
      Array.from({ length: n }, (_, i) => ({ at: now - ago - i }));
    expect(stewardBudgetSpent([], now)).toBe(false);
    expect(stewardBudgetSpent(runs(2, 1_000), now)).toBe(false);
    expect(stewardBudgetSpent(runs(3, 1_000), now)).toBe(true);
    expect(stewardBudgetSpent(runs(3, 3_600_000), now)).toBe(false);
  });
  test("closed records reject arbitrary text, models and malformed payloads", () => {
    expect(
      checkedRecords([
        {
          kind: "facet",
          target: "#12",
          facet: "priority",
          value: "high",
          reason: "test",
        },
      ]).ok,
    ).toBe(false);
    expect(
      checkedRecords([
        {
          kind: "facet",
          target: "#12",
          facet: "size",
          value: 2,
          reason: "test",
        },
      ]).ok,
    ).toBe(false);
    expect(
      checkedRecords([{ kind: "constructor", reason: "invalid kind" }]).ok,
    ).toBe(false);
    expect(checkedRecords([{ kind: "send", text: "continue" }]).ok).toBe(false);
    expect(
      checkedRecords([
        {
          kind: "facet",
          target: "#12",
          facet: "model",
          value: "sol",
          reason: "test",
        },
      ]).ok,
    ).toBe(false);
    expect(
      checkedRecords([
        {
          kind: "rearm",
          target: "PR #12",
          facts: "generation 2",
          class: "transient",
          reason: "network timeout",
        },
      ]).ok,
    ).toBe(true);
  });
  test("records stay within the evidence their own digest supplied", () => {
    const digest: StewardDigest = {
      version: 1,
      repo: "example/repo",
      drives: [],
      needs: [{ target: "#12" } as never],
      queue: [{ identifier: "#34" } as never],
      passes: [],
      failures: [],
      load: null,
    };
    expect(
      recordBelongsToDigest(
        {
          kind: "need",
          target: "#12",
          act: "Reply",
          ask: "Choose",
          reason: "still needed",
        },
        digest,
      ),
    ).toBe(true);
    expect(
      recordBelongsToDigest(
        {
          kind: "need",
          target: "PR #12",
          act: "Reply",
          ask: "Choose",
          reason: "not a need",
        },
        digest,
      ),
    ).toBe(false);
    expect(
      recordBelongsToDigest(
        { kind: "order", targets: ["#34"], reason: "keep the tie together" },
        digest,
      ),
    ).toBe(true);
    expect(
      recordBelongsToDigest(
        { kind: "order", targets: ["#99"], reason: "outside the digest" },
        digest,
      ),
    ).toBe(false);
  });
  test("human stops, held work and registry parks cannot be rearmed", () => {
    const pr = {
      class: "needs-person",
      evidence: { exit: 1 },
      labels: [],
    } as never;
    expect(rearmableBySteward(pr, false)).toBe(true);
    expect(
      rearmableBySteward(
        { ...(pr as object), class: "parked" } as never,
        false,
      ),
    ).toBe(false);
    expect(
      rearmableBySteward(
        { ...(pr as object), evidence: { exit: 0, stopped: true } } as never,
        false,
      ),
    ).toBe(false);
    expect(rearmableBySteward(pr, true)).toBe(false);
  });
  test("recurrence counts executed recoveries only, within a rolling week", () => {
    const root = mkdtempSync(join(tmpdir(), "steward-recurrence-"));
    try {
      const now = Date.now();
      const digest: StewardDigest = {
        version: 1,
        repo: "example/repo",
        drives: [],
        queue: [],
        needs: [],
        passes: [],
        failures: [],
        load: null,
      };
      for (let n = 0; n < 4; n++) {
        keepStewardRun(`run-${n}`, digest, now, root);
        expect(
          submitStewardRecords(
            `run-${n}`,
            [
              {
                kind: "rearm",
                target: `PR #${n + 1}`,
                facts: `generation ${n}`,
                class: "forge-timeout",
                reason: "transient timeout",
              },
            ],
            root,
          ).ok,
        ).toBe(true);
        const record = stewardRecords(digest.repo, root)[n];
        expect(record).toBeDefined();
        if (!record) return;
        markStewardEffect(record.id, n === 3 ? "refused" : `launch-${n}`, root);
        if (n === 1)
          expect(
            stewardRecurrences(stateDb(root), digest.repo, Date.now()),
          ).toEqual([]);
      }
      expect(
        stewardRecurrences(stateDb(root), digest.repo, Date.now()),
      ).toMatchObject([{ class: "forge-timeout", rows: 3, stage: "steward" }]);
      expect(
        stewardRecurrences(stateDb(root), digest.repo, now + 8 * 86_400_000),
      ).toEqual([]);
    } finally {
      closeStateDb(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
