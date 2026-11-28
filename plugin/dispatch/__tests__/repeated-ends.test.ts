/**
 * Launches of one drive that keep ending the same way are backed off and
 * capped (`repeated-ends.ts`): re-arms of a `NOT_SETTLED` ledger that stop
 * `NOT_SETTLED` again on one pull request head, while each run moves the
 * ledger, and takeovers of a silent driver this host started that fail on the
 * same ledger facts. A new head or moved ledger facts start the count again.
 */
import { describe, expect, it } from "bun:test";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { driveHold, factsOf } from "../lib/actions/drive-hold.ts";
import { latestRepeatedEnds } from "../lib/launch-keep.ts";
import { NOT_SETTLED_ENDS_KEPT } from "../lib/repeated-end-caps.ts";
import type { LaunchClaim, LaunchRecord, ReadRecord } from "../lib/launches.ts";
import { stopNotice } from "../lib/notices.ts";
import {
  FAILED_TAKEOVERS,
  NOT_SETTLED_REARMS,
  retryWaiting,
  settleFailedTakeovers,
  settleRepeatedNotSettled,
} from "../lib/repeated-ends.ts";
import { stopEvidence } from "../lib/sources/ledger-stop-evidence.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { settleOwnDrives } from "../lib/tick-shared.ts";
import type { DrivenPr } from "../lib/types.ts";
import { currentMs, isoFromMs } from "../../shared/time.ts";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const NOT_SETTLED = DRIVE_EXIT.NOT_SETTLED;

const minutesAgo = (m: number) => isoFromMs(currentMs() - m * 60_000);

function claim(claimedAt: string): LaunchClaim {
  return {
    hostId: "",
    host: "h",
    bootId: "b",
    pid: 1,
    start: "s",
    claimedAt,
  };
}

let seq = 0;

/** A drive launch of PR #7 on `facts`, which ended `code` `ago` minutes ago after running `ran` minutes. */
function launch(
  action: "rearm" | "takeover",
  facts: string,
  code: number,
  ago: number,
  over: Partial<LaunchRecord> = {},
  ran = 1,
): ReadRecord {
  seq += 1;
  const createdAt = minutesAgo(ago + ran);
  const record: LaunchRecord = {
    version: 1,
    id: `20260101T0000${String(seq).padStart(2, "0")}Z-aaaaaaaa`,
    token: "t",
    action,
    repo: "o/a",
    repoPath: "/r",
    pr: 7,
    account: "a",
    vendor: "claude",
    configDir: "/c",
    wallBackoffMs: 1,
    replaces: null,
    facts,
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
    ...over,
  };
  return {
    record,
    state: {
      kind: "ended",
      exit: { at: minutesAgo(ago), code, signal: null },
      process: claim(createdAt),
    },
    result: null,
  };
}

/** PR #7's ledger, stopped `NOT_SETTLED` at ledger generation `generation`, its pull request at `head`. */
function notSettled(generation: number, head = HEAD): DrivenPr {
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
      headSha: head,
    },
  };
}

/** A re-arm at `head` that ran on the ledger of generation `generation` and stopped `NOT_SETTLED` again `ago` minutes ago. */
function notSettledRearm(
  generation: number,
  ago: number,
  head = HEAD,
): ReadRecord {
  return launch(
    "rearm",
    factsOf(notSettled(generation, head)),
    NOT_SETTLED,
    ago,
    {
      heads: `PR head ${head}, branch head ${head}`,
    },
  );
}

describe("re-arms that keep stopping NOT_SETTLED on one head", () => {
  it("back off after the first, though each run moved the ledger", () => {
    const records = [notSettledRearm(1, 5)];
    const [pr] = settleOwnDrives([notSettled(2)], records, new Map(), "h");
    expect(pr?.class).toBe("re-armable");
    expect(pr?.retryAfter).toBeDefined();
    expect(retryWaiting(pr as DrivenPr, currentMs())).toContain(
      `re-arm 1 of ${NOT_SETTLED_REARMS}`,
    );
    expect(retryWaiting(pr as DrivenPr, currentMs() + 16 * 60_000)).toBeNull();
  });

  it("double the backoff with each", () => {
    const one = settleRepeatedNotSettled(
      [notSettled(2)],
      [notSettledRearm(1, 0)],
    )[0];
    const two = settleRepeatedNotSettled(
      [notSettled(3)],
      [notSettledRearm(1, 40), notSettledRearm(2, 0)],
    )[0];
    const wait = (pr: DrivenPr | undefined) =>
      Date.parse(pr?.retryAfter ?? "") - currentMs();
    expect(wait(two)).toBeGreaterThan(wait(one) * 1.5);
  });

  it("are a person's at the cap, notified once for the head and the ledger", () => {
    const records = Array.from({ length: NOT_SETTLED_REARMS }, (_, i) =>
      notSettledRearm(i + 1, 200 - i * 60),
    );
    const [pr] = settleOwnDrives(
      [notSettled(NOT_SETTLED_REARMS + 1)],
      records,
      new Map(),
      "h",
    );
    expect(pr?.class).toBe("needs-person");
    expect(pr?.why).toContain(`after ${NOT_SETTLED_REARMS} re-arms in a row`);
    expect(pr?.retryAfter).toBeUndefined();
    const notice = stopNotice("o/a", pr as DrivenPr);
    expect(notice.key).toBe(
      stopNotice("o/a", { ...(pr as DrivenPr), why: "read again" }).key,
    );
  });

  it("start again on a new head", () => {
    const records = Array.from({ length: NOT_SETTLED_REARMS }, (_, i) =>
      notSettledRearm(i + 1, 200 - i * 60),
    );
    const [pr] = settleRepeatedNotSettled(
      [notSettled(NOT_SETTLED_REARMS + 1, OTHER)],
      records,
    );
    expect(pr?.class).toBe("re-armable");
    expect(pr?.retryAfter).toBeUndefined();
  });

  it("start again after a re-arm that ended any other way", () => {
    const records = [
      notSettledRearm(1, 300),
      notSettledRearm(2, 200),
      launch("rearm", factsOf(notSettled(3)), DRIVE_EXIT.HITL_PARKED, 100, {
        heads: `PR head ${HEAD}, branch head ${HEAD}`,
      }),
      notSettledRearm(4, 0),
    ];
    const [pr] = settleRepeatedNotSettled([notSettled(5)], records);
    expect(pr?.class).toBe("re-armable");
    expect(pr?.evidence.notSettledRearms).toBe(1);
  });

  it("leave a person's rearm request to launch", () => {
    const records = Array.from({ length: NOT_SETTLED_REARMS }, (_, i) =>
      notSettledRearm(i + 1, 200 - i * 60),
    );
    const asked = notSettled(9);
    asked.evidence.rearm = true;
    const [pr] = settleRepeatedNotSettled([asked], records);
    expect(pr).toBe(asked);
  });

  it("still cap re-arms whose heads did not read", () => {
    const unread = (generation: number): DrivenPr => {
      const pr = notSettled(generation);
      delete pr.evidence.headSha;
      return pr;
    };
    const records = Array.from({ length: NOT_SETTLED_REARMS }, (_, i) =>
      launch("rearm", factsOf(unread(i + 1)), NOT_SETTLED, 200 - i * 60, {}),
    );
    const [pr] = settleRepeatedNotSettled(
      [unread(NOT_SETTLED_REARMS + 1)],
      records,
    );
    expect(pr?.class).toBe("needs-person");
  });

  it("read the pull request's head beside a NOT_SETTLED stop", () => {
    const ledger = {
      driver: { state: "stopped", exit: NOT_SETTLED },
    } as unknown as Ledger;
    expect(
      stopEvidence(ledger, { head: HEAD, mergeable: "MERGEABLE" }, false),
    ).toMatchObject({ headSha: HEAD });
  });
});

/** PR #7's silent ledger, at generation 4, whose driver started `started`. */
function silent(heartbeat = "beat 4"): DrivenPr {
  return {
    number: 7,
    url: "https://example.test/pull/7",
    title: "t",
    head: "feature/7",
    class: "silent",
    why: "heartbeat 90 min old, past the 30-min lease window",
    running: true,
    evidence: {
      generation: 4,
      exit: null,
      heartbeat,
      started: minutesAgo(500),
      driverGone: true,
    },
  };
}

/** The re-arm of this host that started the silent driver. */
function owner(): ReadRecord {
  return launch(
    "rearm",
    "generation 3, exit 4, heartbeat beat 3",
    0,
    400,
    {},
    110,
  );
}

function takeovers(n: number, code = DRIVE_EXIT.INDETERMINATE): ReadRecord[] {
  return Array.from({ length: n }, (_, i) =>
    launch("takeover", factsOf(silent()), code, 120 - i * 40, {
      replaces: owner().record.id,
    }),
  );
}

describe("takeovers of this host's silent driver that keep failing on one set of ledger facts", () => {
  it("are takeovers of the driver's own launch record", () => {
    expect(driveHold(silent(), [owner()]).kind).toBe("takeover");
  });

  it("back off after the first", () => {
    const records = [owner(), ...takeovers(1)];
    const [pr] = settleOwnDrives([silent()], records, new Map(), "h");
    expect(pr?.class).toBe("silent");
    expect(pr?.evidence.failedTakeovers).toBe(1);
    expect(pr?.retryAfter).toBeDefined();
  });

  it("are a person's at the cap, notified once for the ledger facts, with no further takeover", () => {
    const records = [owner(), ...takeovers(FAILED_TAKEOVERS)];
    const [pr] = settleOwnDrives([silent()], records, new Map(), "h");
    expect(pr?.class).toBe("needs-person");
    expect(pr?.evidence.takeoverExit).toBe(DRIVE_EXIT.INDETERMINATE);
    expect(pr?.evidence.settled).toBe(true);
    expect(driveHold(pr as DrivenPr, records).kind).toBe("none");
    const notice = stopNotice("o/a", pr as DrivenPr);
    expect(notice.key).toContain("takeovers failed");
    expect(notice.key).toBe(
      stopNotice("o/a", { ...(pr as DrivenPr), why: "read again" }).key,
    );
  });

  it("start again once the ledger moves", () => {
    const records = [owner(), ...takeovers(FAILED_TAKEOVERS)];
    const [pr] = settleFailedTakeovers([silent("beat 5")], records);
    expect(pr?.class).toBe("silent");
    expect(pr?.retryAfter).toBeUndefined();
  });

  it("leave a refusal of a second driver to its own rule", () => {
    const records = [
      owner(),
      ...takeovers(FAILED_TAKEOVERS, DRIVE_EXIT.SINGLE_INSTANCE_LOCK),
    ];
    const [pr] = settleFailedTakeovers([silent()], records);
    expect(pr?.class).toBe("silent");
    expect(pr?.evidence.failedTakeovers).toBeUndefined();
  });
});

describe("what starts the count again or still counts", () => {
  it("a re-arm a person's rearm request made starts the count again", () => {
    const records = Array.from({ length: NOT_SETTLED_REARMS }, (_, i) =>
      notSettledRearm(i + 1, 200 - i * 60),
    );
    const asked = records.at(-1) as ReadRecord;
    asked.record.rearmRequestId = 42;
    const [pr] = settleRepeatedNotSettled(
      [notSettled(NOT_SETTLED_REARMS + 1)],
      records,
    );
    expect(pr?.class).toBe("re-armable");
    expect(pr?.retryAfter).toBeUndefined();
  });

  it("a takeover killed by a signal counts as failed", () => {
    const killed = takeovers(FAILED_TAKEOVERS).map((r) => ({
      ...r,
      state: {
        ...r.state,
        exit: { at: minutesAgo(1), code: null, signal: "SIGKILL" },
      },
    })) as ReadRecord[];
    const [pr] = settleFailedTakeovers([silent()], [owner(), ...killed]);
    expect(pr?.class).toBe("needs-person");
    expect(pr?.evidence.takeoverExit).toBe("SIGKILL");
  });

  it("an end time that does not read backs off from the launch, not the epoch", () => {
    const run = notSettledRearm(1, 5);
    const unread = {
      ...run,
      state: {
        ...run.state,
        exit: { at: "not a time", code: NOT_SETTLED, signal: null },
      },
    } as ReadRecord;
    const [pr] = settleRepeatedNotSettled([notSettled(2)], [unread]);
    expect(retryWaiting(pr as DrivenPr, currentMs())).not.toBeNull();
  });

  it("a running launch that started the driver does not hide the capped takeovers from a person", () => {
    const started = owner();
    const alive = {
      ...started,
      state: { kind: "alive", process: claim(started.record.createdAt) },
    } as ReadRecord;
    const records = [alive, ...takeovers(FAILED_TAKEOVERS)];
    const [pr] = settleOwnDrives([silent()], records, new Map(), "h");
    expect(pr?.class).toBe("needs-person");
    expect(driveHold(pr as DrivenPr, records).kind).toBe("none");
  });
});

describe("launch record retention", () => {
  it("keeps a drive's run of failed ends, up to the highest cap the machine file takes", () => {
    const records = [
      notSettledRearm(1, 1000),
      ...Array.from({ length: NOT_SETTLED_ENDS_KEPT + 1 }, (_, i) =>
        notSettledRearm(i + 2, 900 - i * 60),
      ),
    ];
    const kept = latestRepeatedEnds(records);
    expect(kept.size).toBe(Math.max(NOT_SETTLED_ENDS_KEPT, FAILED_TAKEOVERS));
    expect(kept.has(records.at(-1)?.record.id ?? "")).toBe(true);
    expect(kept.has(records[0]?.record.id ?? "")).toBe(false);
  });

  it("keeps the owner record that started the driver beside its failed takeovers", () => {
    const own = owner();
    const run = takeovers(FAILED_TAKEOVERS);
    const kept = latestRepeatedEnds([own, ...run]);
    expect(kept.has(own.record.id)).toBe(true);
  });

  it("keeps nothing past a launch that ended cleanly", () => {
    const records = [notSettledRearm(1, 300), launch("rearm", "f", 0, 0)];
    expect(latestRepeatedEnds(records).size).toBe(0);
  });
});
