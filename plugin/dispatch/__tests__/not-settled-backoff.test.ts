/**
 * The machine file's `not_settled` settings pace re-arms that keep stopping
 * `NOT_SETTLED` on one head (`repeated-ends.ts`), the backoff ends early on
 * what the stop waited for (a review of the head, settled mergeability), and
 * the head's reviews are read only for a drive that waits
 * (`not-settled-reviews.ts`).
 */
import { describe, expect, it } from "bun:test";
import { ok, failed } from "../../shared/outcome.ts";
import { currentMs, isoFromMs } from "../../shared/time.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { factsOf } from "../lib/actions/drive-hold.ts";
import type { LaunchRecord, ReadRecord } from "../lib/launches.ts";
import { parseMachineConfigText } from "../lib/machine-config.ts";
import { NOT_SETTLED_DEFAULTS } from "../lib/not-settled-config.ts";
import { withHeadReviews } from "../lib/not-settled-reviews.ts";
import {
  retryWaiting,
  settleRepeatedNotSettled,
} from "../lib/repeated-ends.ts";
import type { DrivenPr } from "../lib/types.ts";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const NOT_SETTLED = DRIVE_EXIT.NOT_SETTLED;
const minutesAgo = (m: number) => isoFromMs(currentMs() - m * 60_000);

/** PR #7's ledger, stopped `NOT_SETTLED` at generation `generation`, its pull request at `HEAD`. */
function ledger(
  generation: number,
  extra: DrivenPr["evidence"] = {},
): DrivenPr {
  return {
    number: 7,
    url: "https://example.test/pull/7",
    title: "t",
    head: "feature/7",
    class: "re-armable",
    why: `stopped ${NOT_SETTLED} (not judgeable yet): re-arm on any account`,
    evidence: {
      generation,
      exit: NOT_SETTLED,
      heartbeat: `beat ${generation}`,
      headSha: HEAD,
      ...extra,
    },
  };
}

let seq = 0;

/** A re-arm of the ledger at `generation` that stopped `NOT_SETTLED` at `HEAD` `ago` minutes ago, its probe reporting `state`. */
function rearm(generation: number, ago: number, state?: string): ReadRecord {
  seq += 1;
  const createdAt = minutesAgo(ago + 1);
  const record = {
    version: 1,
    id: `20260101T0000${String(seq).padStart(2, "0")}Z-bbbbbbbb`,
    token: "t",
    action: "rearm",
    repo: "o/a",
    repoPath: "/r",
    pr: 7,
    account: "a",
    vendor: "claude",
    configDir: "/c",
    wallBackoffMs: 1,
    replaces: null,
    facts: factsOf(ledger(generation)),
    heads: `PR head ${HEAD}, branch head ${HEAD}`,
    createdAt,
    workspace: null,
    attempts: [],
    item: null,
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
  } satisfies LaunchRecord;
  const probe =
    state === undefined
      ? undefined
      : `drive.ts: status probe stopped: ${JSON.stringify({ code: NOT_SETTLED, state, reason: "waiting" })}`;
  return {
    record,
    state: {
      kind: "ended",
      exit: {
        at: minutesAgo(ago),
        code: NOT_SETTLED,
        signal: null,
        ...(probe === undefined ? {} : { context: probe }),
      },
      process: {
        hostId: "",
        host: "h",
        bootId: "b",
        pid: 1,
        start: "s",
        claimedAt: createdAt,
      },
    },
    result: null,
  };
}

describe("the not_settled settings", () => {
  const parsed = (yaml: string) =>
    parseMachineConfigText(yaml, "dispatch.yaml");

  it("default to a 15-minute backoff and a cap of 3", () => {
    const config = parsed("repositories: []\naccounts: []\n");
    expect(config.ok && config.value.notSettled).toEqual(NOT_SETTLED_DEFAULTS);
    expect(NOT_SETTLED_DEFAULTS).toEqual({
      backoffMs: 15 * 60_000,
      notifyAfter: 3,
    });
  });

  it("read a backoff and a cap, and refuse unknown keys and a cap past retention", () => {
    const config = parsed(
      "repositories: []\naccounts: []\nnot_settled:\n  backoff: 5m\n  notify_after: 5\n",
    );
    expect(config.ok && config.value.notSettled).toEqual({
      backoffMs: 5 * 60_000,
      notifyAfter: 5,
    });
    const unknown = parsed("not_settled:\n  wait: 5m\n");
    expect(unknown.ok ? "" : unknown.failure.reason).toContain(
      "not_settled has unknown key(s): wait",
    );
    const past = parsed("not_settled:\n  notify_after: 11\n");
    expect(past.ok ? "" : past.failure.reason).toContain(
      "not_settled.notify_after must be at most 10",
    );
  });

  it("set the backoff and the cap the re-arms are paced by", () => {
    const settings = { backoffMs: 60 * 60_000, notifyAfter: 2 };
    const [waiting] = settleRepeatedNotSettled(
      [ledger(2)],
      [rearm(1, 30)],
      settings,
    );
    expect(retryWaiting(waiting as DrivenPr, currentMs())).toContain(
      "re-arm 1 of 2",
    );
    const [capped] = settleRepeatedNotSettled(
      [ledger(3)],
      [rearm(1, 200), rearm(2, 100)],
      settings,
    );
    expect(capped?.class).toBe("needs-person");
  });
});

describe("a NOT_SETTLED backoff", () => {
  it("ends on a review of the head submitted after the last stop, not one before it", () => {
    const records = [rearm(1, 5, "AWAITING_REVIEWER")];
    const after = ledger(2, { headReviewedAt: minutesAgo(1) });
    const [lifted] = settleRepeatedNotSettled([after], records);
    expect(lifted?.retryAfter).toBeUndefined();
    expect(lifted?.why).toContain("a review of that head was submitted at");
    const before = ledger(2, { headReviewedAt: minutesAgo(30) });
    const [held] = settleRepeatedNotSettled([before], records);
    expect(retryWaiting(held as DrivenPr, currentMs())).toContain(
      "reporting AWAITING_REVIEWER, so it is not re-armed until",
    );
  });

  it("ends on settled mergeability after a stop on MERGEABILITY_UNKNOWN", () => {
    const records = [rearm(1, 5, "MERGEABILITY_UNKNOWN")];
    const [unknown] = settleRepeatedNotSettled(
      [ledger(2, { mergeable: "UNKNOWN" })],
      records,
    );
    expect(unknown?.why).toContain("or settled mergeability arrives");
    expect(unknown?.retryAfter).toBeDefined();
    const [settled] = settleRepeatedNotSettled(
      [ledger(2, { mergeable: "MERGEABLE" })],
      records,
    );
    expect(settled?.retryAfter).toBeUndefined();
    expect(settled?.why).toContain("settled its mergeability (MERGEABLE)");
  });

  it("names the state from the ledger when no launch recorded one", () => {
    const [held] = settleRepeatedNotSettled(
      [ledger(2, { probeState: "STALE_REVIEW" })],
      [rearm(1, 5)],
    );
    expect(held?.evidence.notSettledState).toBe("STALE_REVIEW");
  });
});

describe("the head's reviews", () => {
  it("are read only for a drive that waits, and the latest review of the head is kept", async () => {
    const asked: number[] = [];
    const latest = minutesAgo(1);
    const read = async (_slug: string, pr: number) => {
      asked.push(pr);
      return ok([
        { commit: HEAD, submittedAt: minutesAgo(3) },
        { commit: HEAD, submittedAt: latest },
        { commit: OTHER, submittedAt: minutesAgo(0) },
      ]);
    };
    const other = { ...ledger(2), number: 8 };
    const [waiting, untouched] = await withHeadReviews(
      "o/a",
      [ledger(2), other],
      [rearm(1, 5)],
      NOT_SETTLED_DEFAULTS,
      currentMs(),
      read,
    );
    expect(asked).toEqual([7]);
    expect(waiting?.evidence.headReviewedAt).toBe(latest);
    expect(untouched).toBe(other);
  });

  it("are not read once the backoff has ended, and a failed read keeps the backoff with its reason", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return failed("unreadable", "the reviews answer is not JSON");
    };
    const [ended] = await withHeadReviews(
      "o/a",
      [ledger(2)],
      [rearm(1, 60)],
      NOT_SETTLED_DEFAULTS,
      currentMs(),
      read,
    );
    expect(reads).toBe(0);
    expect(ended?.evidence.headReviewsUnread).toBeUndefined();
    const [unread] = await withHeadReviews(
      "o/a",
      [ledger(2)],
      [rearm(1, 5)],
      NOT_SETTLED_DEFAULTS,
      currentMs(),
      read,
    );
    const [held] = settleRepeatedNotSettled(
      [unread as DrivenPr],
      [rearm(1, 5)],
    );
    expect(retryWaiting(held as DrivenPr, currentMs())).toContain(
      "its head's reviews did not read this tick: the reviews answer is not JSON",
    );
  });
});
