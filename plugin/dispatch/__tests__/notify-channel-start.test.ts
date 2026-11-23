/**
 * dispatch --apply: a notification channel new to the host starts from the
 * causes that already stand. It records them as known without sending them,
 * so a person who adds a channel hears about what appears afterwards, not
 * about the backlog that another channel already told.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delivery, NotificationChannel } from "../../chat/channel.ts";
import type { ApplyState } from "../lib/actions/launch.ts";
import { applyNotices, type Cause } from "../lib/actions/notify.ts";
import { channelStartLine } from "../lib/report.ts";
import { channelStarted, firstSends } from "../lib/notice-records.ts";
import type { SessionRuntime, Workspace } from "../lib/runtime/port.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";
import type { Action, RepoReport, RepoTarget } from "../lib/types.ts";

const SLUG = "example-org/example-repo";
const HOUR = 3_600_000;

const roots: string[] = [];
afterEach(() => {
  setSystemTime();
  for (const root of roots.splice(0)) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

interface FakeChannel extends NotificationChannel<Cause> {
  calls: Cause[][];
  reachable: boolean;
}

function fakeChannel(name: string): FakeChannel {
  const channel: FakeChannel = {
    name,
    calls: [],
    reachable: true,
    unreachable: () => (channel.reachable ? null : "its address is unset"),
    async deliver(due): Promise<Delivery[]> {
      channel.calls.push([...due]);
      return due.map((c) => ({
        key: c.notice.key,
        outcome: "sent",
        place: "#notices",
        detail: "posted",
      }));
    },
  };
  return channel;
}

function host() {
  const root = mkdtempSync(join(tmpdir(), "jig-notify-start-"));
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
  const runtime = {
    async notify(_target, message) {
      workspace.comment = [workspace.comment, message]
        .filter(Boolean)
        .join("\n\n");
      return {
        ok: true,
        detail: "written",
        comment: workspace.comment,
        unread: true,
      };
    },
  } satisfies Partial<SessionRuntime>;
  const state = () =>
    ({
      root,
      runtime,
      machine: { runtimeTimeoutMs: 1000 },
    }) as unknown as ApplyState;
  const repo: RepoTarget = { path: root, slug: SLUG, defaultBranch: "main" };
  return { root, workspace, state, repo };
}

type Host = ReturnType<typeof host>;

/** The notice key of the cause numbered `n`. */
function keyOf(n: number): string {
  return `${SLUG} PR #${n} parked, ledger generation 3: finding F1`;
}

function causes(count: number, from = 1): Action[] {
  return Array.from({ length: count }, (_, i) => {
    const key = keyOf(from + i);
    return {
      stage: "notify",
      target: `PR #${from + i}`,
      cause: "parked",
      reason: "a decision waits",
      record: "forge",
      evidence: {},
      notice: { key, text: `[jig dispatch: ${key}]\nWhich budget?` },
    } as Action;
  });
}

function report(repo: RepoTarget, actions: Action[]): RepoReport {
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
    actions,
  };
}

async function tick(
  h: Host,
  channels: NotificationChannel<Cause>[],
  actions: Action[],
  state: ApplyState = h.state(),
  repo: RepoTarget = h.repo,
  renotifyAfterMs = 0,
): Promise<RepoReport> {
  const r = report(repo, actions);
  await applyNotices(
    state,
    repo,
    r,
    { ok: true, source: "test", workspaces: [h.workspace] },
    { branch: null, lingerMs: HOUR, renotifyAfterMs, channels },
  );
  return r;
}

const sentKeys = (c: FakeChannel) => c.calls.flat().map((x) => x.notice.key);

describe("a channel new to the host", () => {
  it("sends none of the 50 causes already standing, tells the receipt once, and sends nothing for them next tick", async () => {
    const h = host();
    const standing = causes(50);
    await tick(h, [], standing);
    const phone = fakeChannel("phone");

    const first = await tick(h, [phone], standing);
    expect(phone.calls).toEqual([]);
    expect(first.channelStarts).toEqual([{ channel: "phone", causes: 50 }]);
    expect(
      first.notifications.filter((n) => n.channel === "phone"),
    ).toHaveLength(50);
    expect(
      first.notifications
        .filter((n) => n.channel === "phone")
        .every((n) => n.outcome === "suppressed"),
    ).toBe(true);
    expect(channelStartLine({ channel: "phone", causes: 50 })).toContain(
      "notification channel phone from 50 standing causes",
    );

    const second = await tick(h, [phone], standing);
    expect(phone.calls).toEqual([]);
    expect(second.channelStarts).toBeUndefined();
  });

  it("sends a cause that first stands after the channel was added", async () => {
    const h = host();
    const phone = fakeChannel("phone");
    await tick(h, [phone], causes(3));
    const next = await tick(h, [phone], [...causes(3), ...causes(1, 4)]);
    expect(sentKeys(phone)).toEqual([keyOf(4)]);
    expect(next.channelStarts).toBeUndefined();
  });

  it("starts a channel that had nothing to carry, so the first cause after it is sent", async () => {
    const h = host();
    const phone = fakeChannel("phone");
    const empty = await tick(h, [phone], []);
    expect(empty.channelStarts).toEqual([{ channel: "phone", causes: 0 }]);
    await tick(h, [phone], causes(1));
    expect(phone.calls).toHaveLength(1);
  });

  it("repeats a cause recorded at its start, as a repeat, after renotify_after", async () => {
    const h = host();
    const phone = fakeChannel("phone");
    setSystemTime(new Date("2026-11-22T10:00:00.000Z"));
    await tick(h, [phone], causes(2), h.state(), h.repo, 4 * HOUR);
    setSystemTime(new Date("2026-11-22T12:00:00.000Z"));
    await tick(h, [phone], causes(2), h.state(), h.repo, 4 * HOUR);
    expect(phone.calls).toEqual([]);
    setSystemTime(new Date("2026-11-22T15:00:00.000Z"));
    await tick(h, [phone], causes(2), h.state(), h.repo, 4 * HOUR);
    expect(phone.calls.flat()).toHaveLength(2);
    expect(phone.calls.flat().every((c) => c.repeat === true)).toBe(true);
    expect(phone.calls.flat()[0]?.notice.text).toContain("Sent again");
  });

  it("sends a cause on a repository that first runs after the channel started: the start is the host's", async () => {
    const h = host();
    const phone = fakeChannel("phone");
    await tick(h, [phone], causes(2));
    const other: RepoTarget = { ...h.repo, slug: "example-org/other-repo" };
    const later = await tick(h, [phone], causes(2, 10), h.state(), other);
    expect(phone.calls.flat()).toHaveLength(2);
    expect(later.channelStarts).toBeUndefined();
  });

  it("writes the event row when a cause recorded at the start is first delivered", async () => {
    const h = host();
    const phone = fakeChannel("phone");
    const rows = () =>
      (
        stateDb(h.root)
          .query("SELECT COUNT(*) AS n FROM log WHERE kind <> 'tick'")
          .get() as { n: number }
      ).n;
    setSystemTime(new Date("2026-11-22T10:00:00.000Z"));
    await tick(h, [phone], causes(1), h.state(), h.repo, 4 * HOUR);
    stateDb(h.root).query("DELETE FROM log").run();
    setSystemTime(new Date("2026-11-22T15:00:00.000Z"));
    await tick(h, [phone], causes(1), h.state(), h.repo, 4 * HOUR);
    expect(phone.calls.flat()).toHaveLength(1);
    expect(rows()).toBeGreaterThan(0);
  });

  it("records the start as no send: no first-send time for what it recorded", async () => {
    const h = host();
    const phone = fakeChannel("phone");
    await tick(h, [phone], causes(2));
    stateDb(h.root).query("DELETE FROM notices WHERE channel <> 'phone'").run();
    expect(firstSends(stateDb(h.root), SLUG).size).toBe(0);
  });

  it("does not start a channel that holds a send record at another repository", async () => {
    const h = host();
    const phone = fakeChannel("phone");
    stateDb(h.root)
      .query(
        "INSERT INTO notices (repo, key, target, workspace, at, lasting, channel) VALUES ('example-org/other-repo', ?, 'PR #1', '#notices', '2026-01-01T00:00:00.000Z', 0, 'phone')",
      )
      .run(`phone:example-org/other-repo PR #1`);
    expect(channelStarted("phone", h.root)).toBe(true);
    const after = await tick(h, [phone], causes(2));
    expect(phone.calls.flat()).toHaveLength(2);
    expect(after.channelStarts).toBeUndefined();
  });

  it("counts the silent records of an incomplete start as no start", async () => {
    const h = host();
    stateDb(h.root)
      .query(
        "INSERT INTO notices (repo, key, target, workspace, at, lasting, channel) VALUES (?, ?, 'PR #1', 'channel start', '2026-01-01T00:00:00.000Z', 0, 'phone')",
      )
      .run(SLUG, `phone:${keyOf(1)}`);
    expect(channelStarted("phone", h.root)).toBe(false);
  });

  it("does not resend the standing causes of a renamed channel", async () => {
    const h = host();
    const old = fakeChannel("phone");
    await tick(h, [old], causes(1));
    await tick(h, [old], [...causes(1), ...causes(1, 2)]);
    expect(old.calls).toHaveLength(1);

    const renamed = fakeChannel("phone-2");
    const after = await tick(h, [renamed], [...causes(1), ...causes(1, 2)]);
    expect(renamed.calls).toEqual([]);
    expect(after.channelStarts).toEqual([{ channel: "phone-2", causes: 2 }]);
  });

  it("starts again when the channel's records were dropped", async () => {
    const h = host();
    const phone = fakeChannel("phone");
    await tick(h, [phone], causes(2));
    stateDb(h.root).query("DELETE FROM notices WHERE channel = ?").run("phone");
    expect(channelStarted("phone", h.root)).toBe(false);
    const again = await tick(h, [phone], causes(2));
    expect(phone.calls).toEqual([]);
    expect(again.channelStarts).toEqual([{ channel: "phone", causes: 2 }]);
  });

  it("is not started while it cannot be reached, and starts on the first tick it can send", async () => {
    const h = host();
    const phone = fakeChannel("phone");
    phone.reachable = false;
    const waiting = await tick(h, [phone], causes(2));
    expect(waiting.channelStarts).toBeUndefined();
    expect(
      waiting.notifications
        .filter((n) => n.channel === "phone")
        .map((n) => n.outcome),
    ).toEqual(["waits", "waits"]);
    expect(channelStarted("phone", h.root)).toBe(false);

    phone.reachable = true;
    const started = await tick(h, [phone], causes(2));
    expect(phone.calls).toEqual([]);
    expect(started.channelStarts).toEqual([{ channel: "phone", causes: 2 }]);
  });

  it("starts alike on every repository of the tick and tells it once", async () => {
    const h = host();
    const phone = fakeChannel("phone");
    const state = h.state();
    const other: RepoTarget = { ...h.repo, slug: "example-org/other-repo" };
    const first = await tick(h, [phone], causes(2), state);
    const second = await tick(h, [phone], causes(3), state, other);
    expect(phone.calls).toEqual([]);
    expect(first.channelStarts).toEqual([{ channel: "phone", causes: 5 }]);
    expect(second.channelStarts).toBeUndefined();
  });

  it("leaves a channel with records from an earlier release as it was", async () => {
    const h = host();
    stateDb(h.root)
      .query(
        "INSERT INTO notices (repo, key, target, workspace, at, lasting, channel) VALUES (?, ?, ?, ?, ?, 0, ?)",
      )
      .run(
        SLUG,
        `phone:${keyOf(1)}`,
        "PR #1",
        "#n",
        "2026-11-01T00:00:00.000Z",
        "phone",
      );
    const phone = fakeChannel("phone");
    const later = await tick(h, [phone], [...causes(1), ...causes(1, 2)]);
    expect(sentKeys(phone)).toEqual([keyOf(2)]);
    expect(later.channelStarts).toBeUndefined();
  });
});
