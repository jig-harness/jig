/** Shared inputs for the line's tests: a repository's report, a tick's input and a launch record. */
import type { ReadRecord } from "../lib/launches.ts";
import type { LineInput, RepoStored } from "../lib/line.ts";
import type { MachineConfig } from "../lib/machine-config.ts";
import type { RepoReport } from "../lib/types.ts";

export const REPO = "example-org/web";
export const PATH = "/srv/work/web";
export const NOW = "2026-11-03T16:45:00.000Z";

export function report(fields: Partial<RepoReport> = {}): RepoReport {
  return {
    path: PATH,
    slug: REPO,
    refused: null,
    section: null,
    followupSince: null,
    records: [],
    actions: [],
    running: [],
    unplaced: [],
    launches: [],
    notifications: [],
    quiet: [],
    ...fields,
  };
}

export const MACHINE: MachineConfig = {
  path: "/home/person/.jig/dispatch.yaml",
  repositories: [
    {
      path: PATH,
      stages: ["rearm", "notify"],
      followupSince: null,
      owner: true,
    },
  ],
  accounts: [],
  intervalMs: 300_000,
  wallBackoffMs: 3_600_000,
  runtimeTimeoutMs: 60_000,
  workspaceTimeoutMs: 60_000,
  opensPerTick: 4,
  receiptsDays: 30,
  dashboardListen: null,
  sharedRecords: "forge",
  send: true,
};

export const NOTHING_STORED: RepoStored = {
  nudges: [],
  holds: [],
  notified: new Map(),
};

export function input(fields: Partial<LineInput> = {}): LineInput {
  return {
    runId: "run",
    startedAt: "2026-11-03T16:44:00.000Z",
    finishedAt: NOW,
    exitStatus: 0,
    apply: true,
    applyWithheld: null,
    plugin: "1.2.3",
    timeZone: "UTC",
    machine: MACHINE,
    reports: [report()],
    inputs: new Map(),
    stored: () => NOTHING_STORED,
    records: [],
    accounts: [],
    lastAccount: null,
    recentTicksMs: [],
    ...fields,
  };
}

export function record(
  fields: Partial<ReadRecord["record"]> = {},
  state: ReadRecord["state"] = {
    kind: "alive",
    process: {
      hostId: "",
      host: "h",
      bootId: "b",
      pid: 1,
      start: "s",
      claimedAt: "2026-11-03T15:30:00.000Z",
    },
  },
): ReadRecord {
  return {
    record: {
      version: 1,
      id: "20261103T153000Z-aaaaaaaa",
      token: "t",
      action: "rearm",
      repo: REPO,
      repoPath: PATH,
      pr: 456,
      item: null,
      account: "work-a",
      vendor: "claude",
      configDir: "/c",
      wallBackoffMs: 0,
      passTimeoutSec: 5400,
      replaces: null,
      facts: "f",
      createdAt: "2026-11-03T15:30:00.000Z",
      workspace: { id: "w", path: "/srv/work/web/pr-456" },
      attempts: [],
      agentId: null,
      model: null,
      effort: null,
      released: false,
      command: null,
      marker: null,
      ...fields,
    },
    state,
    result: null,
  };
}
