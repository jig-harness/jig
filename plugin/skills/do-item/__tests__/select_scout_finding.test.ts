/**
 * select_scout_finding.test.ts — unit coverage for the Step 2 freshness
 * procedure (SKILL.md "Check for Prior Scout Findings"), extracted into
 * `selectScoutFinding` precisely so these branches have a callsite to test
 * against instead of living only as prose an agent hand-executes each round
 * (docomply-review, a reference-implementation pull request round 4: "no test exercises it... changes that
 * mishandle multiple comments, future/malformed timestamps, the exact-24-hour
 * boundary, or same-hash reuse can remain green").
 */

import { describe, expect, it } from "bun:test";
import {
  isScoutFindingsCommentShape,
  type ScoutFindingsComment,
  selectScoutFinding,
} from "../scripts/select_scout_finding.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-03T12:00:00.000Z");

function finding(
  hash: string,
  extra: Partial<ScoutFindingsComment> = {},
): ScoutFindingsComment {
  return { body: `## Scout Findings (${hash})\n\nsome content`, ...extra };
}

describe("selectScoutFinding", () => {
  it("runs scouts when there is no findings comment at all", () => {
    const r = selectScoutFinding([], "abc1234", NOW);
    expect(r).toEqual({
      action: "run",
      selectedIndex: null,
      selectedHash: null,
      reason: "No findings comment",
    });
  });

  it("ignores comments that are not a Scout Findings heading", () => {
    const r = selectScoutFinding(
      [{ body: "unrelated comment", created_at: new Date(NOW).toISOString() }],
      "abc1234",
      NOW,
    );
    expect(r.action).toBe("run");
    expect(r.selectedIndex).toBeNull();
  });

  it("reuses when the stored hash matches the current hash, even if stale", () => {
    const stale = new Date(NOW - 48 * HOUR).toISOString();
    const r = selectScoutFinding(
      [finding("abc1234", { created_at: stale })],
      "abc1234",
      NOW,
    );
    expect(r.action).toBe("reuse");
    expect(r.reason).toContain("hash abc1234 matches current abc1234");
  });

  it("matches hashes case-insensitively and across differing short-hash lengths", () => {
    const stale = new Date(NOW - 48 * HOUR).toISOString();
    const r1 = selectScoutFinding(
      [finding("ABC1234", { created_at: stale })],
      "abc1234deadbeef",
      NOW,
    );
    expect(r1.action).toBe("reuse");
    const r2 = selectScoutFinding(
      [finding("abc1234deadbeef", { created_at: stale })],
      "ABC1234",
      NOW,
    );
    expect(r2.action).toBe("reuse");
  });

  it("reuses on a different hash when the timestamp is fresh (< 24h)", () => {
    const fresh = new Date(NOW - 1 * HOUR).toISOString();
    const r = selectScoutFinding(
      [finding("deadbee", { created_at: fresh })],
      "abc1234",
      NOW,
    );
    expect(r.action).toBe("reuse");
    expect(r.reason).toContain("fresh");
  });

  it("re-runs on a different hash when the timestamp is stale (>= 24h)", () => {
    const stale = new Date(NOW - 25 * HOUR).toISOString();
    const r = selectScoutFinding(
      [finding("deadbee", { created_at: stale })],
      "abc1234",
      NOW,
    );
    expect(r.action).toBe("rerun");
    expect(r.selectedHash).toBe("deadbee");
  });

  it("treats exactly 24h old as stale, not fresh (boundary is inclusive of staleness)", () => {
    const exactly24h = new Date(NOW - 24 * HOUR).toISOString();
    const r = selectScoutFinding(
      [finding("deadbee", { created_at: exactly24h })],
      "abc1234",
      NOW,
    );
    expect(r.action).toBe("rerun");
  });

  it("treats a timestamp 1ms under 24h as fresh", () => {
    const justUnder24h = new Date(NOW - 24 * HOUR + 1).toISOString();
    const r = selectScoutFinding(
      [finding("deadbee", { created_at: justUnder24h })],
      "abc1234",
      NOW,
    );
    expect(r.action).toBe("reuse");
  });

  it("accepts snake_case created_at from the cache path", () => {
    const fresh = new Date(NOW - 1 * HOUR).toISOString();
    const r = selectScoutFinding(
      [finding("deadbee", { created_at: fresh })],
      "abc1234",
      NOW,
    );
    expect(r.action).toBe("reuse");
  });

  it("accepts camelCase createdAt from list_comments", () => {
    const fresh = new Date(NOW - 1 * HOUR).toISOString();
    const r = selectScoutFinding(
      [finding("deadbee", { createdAt: fresh })],
      "abc1234",
      NOW,
    );
    expect(r.action).toBe("reuse");
  });

  it("treats a missing timestamp as stale/oldest, not as a crash", () => {
    const r = selectScoutFinding([finding("deadbee")], "abc1234", NOW);
    expect(r.action).toBe("rerun");
    expect(r.reason).toContain("no parsable timestamp");
  });

  it("treats an unparsable timestamp as stale/oldest", () => {
    const r = selectScoutFinding(
      [finding("deadbee", { created_at: "not-a-date" })],
      "abc1234",
      NOW,
    );
    expect(r.action).toBe("rerun");
  });

  it("treats a future timestamp as stale, not as negative age", () => {
    const future = new Date(NOW + 10 * HOUR).toISOString();
    const r = selectScoutFinding(
      [finding("deadbee", { created_at: future })],
      "abc1234",
      NOW,
    );
    expect(r.action).toBe("rerun");
  });

  it("selects the newest of several findings comments by timestamp, mixing field names", () => {
    const oldest = finding("1111", {
      created_at: new Date(NOW - 72 * HOUR).toISOString(),
    });
    const newest = finding("3333", {
      createdAt: new Date(NOW - 1 * HOUR).toISOString(),
    });
    const middle = finding("2222", {
      created_at: new Date(NOW - 30 * HOUR).toISOString(),
    });
    const r = selectScoutFinding([oldest, newest, middle], "abc1234", NOW);
    expect(r.selectedIndex).toBe(1);
    expect(r.selectedHash).toBe("3333");
    expect(r.action).toBe("reuse"); // fresh
  });

  it("does not let an older, validly-timestamped comment win over a newer one with a future timestamp", () => {
    // Regression for chatgpt-codex-connector, a reference-implementation pull request round 10: sorting by
    // freshness-ms (which nulls future timestamps to -Infinity) demoted the
    // actually-newest comment below an older, genuinely fresh one, so the
    // older comment's stale findings were wrongly reused.
    const older = finding("1111", {
      created_at: new Date(NOW - 1 * HOUR).toISOString(), // valid, fresh
    });
    const newest = finding("2222", {
      created_at: new Date(NOW + 10 * HOUR).toISOString(), // posted last, clock-skewed
    });
    const r = selectScoutFinding([older, newest], "abc1234", NOW);
    expect(r.selectedIndex).toBe(1);
    expect(r.selectedHash).toBe("2222");
    expect(r.action).toBe("rerun");
  });

  it("re-runs rather than reusing a fresh dated comment when another comment has no parsable timestamp", () => {
    // Regression for chatgpt-codex-connector, a reference-implementation pull request round 11: a comment
    // with no orderable timestamp always loses the sort to any dated
    // candidate, even when it is actually the most recently posted one — so
    // reusing purely on the dated candidate's own freshness could resurrect
    // stale findings over a genuinely newer, malformed-timestamp comment.
    const dated = finding("1111", {
      created_at: new Date(NOW - 1 * HOUR).toISOString(), // fresh, but maybe not newest
    });
    const unorderable = finding("2222", { created_at: "not-a-date" });
    const r = selectScoutFinding([dated, unorderable], "abc1234", NOW);
    expect(r.action).toBe("rerun");
    expect(r.reason).toContain("no parsable timestamp");
  });

  it("still reuses a fresh dated comment on a hash match, even with an unorderable rival", () => {
    // hashSame is a content signal, independent of any candidate's timing.
    const dated = finding("abc1234", {
      created_at: new Date(NOW - 1 * HOUR).toISOString(),
    });
    const unorderable = finding("2222", { created_at: "not-a-date" });
    const r = selectScoutFinding([dated, unorderable], "abc1234", NOW);
    expect(r.action).toBe("reuse");
    expect(r.selectedHash).toBe("abc1234");
  });

  it("is deterministic when every candidate has an unparsable/missing timestamp (keeps first)", () => {
    const a = finding("1111");
    const b = finding("2222");
    const r = selectScoutFinding([a, b], "abc1234", NOW);
    expect(r.selectedIndex).toBe(0);
    expect(r.selectedHash).toBe("1111");
  });

  it("handles a Scout Findings comment whose heading carries no readable hash", () => {
    const fresh = new Date(NOW - 1 * HOUR).toISOString();
    const r = selectScoutFinding(
      [{ body: "## Scout Findings\n\nno hash in heading", created_at: fresh }],
      "abc1234",
      NOW,
    );
    expect(r.selectedHash).toBeNull();
    expect(r.action).toBe("reuse"); // still fresh even with no hash to compare
  });

  it("re-runs on no readable hash but a stale-but-parsable timestamp", () => {
    const stale = new Date(NOW - 48 * HOUR).toISOString();
    const r = selectScoutFinding(
      [{ body: "## Scout Findings\n\nno hash", created_at: stale }],
      "abc1234",
      NOW,
    );
    expect(r.action).toBe("rerun");
    expect(r.selectedHash).toBeNull();
    expect(r.reason).toContain("timestamp is stale (>= 24h)");
  });

  it("re-runs on no readable hash AND no parsable timestamp", () => {
    const r = selectScoutFinding(
      [{ body: "## Scout Findings\n\nno hash, no timestamp" }],
      "abc1234",
      NOW,
    );
    expect(r.action).toBe("rerun");
    expect(r.selectedHash).toBeNull();
    expect(r.reason).toContain(
      "no parsable timestamp and no readable hash heading",
    );
  });

  it("matches the Scout Findings heading case-insensitively", () => {
    const fresh = new Date(NOW - 1 * HOUR).toISOString();
    const r = selectScoutFinding(
      [{ body: "## scout findings (deadbee)", created_at: fresh }],
      "abc1234",
      NOW,
    );
    expect(r.action).toBe("reuse");
    expect(r.selectedHash).toBe("deadbee");
  });

  it("does not treat a short accidental prefix match as the same hash", () => {
    // 'abcd' is a genuine prefix of 'abcdef1' but is below MIN_SAFE_HASH_LEN,
    // so an unrelated stale finding must not be reused on that basis alone.
    const stale = new Date(NOW - 48 * HOUR).toISOString();
    const r = selectScoutFinding(
      [finding("abcd", { created_at: stale })],
      "abcdef1",
      NOW,
    );
    expect(r.action).toBe("rerun");
  });

  it("still matches differing short-hash lengths at or above the safe floor", () => {
    const stale = new Date(NOW - 48 * HOUR).toISOString();
    const r = selectScoutFinding(
      [finding("abcdef1", { created_at: stale })],
      "abcdef1234",
      NOW,
    );
    expect(r.action).toBe("reuse");
    expect(r.reason).toContain("hash abcdef1 matches current abcdef1234");
  });
});

describe("isScoutFindingsCommentShape", () => {
  it("accepts a comment with only body", () => {
    expect(isScoutFindingsCommentShape({ body: "text" })).toBe(true);
  });

  it("accepts a comment with a string created_at or createdAt", () => {
    expect(
      isScoutFindingsCommentShape({ body: "text", created_at: "2026-01-01" }),
    ).toBe(true);
    expect(
      isScoutFindingsCommentShape({ body: "text", createdAt: "2026-01-01" }),
    ).toBe(true);
  });

  it("rejects null, non-objects, and arrays", () => {
    expect(isScoutFindingsCommentShape(null)).toBe(false);
    expect(isScoutFindingsCommentShape(7)).toBe(false);
    expect(isScoutFindingsCommentShape("body")).toBe(false);
    expect(isScoutFindingsCommentShape([])).toBe(false);
  });

  it("rejects a missing or non-string body", () => {
    expect(isScoutFindingsCommentShape({})).toBe(false);
    expect(isScoutFindingsCommentShape({ body: 7 })).toBe(false);
  });

  it("rejects a non-string created_at or createdAt", () => {
    expect(isScoutFindingsCommentShape({ body: "text", created_at: 123 })).toBe(
      false,
    );
    expect(isScoutFindingsCommentShape({ body: "text", createdAt: 123 })).toBe(
      false,
    );
  });
});
