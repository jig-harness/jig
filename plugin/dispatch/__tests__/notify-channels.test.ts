/**
 * dispatch --apply: notification channels. Each channel keeps its own
 * suppression records and failure-ledger rows, so a cause delivered on one
 * channel and lost on another is tried again on the other alone, and backs
 * off there alone; `orca-card`'s records and ledger keys are those written
 * before there were channels, which a database from before the `channel`
 * column reads as `orca-card`'s.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Delivery,
  DeliveryOutcome,
  NotificationChannel,
} from "../../chat/channel.ts";
import type { ApplyState } from "../lib/actions/launch.ts";
import { applyNotices, type Cause } from "../lib/actions/notify.ts";
import {
  actionBook,
  FAILURE_DEFAULTS,
  readFailures,
  recordFailure,
} from "../lib/failures.ts";
import {
  ORCA_CARD,
  readSuppressions,
  recordKey,
} from "../lib/notice-records.ts";
import type { SessionRuntime, Workspace } from "../lib/runtime/port.ts";
import { closeStateDb, MIGRATIONS, stateDb, statePath } from "../lib/state.ts";
import type { Action, RepoReport, RepoTarget } from "../lib/types.ts";

const SLUG = "example-org/example-repo";
const KEY = `${SLUG} PR #7 parked, ledger generation 3: finding F1`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/** A channel beside `orca-card` whose next answer the test sets. */
interface FakeChannel extends NotificationChannel<Cause> {
  next: DeliveryOutcome;
  calls: string[][];
  timeLeft: Array<number | null>;
  /** Its answers in place of `next`'s, when set. */
  answers?: (due: readonly Cause[]) => Delivery[];
}

function fakeChannel(name = "fake"): FakeChannel {
  const channel: FakeChannel = {
    name,
    next: "sent",
    calls: [],
    timeLeft: [],
    unreachable: () => null,
    async deliver(due, time): Promise<Delivery[]> {
      channel.calls.push(due.map((c) => c.notice.key));
      channel.timeLeft.push(time.timeLeftMs());
      if (channel.answers !== undefined) return channel.answers(due);
      return due.map((c) => ({
        key: c.notice.key,
        outcome: channel.next,
        place: channel.next === "lost" ? null : "#notices",
        detail: channel.next === "lost" ? "the post was refused" : "posted",
      }));
    },
  };
  return channel;
}

/** One repository's notices workspace and a runtime that writes its comment, `fails` once set. */
function host() {
  const root = mkdtempSync(join(tmpdir(), "jig-notify-channels-"));
  roots.push(root);
  const workspace: Workspace = {
    id: "notices",
    path: join(root, "notices"),
    branch: "jig-dispatch-notices",
    prs: [],
    items: [],
    agents: [],
    unverifiableTerminals: 0,
    comment: "",
    unread: false,
    name: "notices",
  };
  const card = { writes: 0, fails: false };
  const runtime = {
    async notify(_target, message) {
      card.writes++;
      if (card.fails) return { ok: false, detail: "the card was not written" };
      workspace.comment = [workspace.comment, message]
        .filter(Boolean)
        .join("\n\n");
      workspace.unread = true;
      return {
        ok: true,
        detail: "written",
        comment: workspace.comment,
        unread: true,
      };
    },
  } satisfies Partial<SessionRuntime>;
  const state = {
    root,
    runtime,
    machine: { runtimeTimeoutMs: 1000 },
  } as unknown as ApplyState;
  const repo: RepoTarget = { path: root, slug: SLUG, defaultBranch: "main" };
  return { root, workspace, card, state, repo, ledgerFailures: [] as string[] };
}

function parkedReport(repo: RepoTarget): RepoReport {
  return {
    path: repo.path,
    slug: repo.slug,
    refused: null,
    section: null,
    followupSince: null,
    records: [],
    running: [],
    unplaced: [],
    launches: [],
    notifications: [],
    quiet: [],
    actions: [
      {
        stage: "notify",
        target: "PR #7",
        cause: "parked",
        reason: "a decision waits",
        record: "forge",
        evidence: {},
        notice: { key: KEY, text: `[jig dispatch: ${KEY}]\nWhich budget?` },
      },
    ],
  };
}

/** One tick's notifications of the parked pull request and `extra`, through `orca-card` and `channel`. */
async function tick(
  h: ReturnType<typeof host>,
  channel: NotificationChannel<Cause> | NotificationChannel<Cause>[],
  book = false,
  extra: Action[] = [],
): Promise<RepoReport> {
  const report = parkedReport(h.repo);
  report.actions.push(...extra);
  await applyNotices(
    h.state,
    h.repo,
    report,
    { ok: true, source: "test", workspaces: [h.workspace] },
    {
      branch: null,
      lingerMs: 3_600_000,
      renotifyAfterMs: 0,
      channels: Array.isArray(channel) ? channel : [channel],
      ...(book
        ? {
            book: actionBook(
              SLUG,
              FAILURE_DEFAULTS,
              (reason) => h.ledgerFailures.push(reason),
              h.root,
            ),
          }
        : {}),
    },
  );
  return report;
}

function rows(root: string) {
  return stateDb(root)
    .query("SELECT channel, key, at FROM notices ORDER BY channel")
    .all() as Array<{ channel: string; key: string; at: string }>;
}

describe("a cause on two channels", () => {
  it("is tried again on the channel that lost it alone, the other's record standing", async () => {
    const h = host();
    const fake = fakeChannel();
    fake.next = "lost";

    const first = await tick(h, fake);
    expect(
      first.notifications.map((n) => [n.channel ?? ORCA_CARD, n.outcome]),
    ).toEqual([
      [ORCA_CARD, "sent"],
      ["fake", "lost"],
    ]);
    expect(first.notifications[0]).not.toHaveProperty("channel");
    expect(h.card.writes).toBe(1);
    const [card] = rows(h.root);
    expect(card).toMatchObject({ channel: ORCA_CARD, key: KEY });
    expect(rows(h.root)).toHaveLength(1);

    fake.next = "sent";
    const second = await tick(h, fake);
    expect(
      second.notifications.map((n) => [n.channel ?? ORCA_CARD, n.outcome]),
    ).toEqual([
      [ORCA_CARD, "suppressed"],
      ["fake", "sent"],
    ]);
    expect(h.card.writes).toBe(1);
    expect(fake.calls).toEqual([[KEY], [KEY]]);
    expect(rows(h.root)).toEqual([
      { channel: "fake", key: `fake:${KEY}`, at: expect.any(String) },
      card as { channel: string; key: string; at: string },
    ]);
    expect([...readSuppressions("fake", SLUG, h.root).keys()]).toEqual([KEY]);

    const third = await tick(h, fake);
    expect(third.notifications.map((n) => n.outcome)).toEqual([
      "suppressed",
      "suppressed",
    ]);
    expect(fake.calls).toHaveLength(2);
  });

  it("keeps the record of a cause another channel sent first, and one event row for it", async () => {
    const h = host();
    const fake = fakeChannel();
    await tick(h, fake);
    expect(rows(h.root).map((r) => r.key)).toEqual([`fake:${KEY}`, KEY]);
    expect(
      stateDb(h.root)
        .query("SELECT key FROM log WHERE key = ?")
        .all(`event ${KEY}`),
    ).toHaveLength(1);
  });
});

describe("a delivery that keeps failing", () => {
  it("backs off under its own channel's ledger key, the other channel unaffected", async () => {
    const h = host();
    const fake = fakeChannel();
    fake.next = "lost";
    await tick(h, fake, true);
    await tick(h, fake, true);
    expect(readFailures(SLUG, h.root).map((r) => [r.key, r.count])).toEqual([
      [`notice fake ${KEY}`, 2],
    ]);

    const third = await tick(h, fake, true);
    const waits = third.notifications.find((n) => n.channel === "fake");
    expect(waits?.outcome).toBe("waits");
    expect(fake.calls).toHaveLength(2);
    expect(third.notifications[0]?.outcome).toBe("suppressed");
    expect(h.ledgerFailures).toEqual([]);
  });

  it("is counted on `orca-card` under the key it had before channels", async () => {
    const h = host();
    h.card.fails = true;
    const fake = fakeChannel();
    await tick(h, fake, true);
    expect(readFailures(SLUG, h.root).map((r) => r.key)).toEqual([
      `notice ${KEY}`,
    ]);
    expect(rows(h.root).map((r) => r.channel)).toEqual(["fake"]);
  });
});

describe("the `channel` column", () => {
  it("reads a record written before channels as `orca-card`'s", () => {
    const root = mkdtempSync(join(tmpdir(), "jig-notices-migrate-"));
    roots.push(root);
    stateDb(root);
    closeStateDb(root);
    // The version just before the channel column's migration; later migrations are undone too.
    const before = MIGRATIONS.findIndex((m) =>
      m.sql.includes("ADD COLUMN channel"),
    );
    const old = new Database(statePath(root));
    old.run("DROP TABLE merge_facts");
    old.run("DROP TABLE allocation_charge");
    old.run("DROP TABLE allocation_week");
    old.run("DROP TABLE allocation_lane_epoch");
    old.run("DROP TABLE allocation_ranking");
    old.run("ALTER TABLE launches DROP COLUMN sessions");
    old.run("ALTER TABLE launches DROP COLUMN result_wait");
    old.run("DROP INDEX steward_records_run_effect");
    old.run("DROP INDEX notices_channel_key");
    old.run("ALTER TABLE notices DROP COLUMN channel");
    old.run(`PRAGMA user_version = ${before}`);
    old.run("DELETE FROM db_migrations WHERE version > ?", [before]);
    old.run("UPDATE db_meta SET version = ?", [before]);
    old
      .query(
        "INSERT INTO notices (repo, key, target, workspace, at, lasting) VALUES (?, ?, 'PR #7', '/ws', '2026-11-01T10:00:00.000Z', 0)",
      )
      .run(SLUG, KEY);
    old.close();

    const db = stateDb(root);
    expect(db.query("SELECT channel, key FROM notices").all()).toEqual([
      { channel: ORCA_CARD, key: KEY },
    ]);
    expect(readSuppressions(ORCA_CARD, SLUG, root).get(KEY)).toMatchObject({
      key: KEY,
      workspace: "/ws",
      sentAt: "2026-11-01T10:00:00.000Z",
    });
  });

  it("qualifies the key of a channel other than `orca-card` so no notice key can take its form", () => {
    expect(recordKey(ORCA_CARD, KEY)).toBe(KEY);
    expect(recordKey("slack", KEY)).toBe(`slack:${KEY}`);
    expect(recordKey("slack", "host ticks /a failing since x")).toBe(
      "slack:host ticks /a failing since x",
    );
  });
});

describe("a channel's answers", () => {
  it("keeps the receiver when checking whether a channel is reachable", async () => {
    const h = host();
    const fake = fakeChannel();
    fake.unreachable = function () {
      return this.name === "fake" ? "offline" : null;
    };
    const report = await tick(h, fake);
    expect(fake.calls).toEqual([]);
    expect(
      report.notifications.find((n) => n.channel === "fake"),
    ).toMatchObject({
      channel: "fake",
      outcome: "waits",
      detail: "offline",
    });
  });

  it("isolates a reachability check that throws", async () => {
    const h = host();
    const broken = fakeChannel("broken");
    broken.unreachable = () => {
      throw new Error("socket closed");
    };
    const fake = fakeChannel();
    const report = await tick(h, [broken, fake]);
    expect(broken.calls).toEqual([]);
    expect(fake.calls).toEqual([[KEY]]);
    expect(
      report.notifications.find((n) => n.channel === "broken"),
    ).toMatchObject({
      outcome: "waits",
      detail: "its reachability check threw: socket closed",
    });
  });

  it("count a cause it gives no answer for as lost, and report an answer for no due cause", async () => {
    const h = host();
    const fake = fakeChannel();
    fake.answers = () => [
      {
        key: `${SLUG} PR #9 ready at abc`,
        outcome: "sent",
        place: "#notices",
        detail: "posted",
      },
    ];
    const report = await tick(h, fake, true);
    expect(report.notifications[1]).toMatchObject({
      channel: "fake",
      key: KEY,
      outcome: "lost",
      detail: "the fake channel gave no answer for it",
    });
    expect(report.notifications).toHaveLength(2);
    expect(report.unplaced).toEqual([
      expect.objectContaining({
        target: "the fake notification channel",
        reason: expect.stringContaining(`${SLUG} PR #9 ready at abc`),
      }),
    ]);
    expect(readFailures(SLUG, h.root).map((r) => r.key)).toEqual([
      `notice fake ${KEY}`,
    ]);
    expect(rows(h.root).map((r) => r.channel)).toEqual([ORCA_CARD]);
  });

  it("are asked for with the time the tick has left", async () => {
    const h = host();
    const fake = fakeChannel();
    await tick(h, fake);
    expect(fake.timeLeft).toEqual([null]);
  });

  it("count a batch whose delivery threw as lost on that channel alone, the other channels and the notices workspace still served", async () => {
    const h = host();
    const broken = fakeChannel("broken");
    broken.answers = () => {
      throw new Error("socket closed");
    };
    const fake = fakeChannel();
    const report = await tick(h, [broken, fake], true);
    expect(
      report.notifications.map((n) => [n.channel ?? ORCA_CARD, n.outcome]),
    ).toEqual([
      [ORCA_CARD, "sent"],
      ["broken", "lost"],
      ["fake", "sent"],
    ]);
    expect(report.notifications[1]?.detail).toBe(
      "the broken channel failed: socket closed",
    );
    expect(report.unplaced).toEqual([
      expect.objectContaining({ target: "the broken notification channel" }),
    ]);
    expect(readFailures(SLUG, h.root).map((r) => r.key)).toEqual([
      `notice broken ${KEY}`,
    ]);
    expect(report.noticesWorkspace).toMatchObject({
      outcome: "kept",
      detail: "written this tick",
    });
  });

  it("counts malformed delivery answers as lost without stopping other channels", async () => {
    const h = host();
    const broken = fakeChannel("broken");
    broken.answers = () => [
      {
        key: KEY,
        outcome: "failed" as DeliveryOutcome,
        place: null,
        detail: "bad",
      },
    ];
    const fake = fakeChannel();
    const report = await tick(h, [broken, fake], true);
    expect(
      report.notifications.find((n) => n.channel === "broken"),
    ).toMatchObject({ outcome: "lost" });
    expect(fake.calls).toEqual([[KEY]]);
    expect(report.unplaced).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "the broken notification channel",
          reason: expect.stringContaining("malformed"),
        }),
      ]),
    );
  });
});

describe("a delivery that outlasts its time", () => {
  it("has stopped by the time its batch is answered lost", async () => {
    const h = host();
    h.state.machine.runtimeTimeoutMs = 10;
    h.state.machine.workspaceTimeoutMs = 0;
    const slow = fakeChannel("slow");
    let stopped = false;
    slow.deliver = async (_due, time) => {
      await new Promise<void>((resolve) =>
        time.signal.addEventListener("abort", () => resolve()),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      stopped = true;
      return [];
    };
    const report = await tick(h, slow, true);
    expect(stopped).toBe(true);
    expect(
      report.notifications.find((n) => n.channel === "slow"),
    ).toMatchObject({ outcome: "lost" });
  });
});

describe("a delivery that settles while it is being cancelled", () => {
  it("keeps the receipt it returns", async () => {
    const h = host();
    h.state.machine.runtimeTimeoutMs = 10;
    h.state.machine.workspaceTimeoutMs = 0;
    const slow = fakeChannel("slow");
    slow.deliver = async (due, time) => {
      await new Promise<void>((resolve) =>
        time.signal.addEventListener("abort", () => resolve()),
      );
      return due.map((c) => ({
        key: c.notice.key,
        outcome: "sent" as const,
        place: "somewhere",
        detail: "written before it stopped",
      }));
    };
    const report = await tick(h, slow, true);
    expect(
      report.notifications.find((n) => n.channel === "slow"),
    ).toMatchObject({ outcome: "sent" });
  });
});

describe("a channel's name", () => {
  it("is refused, reported, when it breaks the rule or repeats another's, and nothing goes through it", async () => {
    const h = host();
    const bad = fakeChannel("Slack:west");
    const twin = fakeChannel(ORCA_CARD);
    const fake = fakeChannel();
    const report = await tick(h, [bad, twin, fake]);
    expect(bad.calls).toEqual([]);
    expect(twin.calls).toEqual([]);
    expect(fake.calls).toEqual([[KEY]]);
    expect(report.unplaced.map((u) => u.reason)).toEqual([
      expect.stringContaining('"Slack:west"'),
      expect.stringContaining(
        `two notification channels are named ${ORCA_CARD}`,
      ),
    ]);
  });
});

describe("the notices before the failure notices", () => {
  it("clear a channel's recovered delivery before any channel decides the failure notice about it", async () => {
    const h = host();
    const row = `notice fake ${KEY}`;
    recordFailure(
      { repo: SLUG, key: row, kind: "notice", target: "PR #7" },
      "the post was refused",
      Date.now() - 3_600_000,
      FAILURE_DEFAULTS,
      h.root,
    );
    const failing = `${SLUG} ${row} failing since x`;
    const fake = fakeChannel();
    const report = await tick(h, fake, true, [
      {
        stage: "notify",
        target: "PR #7",
        cause: "action-failing",
        reason: "failed 3 times in a row",
        record: "runtime",
        evidence: { row },
        notice: { key: failing, text: `[jig dispatch: ${failing}]` },
      },
    ]);
    expect(
      report.notifications.map((n) => [n.channel ?? ORCA_CARD, n.key]),
    ).toEqual([
      [ORCA_CARD, KEY],
      ["fake", KEY],
    ]);
    expect(h.workspace.comment).not.toContain(failing);
    expect(readFailures(SLUG, h.root)).toEqual([]);
  });
});
