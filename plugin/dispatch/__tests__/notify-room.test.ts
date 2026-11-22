/**
 * Room in the notices comment: an unread comment the dispatcher wrote gives
 * up the entries whose causes are settled so a standing cause still goes,
 * one that finds no room waits without failing, counted in the comment's
 * summary entry when that fits, and a tick in which every cause waited does
 * not count as having written the workspace.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplyState } from "../lib/actions/launch.ts";
import { recordComment } from "../lib/actions/notices-content.ts";
import { applyNotices } from "../lib/actions/notify.ts";
import { failureCauses } from "../lib/failure-notices.ts";
import {
  actionBook,
  type FailureSettings,
  readFailures,
} from "../lib/failures.ts";
import { carries } from "../lib/notices.ts";
import { noticeComment } from "../lib/runtime/notice-comment.ts";
import { NO_ROOM } from "../lib/runtime/notice-overflow.ts";
import {
  MAX_COMMENT,
  NOTICES_BRANCH,
  NOTICES_NAME,
  type SessionRuntime,
  type Workspace,
} from "../lib/runtime/port.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";
import type { Action, RepoReport, RepoTarget } from "../lib/types.ts";

const SLUG = "example/project";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jig-notify-room-"));
  roots.push(root);
  return root;
}

/** An entry as a message carries it: its key line, then `size` characters of text. */
function entry(key: string, size: number): string {
  return `[jig dispatch: ${key}]\n${"x".repeat(size)}`;
}

function cause(key: string, size: number, target = key): Action {
  return {
    stage: "notify",
    target,
    cause: "parked",
    reason: "notice",
    record: "forge",
    evidence: {},
    notice: { key, text: entry(key, size) },
  } as unknown as Action;
}

function reportOf(actions: Action[]): RepoReport {
  return {
    path: "/repo",
    slug: SLUG,
    defaultBranch: "main",
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
  } as unknown as RepoReport;
}

/** A suppression record, as an earlier tick that sent the cause wrote it. */
function sentEarlier(
  root: string,
  workspace: string,
  key: string,
  target = key,
  lasting = false,
): void {
  stateDb(root)
    .query(
      "INSERT INTO notices (repo, key, target, workspace, at, lasting) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(SLUG, key, target, workspace, "2026-11-10T10:00:00.000Z", lasting);
}

/** A runtime whose `notify` merges as Orca's does: the card read under its lock, the settled entries given up only from the exact comment the sender found them in. */
function fakeRuntime(card: { comment: string; unread: boolean }) {
  return {
    async notify(target, message) {
      const merged = noticeComment(
        card,
        message,
        target.dispatcherOnly === true &&
          card.comment !== target.replaceReadComment,
        new Set(
          target.settled !== undefined &&
            card.comment === target.settled.comment
            ? target.settled.keys
            : [],
        ),
      );
      if (merged !== null && merged.length > MAX_COMMENT)
        return { ok: false, lost: false, detail: "too long; nothing written" };
      const owned =
        merged !== null &&
        (target.prepareComment?.(card.comment, merged, card.unread) ?? false);
      if (merged !== null) {
        card.comment = merged;
        card.unread = true;
      }
      return {
        ok: true,
        detail: "written",
        comment: card.comment,
        unread: card.unread,
        ownedComment: owned,
      };
    },
  } satisfies Partial<SessionRuntime>;
}

function noticesWorkspace(root: string, comment: string): Workspace {
  return {
    id: "notices",
    path: join(root, "notices"),
    branch: NOTICES_BRANCH,
    prs: [],
    items: [],
    agents: [],
    unverifiableTerminals: 0,
    comment,
    unread: true,
    name: NOTICES_NAME,
  };
}

const REPO: RepoTarget = { path: "/repo", slug: SLUG, defaultBranch: "main" };
const SETTINGS = { branch: null, lingerMs: 0, renotifyAfterMs: 0 };

describe("an unread notices comment at the limit", () => {
  it("gives up its settled entries so a new cause goes on the same tick, keeping every entry whose cause stands", async () => {
    const root = newRoot();
    const path = join(root, "notices");
    // Six entries about pull requests long closed, one ready notice whose
    // pull request closed, and one park that still waits.
    const settled = Array.from({ length: 6 }, (_, i) =>
      entry(`${SLUG} PR #${i + 1} parked at old`, 2200),
    );
    const ready = entry(`${SLUG} PR #9 ready at abc`, 1000);
    const standing = entry(`${SLUG} PR #20 parked at now`, 1000);
    const comment = [NOTICES_NAME, ...settled, ready, standing].join("\n\n");
    expect(comment.length).toBeGreaterThan(MAX_COMMENT - 500);
    expect(comment.length).toBeLessThanOrEqual(MAX_COMMENT);
    const workspace = noticesWorkspace(root, comment);
    recordComment(workspace, comment, root, SLUG);
    sentEarlier(root, path, `${SLUG} PR #20 parked at now`, "PR #20");
    sentEarlier(root, path, `${SLUG} PR #9 ready at abc`, "PR #9", true);
    const card = { comment, unread: true };
    const state = {
      root,
      runtime: fakeRuntime(card),
      machine: { runtimeTimeoutMs: 1000 },
    } as unknown as ApplyState;
    const report = reportOf([
      cause(`${SLUG} PR #20 parked at now`, 1000, "PR #20"),
      cause(`${SLUG} PR #21 parked at new`, 2000, "PR #21"),
    ]);
    await applyNotices(
      state,
      REPO,
      report,
      { ok: true, source: "test", workspaces: [workspace] },
      SETTINGS,
    );
    expect(
      report.notifications.map((n) => [n.key, n.outcome] as const),
    ).toEqual([
      [`${SLUG} PR #20 parked at now`, "suppressed"],
      [`${SLUG} PR #21 parked at new`, "sent"],
    ]);
    expect(card.comment).toBe(
      [
        NOTICES_NAME,
        standing,
        entry(`${SLUG} PR #21 parked at new`, 2000),
      ].join("\n\n"),
    );
  });

  it("keeps the whole of a comment a person added to, and lets the new cause wait", async () => {
    const root = newRoot();
    const settled = Array.from({ length: 7 }, (_, i) =>
      entry(`${SLUG} PR #${i + 1} parked at old`, 2200),
    );
    const comment = [NOTICES_NAME, ...settled, "A note of my own"].join("\n\n");
    // The dispatcher's record names the comment before the person's line.
    const workspace = noticesWorkspace(root, comment);
    recordComment(
      workspace,
      [NOTICES_NAME, ...settled].join("\n\n"),
      root,
      SLUG,
    );
    const card = { comment, unread: true };
    const state = {
      root,
      runtime: fakeRuntime(card),
      machine: { runtimeTimeoutMs: 1000 },
    } as unknown as ApplyState;
    const report = reportOf([
      cause(`${SLUG} PR #21 parked at new`, 2000, "PR #21"),
    ]);
    await applyNotices(
      state,
      REPO,
      report,
      { ok: true, source: "test", workspaces: [workspace] },
      SETTINGS,
    );
    expect(report.notifications.map((n) => n.outcome)).toEqual(["waits"]);
    expect(card.comment).toBe(comment);
  });
});

describe("a cause the comment has no room for", () => {
  const failures: FailureSettings = {
    backoffMs: 0,
    backoffMaxMs: 0,
    notifyAfter: 3,
    rerunDied: 1,
  };
  const held = `${SLUG} PR #21 parked at new`;
  // Four parks that all still wait fill the comment.
  const keys = [1, 2, 3, 4].map((n) => `${SLUG} PR #${n} parked at now`);

  /** Run `ticks` ticks against a comment the four standing parks fill; each tick's report. */
  async function heldTicks(root: string, ticks: number): Promise<RepoReport[]> {
    const path = join(root, "notices");
    const comment = [NOTICES_NAME, ...keys.map((k) => entry(k, 3900))].join(
      "\n\n",
    );
    expect(comment.length).toBeLessThanOrEqual(MAX_COMMENT);
    for (const [i, k] of keys.entries())
      sentEarlier(root, path, k, `PR #${i + 1}`);
    const card = { comment, unread: true };
    const state = {
      root,
      runtime: fakeRuntime(card),
      machine: { runtimeTimeoutMs: 1000 },
    } as unknown as ApplyState;
    const reports: RepoReport[] = [];
    for (let tick = 1; tick <= ticks; tick += 1) {
      const workspace = noticesWorkspace(root, card.comment);
      recordComment(workspace, card.comment, root, SLUG);
      const report = reportOf([
        ...keys.map((k, i) => cause(k, 3900, `PR #${i + 1}`)),
        cause(held, 500, "PR #21"),
      ]);
      await applyNotices(
        state,
        REPO,
        report,
        { ok: true, source: "test", workspaces: [workspace] },
        {
          ...SETTINGS,
          book: actionBook(SLUG, failures, () => undefined, root),
        },
      );
      expect(report.notifications.find((n) => n.key === held)?.outcome).toBe(
        "waits",
      );
      reports.push(report);
    }
    return reports;
  }

  it("is not raised as a failing delivery however many ticks it waits", async () => {
    const root = newRoot();
    const reports = await heldTicks(root, failures.notifyAfter + 1);
    // Four full parks leave no room for the summary either: it waits as full.
    expect(
      reports.at(-1)?.notifications.find((n) => n.key === held)?.detail,
    ).toBe(NO_ROOM);
    const rows = readFailures(SLUG, root);
    expect(rows).toEqual([]);
    expect(
      failureCauses(SLUG, "/repo", rows, { repositories: [], failures }),
    ).toEqual([]);
  });

  it("leaves a tick in which every cause waited from reporting its notices workspace as written", async () => {
    const root = newRoot();
    const [report] = await heldTicks(root, 1);
    expect(report?.noticesWorkspace).toEqual({
      workspace: join(root, "notices"),
      outcome: "kept",
      detail: `unread: ${keys[0]} still stands`,
    });
  });
});

describe("more standing causes than one comment holds", () => {
  const failures: FailureSettings = {
    backoffMs: 0,
    backoffMaxMs: 0,
    notifyAfter: 3,
    rerunDied: 1,
  };
  // A hundred causes of 900 characters each, a fifth of them stalled pickups.
  const many = Array.from({ length: 100 }, (_, i) => {
    const kind = i % 5 === 0 ? "stalled" : "parked";
    const c = cause(`${SLUG} PR #${i + 1} ${kind} at now`, 900, `PR #${i + 1}`);
    return { ...c, cause: kind } as Action;
  });
  const keyOf = (a: Action) => (a.notice as { key: string }).key;

  /** Run one tick against the card, the comment the dispatcher last wrote recorded as its own. */
  async function tick(
    root: string,
    card: { comment: string; unread: boolean },
  ): Promise<RepoReport> {
    const workspace = noticesWorkspace(root, card.comment);
    workspace.unread = card.unread;
    recordComment(workspace, card.comment, root, SLUG);
    const state = {
      root,
      runtime: fakeRuntime(card),
      machine: { runtimeTimeoutMs: 1000 },
    } as unknown as ApplyState;
    const report = reportOf([...many]);
    await applyNotices(
      state,
      REPO,
      report,
      { ok: true, source: "test", workspaces: [workspace] },
      { ...SETTINGS, book: actionBook(SLUG, failures, () => undefined, root) },
    );
    return report;
  }

  /** The comment's summary of the causes that wait: how many it counts, and the keys it lists. */
  function summaryOf(comment: string): {
    count: number;
    listed: string[];
    more: number;
  } {
    const count = /^(\d+) more notices? wait/m.exec(comment);
    expect(count).not.toBeNull();
    const listed = [...comment.matchAll(/^- PR #\d+: (.*)$/gm)].map(
      (m) => m[1] as string,
    );
    const more = /^and (\d+) more$/m.exec(comment);
    return {
      count: Number(count?.[1]),
      listed,
      more: more === null ? 0 : Number(more[1]),
    };
  }

  /** Every cause is in the comment in full or counted by its summary, which lists only held ones. */
  function expectAllVisible(comment: string): void {
    expect(comment.length).toBeLessThanOrEqual(MAX_COMMENT);
    const full = many.filter((c) => carries(comment, keyOf(c))).map(keyOf);
    const held = many.map(keyOf).filter((k) => !full.includes(k));
    expect(held.length).toBeGreaterThan(0);
    const summary = summaryOf(comment);
    expect(summary.count).toBe(held.length);
    expect(summary.listed.length).toBeGreaterThan(0);
    for (const k of summary.listed) expect(held).toContain(k);
    expect(summary.listed.length + summary.more).toBe(held.length);
    expect(comment).toContain("the counts above are complete");
    expect(comment).toContain("stalled: ");
  }

  it("ends a tick with every one in the notices comment, in full or counted in its summary", async () => {
    const root = newRoot();
    const card = { comment: NOTICES_NAME, unread: true };
    const report = await tick(root, card);
    expectAllVisible(card.comment);
    const waits = report.notifications.filter((n) => n.outcome === "waits");
    expect(waits.length).toBe(summaryOf(card.comment).count);
    for (const n of waits) expect(n.detail).toContain("summary entry");
  });

  it("keeps the summary of the same waiting causes as it is on the next tick", async () => {
    const root = newRoot();
    const card = { comment: NOTICES_NAME, unread: true };
    await tick(root, card);
    const first = card.comment;
    const report = await tick(root, card);
    expect(card.comment).toBe(first);
    expectAllVisible(card.comment);
    for (const n of report.notifications.filter((o) => o.outcome === "waits"))
      expect(n.detail).toContain("summary entry");
  });

  it("counts none held back for room as a failed delivery, however many ticks they wait", async () => {
    const root = newRoot();
    const card = { comment: NOTICES_NAME, unread: true };
    for (let i = 0; i <= failures.notifyAfter; i += 1) await tick(root, card);
    const rows = readFailures(SLUG, root);
    expect(rows).toEqual([]);
    expect(
      failureCauses(SLUG, "/repo", rows, { repositories: [], failures }),
    ).toEqual([]);
  });

  it("clears the failure row an earlier full comment left for a cause still held back", async () => {
    const root = newRoot();
    const card = { comment: NOTICES_NAME, unread: true };
    await tick(root, card);
    const held = many.map(keyOf).find((k) => !carries(card.comment, k));
    actionBook(SLUG, failures, () => undefined, root).ran(
      { key: `notice ${held}`, kind: "notice", target: "PR #99" },
      "the comment is full",
    );
    const rowOf = () =>
      readFailures(SLUG, root).find((r) => r.key === `notice ${held}`);
    expect(rowOf()).toBeDefined();
    await tick(root, card);
    expect(rowOf()).toBeUndefined();
    expect(readFailures(SLUG, root)).toEqual([]);
  });

  // A new cause changes the summary; the runtime answers the write of it as given.
  async function writeSummary(
    notifyFor: (card: {
      comment: string;
      unread: boolean;
    }) => SessionRuntime["notify"],
  ) {
    const root = newRoot();
    const card = { comment: NOTICES_NAME, unread: true };
    await tick(root, card);
    const extra = cause(`${SLUG} PR #101 parked at now`, 900, "PR #101");
    const workspace = noticesWorkspace(root, card.comment);
    recordComment(workspace, card.comment, root, SLUG);
    const state = {
      root,
      runtime: { notify: notifyFor(card) } satisfies Partial<SessionRuntime>,
      machine: { runtimeTimeoutMs: 1000 },
    } as unknown as ApplyState;
    const report = reportOf([...many, extra]);
    await applyNotices(
      state,
      REPO,
      report,
      { ok: true, source: "test", workspaces: [workspace] },
      { ...SETTINGS, book: actionBook(SLUG, failures, () => undefined, root) },
    );
    const key = keyOf(extra);
    return {
      notification: report.notifications.find((n) => n.key === key),
      row: readFailures(SLUG, root).find((r) => r.key === `notice ${key}`),
      card,
    };
  }

  it("counts the causes it held back as lost when the write that carries their summary fails", async () => {
    const { notification, row } = await writeSummary(() => async () => ({
      ok: false,
      lost: true,
      detail: "the write timed out",
    }));
    expect(notification).toMatchObject({
      outcome: "lost",
      detail: "the write timed out",
    });
    expect(row).toBeDefined();
  });

  it("counts the causes it held back as lost when the write succeeds but its read-back lacks their summary", async () => {
    // The read-back is the first tick's comment, carrying the old summary, not the planned one.
    const { notification, row } = await writeSummary((card) => async () => ({
      ok: true,
      detail: "written",
      comment: card.comment,
      unread: card.unread,
    }));
    expect(notification).toMatchObject({
      outcome: "lost",
      detail: expect.stringContaining("does not carry the summary"),
    });
    expect(row).toBeDefined();
  });

  it("refills a comment a person read with the causes that wait and a summary of the rest, within the limit", async () => {
    const root = newRoot();
    const card = { comment: NOTICES_NAME, unread: true };
    await tick(root, card);
    const first = card.comment;
    card.unread = false;
    await tick(root, card);
    expect(card.comment).not.toBe(first);
    expect(card.unread).toBe(true);
    // The causes the first comment carried in full were read; the rest are now in full or summarized.
    const read = many.map(keyOf).filter((k) => carries(first, k));
    const waiting = many.filter((c) => !read.includes(keyOf(c)));
    const full = waiting.filter((c) => carries(card.comment, keyOf(c)));
    expect(full.length).toBeGreaterThan(0);
    const summary = summaryOf(card.comment);
    expect(summary.count).toBe(waiting.length - full.length);
    expect(card.comment.length).toBeLessThanOrEqual(MAX_COMMENT);
    expect(card.comment).toContain("the counts above are complete");
  });
});
