import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitRearm,
  admitTakeover,
  refreshWalls,
  slotsOf,
  slotTable,
} from "../lib/accounts.ts";
import { writeWall } from "../lib/walls.ts";
import type { ReadRecord } from "../lib/launches.ts";
import type { MachineAccount } from "../lib/machine-config.ts";

const account = (
  name: string,
  configDir = "/tmp/shared-config",
): MachineAccount => ({
  name,
  vendor: "claude",
  configDir,
  identity: "me@example.com",
  maxPerAccount: 2,
});

const process = {
  host: "h",
  bootId: "b",
  pid: 1,
  start: "s",
  claimedAt: "2026-01-01T00:00:00.000Z",
};

function read(accountName: string, state: ReadRecord["state"]): ReadRecord {
  return {
    state,
    record: {
      version: 1,
      id: `id-${accountName}`,
      token: "t",
      action: "rearm",
      repo: "o/r",
      repoPath: "/tmp/r",
      pr: 1,
      account: accountName,
      vendor: "claude",
      configDir: "/tmp/shared-config",
      wallBackoffMs: 1000,
      replaces: null,
      facts: "f",
      createdAt: "2026-01-01T00:00:00.000Z",
      workspace: null,
      attempts: [],
      item: null,
      agentId: null,
      model: null,
      effort: null,
      released: false,
    },
    result: null,
  };
}

describe("account admission state", () => {
  it("closes an account whose launch ended on a wall that was never recorded", () => {
    const table = slotTable(
      [account("a")],
      [
        read("a", {
          kind: "unknown",
          reason: "wall",
          process,
          wallUnrecorded: true,
        }),
      ],
      Date.now(),
      "/nonexistent-state-root",
    );
    expect(admitRearm(table, null)).toEqual({
      waits: expect.stringContaining("wall not recorded"),
    });
  });

  it("keeps a renamed account's held slots", () => {
    const table = slotTable(
      [account("b")],
      [read("a", { kind: "alive", process })],
      Date.now(),
      "/nonexistent-state-root",
    );
    expect(table[0]?.held).toBe(1);
  });

  it("bills a record to the account at its directory when its name now names another", () => {
    const table = slotTable(
      [account("a", "/config/Y"), account("b", "/config/shared")],
      [read("a", { kind: "alive", process })].map((r) => ({
        ...r,
        record: { ...r.record, configDir: "/config/shared" },
      })),
      Date.now(),
      "/nonexistent-state-root",
    );
    expect(table.map((s) => s.held)).toEqual([0, 1]);
  });

  it("keeps a renamed account's wall after the records that carried the old name are gone", () => {
    const root = mkdtempSync(join(tmpdir(), "walls-"));
    const resetAt = new Date(Date.now() + 3600_000).toISOString();
    writeWall(
      {
        account: "a",
        vendor: "claude",
        configDir: "/tmp/shared-config",
        resetAt,
        source: "t",
      },
      root,
    );
    const table = slotTable([account("b")], [], Date.now(), root);
    expect(table[0]?.wall?.resetAt).toBe(resetAt);
  });

  it("admits a takeover on an account renamed since the record", () => {
    const replaced = read("a", { kind: "alive", process });
    const table = slotTable(
      [account("b")],
      [replaced],
      Date.now(),
      "/nonexistent-state-root",
    );
    expect(slotsOf(table, replaced.record)?.account.name).toBe("b");
    expect(admitTakeover(table, replaced)).toEqual({
      admitted: table[0] as (typeof table)[number],
    });
  });

  it("closes an account when a wrapper's exit says its wall was not recorded after the table was built", () => {
    const root = mkdtempSync(join(tmpdir(), "launch-"));
    const record = read("a", { kind: "alive", process });
    const table = slotTable(
      [account("a"), account("b", "/other")],
      [record],
      Date.now(),
      root,
    );
    expect(table[0]?.wallUnrecorded).toBe(false);
    mkdirSync(join(root, "launches"), { recursive: true });
    writeFileSync(
      join(root, "launches", `${record.record.id}.exit`),
      JSON.stringify({
        at: "2026-01-01T00:00:00.000Z",
        code: 16,
        signal: null,
        wallUnrecorded: true,
      }),
    );
    refreshWalls(table, [record], Date.now(), root);
    expect(table[0]?.wallUnrecorded).toBe(true);
  });
});
