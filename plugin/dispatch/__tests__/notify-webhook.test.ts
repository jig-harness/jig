/**
 * dispatch --apply: the `notify` stage through a webhook channel. On
 * `runtime: process` the tick writes no Orca card and observes no notices
 * workspace: a parked drive's cause reaches a person through the webhook
 * the machine file names, once, then again after `dispatch.renotify_after`
 * while it stands, and a delivery that keeps failing backs off under the
 * channel's own failure-ledger key. On `runtime: orca` a named channel is
 * sent through beside the card.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplyState } from "../lib/actions/launch.ts";
import { applyNotices } from "../lib/actions/notify.ts";
import { actionBook, FAILURE_DEFAULTS, readFailures } from "../lib/failures.ts";
import {
  type MachineConfig,
  parseMachineConfigText,
} from "../lib/machine-config.ts";
import { markChannelStarted, ORCA_CARD } from "../lib/notice-records.ts";
import { NOTICES_READ } from "../lib/notices-read.ts";
import { noticeOutlets } from "../lib/notify-config.ts";
import type {
  SessionRuntime,
  SessionsReport,
  Workspace,
} from "../lib/runtime/port.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";
import type { RepoReport, RepoTarget } from "../lib/types.ts";

const SLUG = "example-org/example-repo";
const KEY = `${SLUG} PR #7 parked, ledger generation 3: thread F1`;
const SECRET = "hooks/s3cr3t-topic";
const HOUR = 3_600_000;

const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  setSystemTime();
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/** A webhook answering `status()` to each post, keeping the bodies it received. */
function webhook() {
  const posts: string[] = [];
  let status = 200;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      posts.push(await request.text());
      return new Response("", { status });
    },
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${server.port}/${SECRET}`,
    posts,
    answer(next: number) {
      status = next;
    },
  };
}

/** The machine file of a host that notifies `stages` through one webhook. */
function machine(runtime: "orca" | "process", root: string): MachineConfig {
  const read = parseMachineConfigText(
    [
      `runtime: ${runtime}`,
      "repositories:",
      `  - path: ${JSON.stringify(root)}`,
      "    stages: [rearm, notify]",
      "notify:",
      "  channels:",
      "    - name: phone",
      "      kind: webhook",
      "      url_env: JIG_TEST_PHONE_URL",
      "      format: text",
    ].join("\n"),
    "machine",
  );
  if (!read.ok) throw new Error(read.failure.reason);
  return read.value;
}

/** A session runtime any call to which fails the test: the process runtime's notices go through the channels alone. */
function untouchable(): SessionRuntime {
  return new Proxy({} as SessionRuntime, {
    get(_target, name) {
      throw new Error(`the session runtime was asked for ${String(name)}`);
    },
  });
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
        notice: {
          key: KEY,
          text: `[jig dispatch: ${KEY}]\nPR #7 (Budget) is parked: one decision waits for a person.`,
          address: `drive@${SLUG}#7`,
          links: { pullRequest: "https://example.test/pull/7" },
        },
      },
    ],
  };
}

function host(runtime: "orca" | "process") {
  const root = mkdtempSync(join(tmpdir(), "jig-notify-webhook-"));
  roots.push(root);
  const hook = webhook();
  const config = machine(runtime, root);
  const outlets = () => noticeOutlets(config, { JIG_TEST_PHONE_URL: hook.url });
  const repo: RepoTarget = { path: root, slug: SLUG, defaultBranch: "main" };
  const ledgerFailures: string[] = [];
  // The channel has already begun sending on this repository; one that has not starts from what stands (notify-channel-start.test.ts).
  markChannelStarted("phone", SLUG, "2026-01-01T00:00:00.000Z", root);
  const book = () =>
    actionBook(SLUG, FAILURE_DEFAULTS, (r) => ledgerFailures.push(r), root);
  return { root, hook, config, outlets, repo, book, ledgerFailures };
}

async function tick(
  h: ReturnType<typeof host>,
  state: ApplyState,
  sessions: SessionsReport,
): Promise<RepoReport> {
  const report = parkedReport(h.repo);
  await applyNotices(state, h.repo, report, sessions, {
    branch: null,
    lingerMs: HOUR,
    renotifyAfterMs: 4 * HOUR,
    book: h.book(),
    ...h.outlets(),
  });
  // The address is a credential: nothing the tick reports holds it.
  expect(JSON.stringify(report)).not.toContain(SECRET);
  return report;
}

function processState(h: ReturnType<typeof host>): ApplyState {
  return {
    root: h.root,
    runtime: untouchable(),
    machine: { ...h.config, runtimeTimeoutMs: 1000 },
  } as unknown as ApplyState;
}

const LISTED: SessionsReport = { ok: true, source: "test", workspaces: [] };

describe.skipIf(process.platform === "win32")("on runtime: process", () => {
  it("sends a parked drive's cause once through the webhook, again after renotify_after, and writes no card", async () => {
    const h = host("process");
    const state = processState(h);
    const start = Date.parse("2026-11-20T10:00:00.000Z");
    setSystemTime(new Date(start));

    const first = await tick(h, state, LISTED);
    expect(first.notifications).toEqual([
      expect.objectContaining({
        channel: "phone",
        key: KEY,
        outcome: "sent",
        workspace: expect.stringMatching(/^phone \(127\.0\.0\.1:\d+\)$/),
      }),
    ]);
    expect(h.hook.posts).toHaveLength(1);
    expect(h.hook.posts[0]).toStartWith(`[jig dispatch: ${KEY}]`);
    expect(h.hook.posts[0]).toContain(
      "Pull request: https://example.test/pull/7",
    );
    expect(first.noticesWorkspace).toBeUndefined();
    expect(first.unplaced).toEqual([]);

    setSystemTime(new Date(start + HOUR));
    const second = await tick(h, state, LISTED);
    expect(second.notifications.map((n) => [n.channel, n.outcome])).toEqual([
      ["phone", "suppressed"],
    ]);
    expect(h.hook.posts).toHaveLength(1);

    setSystemTime(new Date(start + 5 * HOUR));
    const third = await tick(h, state, LISTED);
    expect(third.notifications.map((n) => [n.channel, n.outcome])).toEqual([
      ["phone", "sent"],
    ]);
    expect(h.hook.posts).toHaveLength(2);
    expect(h.hook.posts[1]).toContain(
      "Sent again: this still waits on a person",
    );

    const db = stateDb(h.root);
    expect(
      db.query("SELECT channel FROM notices WHERE repo <> ''").all(),
    ).toEqual([{ channel: "phone" }]);
    // One event row for the cause, and no read observation: a webhook has no read state.
    expect(
      db.query("SELECT key FROM log WHERE key = ?").all(`event ${KEY}`),
    ).toHaveLength(1);
    expect(
      db
        .query("SELECT key FROM log WHERE bucket = ?")
        .all(`event: ${NOTICES_READ}`),
    ).toEqual([]);
  });

  it("backs a lost delivery off under the channel's own ledger key", async () => {
    const h = host("process");
    const state = processState(h);
    h.hook.answer(500);
    const first = await tick(h, state, LISTED);
    expect(first.notifications).toEqual([
      expect.objectContaining({
        channel: "phone",
        outcome: "lost",
        detail: expect.stringContaining("server-fault"),
      }),
    ]);
    await tick(h, state, LISTED);
    expect(readFailures(SLUG, h.root).map((r) => [r.key, r.count])).toEqual([
      [`notice phone ${KEY}`, 2],
    ]);
    expect(h.hook.posts).toHaveLength(2);

    const third = await tick(h, state, LISTED);
    expect(third.notifications.map((n) => [n.channel, n.outcome])).toEqual([
      ["phone", "waits"],
    ]);
    expect(h.hook.posts).toHaveLength(2);
    expect(
      stateDb(h.root).query("SELECT key FROM notices WHERE repo <> ''").all(),
    ).toEqual([]);
  });

  it("lets every cause wait, counting no failure, while the address variable is unset", async () => {
    const h = host("process");
    const state = processState(h);
    const report = parkedReport(h.repo);
    await applyNotices(state, h.repo, report, LISTED, {
      branch: null,
      lingerMs: HOUR,
      renotifyAfterMs: 4 * HOUR,
      book: h.book(),
      ...noticeOutlets(h.config, {}),
    });
    expect(report.notifications).toEqual([
      expect.objectContaining({
        channel: "phone",
        outcome: "waits",
        detail: expect.stringContaining("JIG_TEST_PHONE_URL is not set"),
      }),
    ]);
    expect(h.hook.posts).toEqual([]);
    expect(readFailures(SLUG, h.root)).toEqual([]);
  });

  it("reports a channel with no address as the host's fault, once a tick, even with nothing due", async () => {
    const h = host("process");
    const state = processState(h);
    const settings = () => ({
      branch: null,
      lingerMs: HOUR,
      renotifyAfterMs: 4 * HOUR,
      book: h.book(),
      ...noticeOutlets(h.config, { JIG_TEST_PHONE_URL: "" }),
    });
    const first = parkedReport(h.repo);
    first.actions = [];
    await applyNotices(state, h.repo, first, LISTED, settings());
    expect(first.unplaced).toEqual([
      {
        target: "the phone notification channel",
        record: "runtime",
        channelFault: true,
        reason: expect.stringContaining(
          "JIG_TEST_PHONE_URL is not set in the tick's environment",
        ),
      },
    ]);
    // Another repository's turn in the same tick: the host's fault is not repeated.
    const second = parkedReport(h.repo);
    await applyNotices(state, h.repo, second, LISTED, settings());
    expect(second.unplaced).toEqual([]);
    // The next tick reports it again.
    const next = parkedReport(h.repo);
    await applyNotices(processState(h), h.repo, next, LISTED, settings());
    expect(next.unplaced).toHaveLength(1);
  });

  it("reports a refused address without echoing it", async () => {
    const h = host("process");
    const report = parkedReport(h.repo);
    await applyNotices(processState(h), h.repo, report, LISTED, {
      branch: null,
      lingerMs: HOUR,
      renotifyAfterMs: 4 * HOUR,
      ...noticeOutlets(h.config, {
        JIG_TEST_PHONE_URL: `http://hooks.example.test/${SECRET}`,
      }),
    });
    expect(report.unplaced).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining("its value is withheld"),
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });
});

describe("on runtime: orca", () => {
  it("sends a named channel beside the card", async () => {
    const h = host("orca");
    const workspace: Workspace = {
      id: "notices",
      path: join(h.root, "notices"),
      branch: "jig-dispatch-notices",
      prs: [],
      items: [],
      agents: [],
      unverifiableTerminals: 0,
      comment: "",
      unread: false,
      name: "notices",
    };
    let cards = 0;
    const runtime = {
      async notify(_target, message) {
        cards++;
        workspace.comment = message;
        return { ok: true, detail: "written", comment: message, unread: true };
      },
    } satisfies Partial<SessionRuntime>;
    const state = {
      root: h.root,
      runtime,
      machine: { ...h.config, runtimeTimeoutMs: 1000 },
    } as unknown as ApplyState;
    const report = await tick(h, state, {
      ok: true,
      source: "test",
      workspaces: [workspace],
    });
    expect(
      report.notifications.map((n) => [n.channel ?? ORCA_CARD, n.outcome]),
    ).toEqual([
      [ORCA_CARD, "sent"],
      ["phone", "sent"],
    ]);
    expect(cards).toBe(1);
    expect(h.hook.posts).toHaveLength(1);
    expect(
      stateDb(h.root)
        .query("SELECT key FROM log WHERE bucket = ?")
        .all(`event: ${NOTICES_READ}`),
    ).toHaveLength(1);
  });
});
