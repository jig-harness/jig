/**
 * dispatch --apply: a channel whose start state cannot be read is neither
 * started nor sent on, so a transient read failure never floods a new
 * channel with the causes that already stand.
 */
import { afterEach, expect, it, mock, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delivery, NotificationChannel } from "../../chat/channel.ts";
import type { ApplyState } from "../lib/actions/launch.ts";
import type { SessionRuntime, Workspace } from "../lib/runtime/port.ts";
import { closeStateDb } from "../lib/state.ts";
import type { Action, RepoReport, RepoTarget } from "../lib/types.ts";

const actual = await import("../lib/notice-records.ts");
mock.module("../lib/notice-records.ts", () => ({
  ...actual,
  channelStarted: () => {
    throw new Error("database is locked");
  },
}));
const { applyNotices } = await import("../lib/actions/notify.ts");
type Cause =
  Parameters<
    typeof applyNotices
  >[4]["channels"][number] extends NotificationChannel<infer C>
    ? C
    : never;

const SLUG = "example-org/example-repo";
const roots: string[] = [];
afterEach(() => {
  setSystemTime();
  for (const root of roots.splice(0)) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

it("sends nothing on a channel whose start state cannot be read, and says so", async () => {
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
    async notify() {
      return { ok: true, detail: "written", comment: "", unread: true };
    },
  } satisfies Partial<SessionRuntime>;
  const state = {
    root,
    runtime,
    machine: { runtimeTimeoutMs: 1000 },
  } as unknown as ApplyState;
  const repo: RepoTarget = { path: root, slug: SLUG, defaultBranch: "main" };
  const calls: Cause[][] = [];
  const phone: NotificationChannel<Cause> = {
    name: "phone",
    unreachable: () => null,
    async deliver(due): Promise<Delivery[]> {
      calls.push([...due]);
      return due.map((c) => ({
        key: c.notice.key,
        outcome: "sent",
        place: "#notices",
        detail: "posted",
      }));
    },
  };
  const key = `${SLUG} PR #1 parked, ledger generation 3: finding F1`;
  const action = {
    stage: "notify",
    target: "PR #1",
    cause: "parked",
    reason: "a decision waits",
    record: "forge",
    evidence: {},
    notice: { key, text: `[jig dispatch: ${key}]\nWhich budget?` },
  } as Action;
  const r: RepoReport = {
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
    actions: [action],
  };
  await applyNotices(
    state,
    repo,
    r,
    { ok: true, source: "test", workspaces: [workspace] },
    {
      branch: null,
      lingerMs: 3_600_000,
      renotifyAfterMs: 0,
      channels: [phone],
    },
  );
  expect(calls).toEqual([]);
  expect(r.channelStarts).toBeUndefined();
  expect(
    r.unplaced.some((u) => u.reason.includes("start state could not be read")),
  ).toBe(true);
});
