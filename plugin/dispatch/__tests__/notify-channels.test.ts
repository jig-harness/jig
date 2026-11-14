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
import { actionBook, FAILURE_DEFAULTS, readFailures } from "../lib/failures.ts";
import {
  ORCA_CARD,
  readSuppressions,
  recordKey,
} from "../lib/notice-records.ts";
import type { SessionRuntime, Workspace } from "../lib/runtime/port.ts";
import {
  closeStateDb,
  SCHEMA_VERSION,
  stateDb,
  statePath,
} from "../lib/state.ts";
import type { RepoReport, RepoTarget } from "../lib/types.ts";

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
function fakeChannel(): NotificationChannel<Cause> & {
  next: DeliveryOutcome;
  calls: string[][];
} {
  const channel = {
    name: "fake",
    next: "sent" as DeliveryOutcome,
    calls: [] as string[][],
    unreachable: () => null,
    async deliver(due: readonly Cause[]): Promise<Delivery[]> {
      channel.calls.push(due.map((c) => c.notice.key));
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

/** One tick's notifications of the parked pull request, through `orca-card` and `channel`. */
async function tick(
  h: ReturnType<typeof host>,
  channel: NotificationChannel<Cause>,
  book = false,
): Promise<RepoReport> {
  const report = parkedReport(h.repo);
  await applyNotices(
    h.state,
    h.repo,
    report,
    { ok: true, source: "test", workspaces: [h.workspace] },
    {
      branch: null,
      lingerMs: 3_600_000,
      renotifyAfterMs: 0,
      channels: [channel],
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
  it("reads a record written before it as `orca-card`'s, and an older copy's insert still works", () => {
    const root = mkdtempSync(join(tmpdir(), "jig-notices-migrate-"));
    roots.push(root);
    stateDb(root);
    closeStateDb(root);
    const before = SCHEMA_VERSION - 1;
    const old = new Database(statePath(root));
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
    // A copy one release behind writes as it always did; its row is `orca-card`'s.
    db.query(
      `INSERT INTO notices (repo, key, target, workspace, at, lasting)
       VALUES (?, ?, 'PR #8', '/ws', '2026-11-01T11:00:00.000Z', 0) ON CONFLICT (repo, key) DO NOTHING`,
    ).run(SLUG, `${SLUG} PR #8 ready at abc`);
    expect(
      db.query("SELECT channel FROM notices WHERE key LIKE '%#8%'").get(),
    ).toEqual({ channel: ORCA_CARD });
  });

  it("qualifies the key of a channel other than `orca-card` so no notice key can take its form", () => {
    expect(recordKey(ORCA_CARD, KEY)).toBe(KEY);
    expect(recordKey("slack", KEY)).toBe(`slack:${KEY}`);
    expect(recordKey("slack", "host ticks /a failing since x")).toBe(
      "slack:host ticks /a failing since x",
    );
  });
});
