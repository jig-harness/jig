import { describe, expect, test } from "bun:test";
import {
  checkedRecords,
  recordBelongsToDigest,
  stewardDue,
  stewardWaits,
  rearmableBySteward,
} from "../lib/steward.ts";
import {
  digestHash,
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
  test("cadence and the rolling cap rule a run out before any digest is read", () => {
    const now = 3_600_000;
    expect(stewardWaits([], now, 1_200_000)).toBe(false);
    expect(stewardWaits([{ at: now - 1_000 }], now, 1_200_000)).toBe(true);
    expect(stewardWaits([{ at: now + 1_000 }], now, 1_200_000)).toBe(true);
    expect(stewardWaits([{ at: now - 1_300_000 }], now, 1_200_000)).toBe(false);
    expect(
      stewardWaits(
        [0, 1, 2].map((i) => ({ at: now - 1_300_000 - i })),
        now,
        1_200_000,
      ),
    ).toBe(true);
  });
  test("unchanged digest and time and rolling run cap all prevent launches", () => {
    const now = 3_600_000;
    expect(
      stewardDue("a", [{ hash: "a", at: now - 1_300_000 }], now, 1_200_000),
    ).toBe(false);
    expect(
      stewardDue("b", [{ hash: "a", at: now - 1_000 }], now, 1_200_000),
    ).toBe(false);
    expect(
      stewardDue(
        "b",
        [0, 1, 2].map((i) => ({ hash: "a", at: now - 1_300_000 - i })),
        now,
        1_200_000,
      ),
    ).toBe(false);
    expect(
      stewardDue("b", [{ hash: "a", at: now - 1_300_000 }], now, 1_200_000),
    ).toBe(true);
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
  test("elapsed drive ages and receipt framing do not change the semantic digest", () => {
    const digest: StewardDigest = {
      version: 1,
      repo: "example/repo",
      drives: [
        {
          number: 1,
          url: "",
          title: "",
          head: "head",
          class: "silent",
          why: "silent for 4 minutes",
          evidence: { heartbeatAgeMinutes: 4 },
        },
      ],
      queue: [],
      needs: [],
      passes: [],
      failures: [],
      load: null,
    };
    const later: StewardDigest = {
      ...digest,
      drives: digest.drives.map((p) => ({
        ...p,
        why: "silent for 24 minutes",
        evidence: { ...p.evidence, heartbeatAgeMinutes: 24 },
      })),
    };
    expect(digestHash(digest)).toBe(digestHash(later));
    expect(
      digestHash({
        ...later,
        drives: later.drives.map((p) => ({ ...p, class: "needs-person" })),
      }),
    ).not.toBe(digestHash(digest));
  });
});
