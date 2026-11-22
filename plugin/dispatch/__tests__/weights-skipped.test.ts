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
import {
  applyNotices,
  retireStaleWeightsRecords,
} from "../lib/actions/notify.ts";
import {
  skippedWeightsCause,
  WEIGHTS_SKIP_KEY,
  standingWeightsKeys,
} from "../lib/failure-notices.ts";
import { readAccountWeights, readLocalWeights } from "../lib/local-weights.ts";
import type { MachineAccount } from "../lib/machine-config.ts";
import { noticeComment } from "../lib/runtime/notice-comment.ts";
import {
  NOTICES_BRANCH,
  NOTICES_NAME,
  type SessionRuntime,
  type Workspace,
} from "../lib/runtime/port.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";
import { storedWeightsKeys, suppress } from "../lib/notice-records.ts";
import type { RepoReport, RepoTarget } from "../lib/types.ts";

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

const REPO: RepoTarget = { path: "/repo", slug: "o/r", defaultBranch: "main" };

/** A notices card the runtime merges each message into, as Orca's does, and the messages it took. */
function noticesCard(root: string) {
  const card = { comment: NOTICES_NAME, unread: false };
  const sent: unknown[] = [];
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
  return { state, workspace, sent, root };
}

/** One tick's notices at `repo`, with the weights file as it now reads: each notification's outcome. The skipped-names cause is planned only where `home`. */
async function tick(
  file: string,
  { state, workspace, root }: ReturnType<typeof noticesCard>,
  { repo = REPO, home = true, standing = true } = {},
): Promise<string[]> {
  const read = readAccountWeights(accounts, readLocalWeights(file));
  const cause = skippedWeightsCause(read, machine);
  const report = {
    path: repo.path,
    slug: repo.slug,
    records: [],
    unplaced: [],
    notifications: [],
    actions: home && cause !== null ? [cause] : [],
  } as unknown as RepoReport;
  // The tick retires stale records once, before any repository's notices.
  if (standing)
    retireStaleWeightsRecords(standingWeightsKeys(read, machine), root);
  await applyNotices(
    state,
    repo,
    report,
    { ok: true, source: "test", workspaces: [workspace()] },
    {
      branch: null,
      lingerMs: 0,
      renotifyAfterMs: 0,
      ...(standing ? { hostStanding: standingWeightsKeys(read, machine) } : {}),
    },
  );
  return report.notifications.map((n) => n.outcome);
}

describe("an unknown account name in the weights file", () => {
  it("is skipped while the known accounts keep their weights and admission goes on", () => {
    const read = weights("accounts: {a: 0, b: 50, retired: 25}");
    expect([...read.values()].map((w) => w.configured)).toEqual([0, 50, 100]);
    const table = slotTable(accounts, [], 0, "/nonexistent-state-root", read);
    for (const report of table.map((slots) => weightReport(slots)))
      expect(report.reason).toContain("skipped an unknown account retired in");
    const admitted = admitRearm(table, null, PASS);
    expect(admitted).toEqual({ admitted: expect.anything() });
    expect(["b", "c"]).toContain(
      "admitted" in admitted ? admitted.admitted.account.name : "",
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
});

describe("the notice of skipped account names", () => {
  it("is one host notice keyed by the skipped names, naming the accounts listed", () => {
    const cause = skippedWeightsCause(
      weights("accounts: {zed: 1, a: 0, old: 3}"),
      machine,
    );
    expect(cause?.cause).toBe("host-failing");
    expect(cause?.notice?.key).toBe('host weights skip "old", "zed"');
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
    const card = noticesCard(scratch());
    const file = join(scratch(), "weights.local.yaml");
    writeFileSync(file, "accounts: {a: 0, old: 3}");
    expect(await tick(file, card)).toEqual(["sent"]);
    expect(await tick(file, card)).toEqual(["suppressed"]);
    expect(card.sent).toHaveLength(1);
  });

  it("is not told again when the host's home moves to another repository", async () => {
    const root = scratch();
    const card = noticesCard(root);
    const elsewhere = noticesCard(root);
    const file = join(scratch(), "weights.local.yaml");
    writeFileSync(file, "accounts: {a: 0, old: 3}");
    const other: RepoTarget = {
      path: "/other",
      slug: "o/other",
      defaultBranch: "main",
    };
    expect(await tick(file, card)).toEqual(["sent"]);
    expect(await tick(file, card, { home: false })).toEqual([]);
    expect(await tick(file, elsewhere, { repo: other })).toEqual([
      "suppressed",
    ]);
    expect([...card.sent, ...elsewhere.sent]).toHaveLength(1);
  });

  it("is told again on a home move when nothing holds its key standing", async () => {
    const root = scratch();
    const card = noticesCard(root);
    const elsewhere = noticesCard(root);
    const file = join(scratch(), "weights.local.yaml");
    writeFileSync(file, "accounts: {a: 0, old: 3}");
    const other: RepoTarget = {
      path: "/other",
      slug: "o/other",
      defaultBranch: "main",
    };
    const unheld = { standing: false };
    expect(await tick(file, card, unheld)).toEqual(["sent"]);
    expect(await tick(file, card, { ...unheld, home: false })).toEqual([]);
    expect(await tick(file, elsewhere, { ...unheld, repo: other })).toEqual([
      "sent",
    ]);
  });

  it("is told again at a new home after the file was fixed and the name came back", async () => {
    const root = scratch();
    const card = noticesCard(root);
    const elsewhere = noticesCard(root);
    const file = join(scratch(), "weights.local.yaml");
    writeFileSync(file, "accounts: {a: 0, old: 3}");
    const other: RepoTarget = {
      path: "/other",
      slug: "o/other",
      defaultBranch: "main",
    };
    expect(await tick(file, card)).toEqual(["sent"]);
    writeFileSync(file, "accounts: {a: 0}");
    expect(await tick(file, elsewhere, { repo: other, home: false })).toEqual(
      [],
    );
    writeFileSync(file, "accounts: {a: 0, old: 3}");
    expect(await tick(file, elsewhere, { repo: other })).toEqual(["sent"]);
  });
  it("retireStaleWeightsRecords keeps a record whose names still stand and drops it once they are gone", async () => {
    const root = scratch();
    const card = noticesCard(root);
    const file = join(scratch(), "weights.local.yaml");
    writeFileSync(file, "accounts: {a: 0, old: 3}");
    expect(await tick(file, card)).toEqual(["sent"]);
    expect(storedWeightsKeys(stateDb(root), "host weights skip ").size).toBe(1);
    const fixed = readAccountWeights(accounts, readLocalWeights(file));
    writeFileSync(file, "accounts: {a: 0}");
    const read = readAccountWeights(accounts, readLocalWeights(file));
    retireStaleWeightsRecords(standingWeightsKeys(fixed, machine), root);
    expect(storedWeightsKeys(stateDb(root), "host weights skip ").size).toBe(1);
    retireStaleWeightsRecords(standingWeightsKeys(read, machine), root);
    expect(storedWeightsKeys(stateDb(root), "host weights skip ").size).toBe(0);
    retireStaleWeightsRecords(null, root);
  });

  it("keeps its record while the weights file is unreadable, and stays told once when the same names return", async () => {
    const root = scratch();
    const card = noticesCard(root);
    const file = join(scratch(), "weights.local.yaml");
    writeFileSync(file, "accounts: {a: 0, old: 3}");
    expect(await tick(file, card)).toEqual(["sent"]);
    writeFileSync(file, "accounts: [");
    expect(
      standingWeightsKeys(
        readAccountWeights(accounts, readLocalWeights(file)),
        machine,
      ),
    ).toBeNull();
    expect(await tick(file, card, { home: false })).toEqual([]);
    writeFileSync(file, "accounts: {a: 0, old: 3}");
    expect(await tick(file, card)).toEqual(["suppressed"]);
    expect(card.sent).toHaveLength(1);
  });

  it("finds a weights record on a channel the tick no longer sends through", () => {
    const root = scratch();
    suppress(
      "webhook-a",
      {
        repo: "o/r",
        key: 'host weights skip "old"',
        target: "t",
        workspace: "",
        at: "2026-01-01T00:00:00.000Z",
        lasting: false,
      },
      null,
      root,
      false,
    );
    expect([...storedWeightsKeys(stateDb(root), WEIGHTS_SKIP_KEY)]).toEqual([
      'host weights skip "old"',
    ]);
  });

  it("finds weights records on several channels, among many other notices", () => {
    const root = scratch();
    const record = (channel: string, key: string) =>
      suppress(
        channel,
        {
          repo: "o/r",
          key,
          target: "t",
          workspace: "",
          at: "2026-01-01T00:00:00.000Z",
          lasting: false,
        },
        null,
        root,
        false,
      );
    for (const channel of ["orca-card", "slack", "webhook-a", "zz"])
      for (let n = 0; n < 5; n++) record(channel, `o/r PR #${n} ready`);
    record("slack", 'host weights skip "a"');
    record("zz", 'host weights skip "b"');
    record("orca-card", 'host weights skip "c"');
    expect(
      [...storedWeightsKeys(stateDb(root), WEIGHTS_SKIP_KEY)].sort(),
    ).toEqual([
      'host weights skip "a"',
      'host weights skip "b"',
      'host weights skip "c"',
    ]);
  });
});
