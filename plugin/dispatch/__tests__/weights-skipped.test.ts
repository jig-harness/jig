/**
 * A weights file that names an account the machine file does not list: the
 * name is skipped, every other weight applies, admission goes on, and the
 * host is told once per set of skipped names.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitRearm, slotTable } from "../lib/accounts.ts";
import { weightReport } from "../lib/account-report.ts";
import type { ApplyState } from "../lib/actions/launch.ts";
import { applyNotices } from "../lib/actions/notify.ts";
import { skippedWeightsCause } from "../lib/failure-notices.ts";
import { readAccountWeights, readLocalWeights } from "../lib/local-weights.ts";
import type { MachineAccount } from "../lib/machine-config.ts";
import { noticeComment } from "../lib/runtime/notice-comment.ts";
import {
  NOTICES_BRANCH,
  NOTICES_NAME,
  type SessionRuntime,
  type Workspace,
} from "../lib/runtime/port.ts";
import { closeStateDb } from "../lib/state.ts";
import type { Action, RepoReport, RepoTarget } from "../lib/types.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "jig-weights-skipped-"));
  roots.push(root);
  return root;
}

const accounts: MachineAccount[] = ["a", "b", "c"].map((name) => ({
  name,
  vendor: "claude",
  configDir: `/config/${name}`,
  identity: name,
  maxPerAccount: 1000,
}));
const machine = { accounts };
const PASS = { kind: "pass", deadlineSec: 5400, codex: { on: true } } as const;

function weights(text: string) {
  const path = join(scratch(), "weights.local.yaml");
  writeFileSync(path, text);
  return readAccountWeights(accounts, readLocalWeights(path));
}

describe("an unknown account name in the weights file", () => {
  it("is skipped while the known accounts keep their weights and admission goes on", () => {
    const read = weights("accounts: {a: 0, b: 50, retired: 25}");
    expect([...read.values()].map((w) => w.configured)).toEqual([0, 50, 100]);
    const table = slotTable(accounts, [], 0, "/nonexistent-state-root", read);
    for (const report of table.map((slots) => weightReport(slots)))
      expect(report.reason).toContain("skipped an unknown account retired in");
    const admitted = admitRearm(table, null, PASS);
    expect("admitted" in admitted && admitted.admitted.account.name).not.toBe(
      "a",
    );
  });

  it("still closes every account for any other fault", () => {
    for (const text of [
      "accounts: [",
      "acounts: {a: 0}",
      "accounts: [a]",
      "accounts: {a: 101, retired: 25}",
      "accounts: {b: nope}",
    ])
      expect(
        [...weights(text).values()].every((w) => w.configured === null),
      ).toBe(true);
  });

  it("frames one host notice keyed by the skipped names and the accounts listed", () => {
    const cause = skippedWeightsCause(
      weights("accounts: {zed: 1, a: 0, old: 3}"),
      machine,
    );
    expect(cause?.cause).toBe("host-failing");
    expect(cause?.notice?.key).toBe("host weights skip old, zed");
    expect(cause?.notice?.text).toContain("The machine file lists: a, b, c.");
    expect(cause?.notice?.text).toContain("weights.local.yaml");
    expect(
      skippedWeightsCause(weights("accounts: {a: 0}"), machine),
    ).toBeNull();
    expect(
      skippedWeightsCause(weights("accounts: {a: 101, old: 3}"), machine),
    ).toBeNull();
  });

  it("is sent once: the next tick with the same file sends nothing", async () => {
    const root = scratch();
    const card = { comment: NOTICES_NAME, unread: false };
    const sent: string[] = [];
    const runtime = {
      async notify(_target, message) {
        sent.push(message);
        card.comment =
          noticeComment(card, message, false, new Set()) ?? card.comment;
        card.unread = true;
        return {
          ok: true,
          detail: "written",
          comment: card.comment,
          unread: true,
        };
      },
    } satisfies Partial<SessionRuntime>;
    const state = {
      root,
      runtime,
      machine: { runtimeTimeoutMs: 1000, workspaceTimeoutMs: 1000 },
    } as unknown as ApplyState;
    const workspace = (): Workspace => ({
      id: "notices",
      path: join(root, "notices"),
      branch: NOTICES_BRANCH,
      prs: [],
      items: [],
      agents: [],
      unverifiableTerminals: 0,
      comment: card.comment,
      unread: card.unread,
      name: NOTICES_NAME,
    });
    const repo: RepoTarget = {
      path: "/repo",
      slug: "o/r",
      defaultBranch: "main",
    };
    const file = join(scratch(), "weights.local.yaml");
    writeFileSync(file, "accounts: {a: 0, old: 3}");
    const tick = async () => {
      const cause = skippedWeightsCause(
        readAccountWeights(accounts, readLocalWeights(file)),
        machine,
      ) as Action;
      const report = {
        path: "/repo",
        slug: "o/r",
        records: [],
        unplaced: [],
        notifications: [],
        actions: [cause],
      } as unknown as RepoReport;
      await applyNotices(
        state,
        repo,
        report,
        { ok: true, source: "test", workspaces: [workspace()] },
        { branch: null, lingerMs: 0, renotifyAfterMs: 0 },
      );
      return report.notifications.map((n) => n.outcome);
    };
    expect(await tick()).toEqual(["sent"]);
    expect(await tick()).toEqual(["suppressed"]);
    expect(sent).toHaveLength(1);
  });
});
