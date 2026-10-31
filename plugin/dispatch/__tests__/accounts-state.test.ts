import { describe, expect, it } from "bun:test";
import { admitRearm, slotTable } from "../lib/accounts.ts";
import type { ReadRecord } from "../lib/launches.ts";
import type { MachineAccount } from "../lib/machine-config.ts";

const account = (name: string): MachineAccount => ({
  name,
  vendor: "claude",
  configDir: "/tmp/shared-config",
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
    },
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
    expect(table[0]?.wallNames).toEqual(["b", "a"]);
  });
});
