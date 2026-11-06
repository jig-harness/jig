import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApplyState, enforcedDeadlineMs } from "../lib/actions/launch.ts";
import { applyNotices } from "../lib/actions/notify.ts";
import type { MachineConfig } from "../lib/machine-config.ts";
import type { SessionRuntime, Workspace } from "../lib/runtime/port.ts";
import { closeStateDb } from "../lib/state.ts";
import type { RepoReport, RepoTarget } from "../lib/types.ts";

it.each([
  { afterOpen: 1500, afterRead: 1500, reads: 0, writes: 0 },
  { afterOpen: 2500, afterRead: 500, reads: 1, writes: 0 },
  { afterOpen: 3500, afterRead: 1500, reads: 1, writes: 1 },
])("preserves the receipt through the notices path (%j)", async (scenario) => {
  const root = mkdtempSync(join(tmpdir(), "jig-notice-deadline-"));
  const repo: RepoTarget = {
    path: root,
    slug: "example-org/example-repo",
    defaultBranch: "main",
  };
  const machine = {
    workspaceTimeoutMs: 1000,
    runtimeTimeoutMs: 1000,
    opensPerTick: 4,
    repositories: [{ stages: ["notify"] }],
  } as MachineConfig;
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
  let reads = 0;
  let writes = 0;
  const remaining = (ms: number) => {
    state.startedAt = Date.now() - enforcedDeadlineMs(machine) + 1000 + ms;
  };
  const runtime = {
    async openWorkspace() {
      remaining(scenario.afterOpen);
      return { ok: true, detail: "opened", workspace };
    },
    async sessions() {
      reads++;
      remaining(scenario.afterRead);
      return { ok: true, source: "test", workspaces: [workspace] };
    },
    async notify(_target, message) {
      writes++;
      return { ok: true, detail: "written", comment: message, unread: true };
    },
  } satisfies Partial<SessionRuntime>;
  const state = { machine, runtime, root } as unknown as ApplyState;
  remaining(10_000);
  const report: RepoReport = {
    path: root,
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
        reason: "needs a decision",
        record: "forge",
        evidence: {},
        notice: { key: "deadline-test", text: "[jig dispatch: deadline-test]" },
      },
    ],
  };
  try {
    await applyNotices(
      state,
      repo,
      report,
      { ok: true, source: "test", workspaces: [] },
      { branch: null, lingerMs: 0, renotifyAfterMs: 0 },
    );
    expect(reads).toBe(scenario.reads);
    expect(writes).toBe(scenario.writes);
    expect(report.notifications).toEqual([
      expect.objectContaining({ outcome: scenario.writes ? "sent" : "waits" }),
    ]);
  } finally {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});
