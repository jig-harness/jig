import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplyState } from "../lib/actions/launch.ts";
import { applyNotices } from "../lib/actions/notify.ts";
import type { SessionRuntime, Workspace } from "../lib/runtime/port.ts";
import { closeStateDb } from "../lib/state.ts";
import type { RepoReport, RepoTarget } from "../lib/types.ts";

it("sizes failure notices against the ordinary delivery read-back", async () => {
  const root = mkdtempSync(join(tmpdir(), "jig-notice-capacity-"));
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
  let comment = "";
  const runtime = {
    async notify(_target, message) {
      const next = [comment, message].filter(Boolean).join("\n\n");
      if (next.length > 16_000)
        return { ok: false, detail: "comment too long" };
      comment = next;
      return { ok: true, detail: "written", comment, unread: true };
    },
  } satisfies Partial<SessionRuntime>;
  const repo: RepoTarget = {
    path: root,
    slug: "example/project",
    defaultBranch: "main",
  };
  const state = {
    root,
    runtime,
    machine: { runtimeTimeoutMs: 1000 },
  } as unknown as ApplyState;
  const actions = [
    { cause: "parked", key: "ordinary", size: 12_000 },
    { cause: "action-failing", key: "failure-one", size: 3_000 },
    { cause: "action-failing", key: "failure-two", size: 3_000 },
  ].map(({ cause, key, size }) => ({
    stage: "notify",
    target: key,
    cause,
    reason: "notice",
    record: "forge",
    evidence: {},
    notice: { key, text: `[jig dispatch: ${key}]\n` + "x".repeat(size) },
  }));
  const report = {
    ...repo,
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
  try {
    await applyNotices(
      state,
      repo,
      report,
      { ok: true, source: "test", workspaces: [workspace] },
      { branch: null, lingerMs: 0, renotifyAfterMs: 0 },
    );
    expect(report.notifications.map((n) => n.outcome)).toEqual([
      "sent",
      "waits",
      "sent",
    ]);
    expect(comment).toContain("[jig dispatch: failure-one]");
    expect(comment).not.toContain("[jig dispatch: failure-two]");
  } finally {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});
