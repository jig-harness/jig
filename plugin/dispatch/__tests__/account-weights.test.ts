import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitRearm, admitTakeover, slotTable } from "../lib/accounts.ts";
import { accountLaunchOrdinal } from "../lib/account-ordinal.ts";
import { weightReport } from "../lib/account-report.ts";
import { writeWall } from "../lib/walls.ts";
import { isoFromMs } from "../../shared/time.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import { readAccountWeights, readLocalWeights } from "../lib/local-weights.ts";
import type { MachineAccount } from "../lib/machine-config.ts";
import { record } from "./line-fixtures.ts";
import type { ReadRecord } from "../lib/launches.ts";

function entry<T>(values: readonly T[], index = 0): T {
  const value = values[index];
  if (value === undefined) throw new Error("fixture entry missing");
  return value;
}
const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function scratch() {
  const path = mkdtempSync(join(tmpdir(), "jig-weights-"));
  roots.push(path);
  return path;
}
const accounts: MachineAccount[] = ["a", "b"].map((name) => ({
  name,
  vendor: "claude",
  configDir: `/config/${name}`,
  identity: name,
  maxPerAccount: 1000,
}));
const PASS = { kind: "pass", deadlineSec: 5400, codex: { on: true } } as const;
function weights(text?: string) {
  const root = scratch();
  const path = join(root, "weights.local.yaml");
  if (text !== undefined) writeFileSync(path, text);
  return readAccountWeights(accounts, readLocalWeights(path));
}
function sequence(
  text: string | undefined,
  n = 400,
  listed = accounts,
  retain = Number.POSITIVE_INFINITY,
) {
  const root = scratch();
  const path = join(root, "weights.local.yaml");
  if (text !== undefined) writeFileSync(path, text);
  const configured = readAccountWeights(listed, readLocalWeights(path));
  const records: ReadRecord[] = [];
  let last: string | null = null;
  const selected: string[] = [];
  for (let i = 0; i < n; i++) {
    const table = slotTable(
      listed,
      [],
      0,
      "/nonexistent-state-root",
      configured,
    );
    const result = admitRearm(table, last, PASS, new Set(), records);
    if (!("admitted" in result)) throw new Error(result.waits);
    last = result.admitted.account.name;
    selected.push(last);
    records.push(
      record({
        accountLaunchOrdinal:
          accountLaunchOrdinal(records, result.admitted.account) + 1,
        id: `record-${i}`,
        account: last,
        configDir: `/config/${last}`,
      }),
    );
    if (records.length > retain) records.splice(0, records.length - retain);
  }
  return selected;
}

describe("host-local account weights", () => {
  it("keeps proportional shares when old records are continuously pruned", () => {
    const selected = sequence("accounts: {a: 75, b: 25}", 400, accounts, 8);
    expect(selected.filter((name) => name === "a")).toHaveLength(300);
    expect(selected.filter((name) => name === "b")).toHaveLength(100);
  });
  it("continues a renamed account from its persisted ordinal and accepts legacy-only histories", () => {
    const account = entry(accounts);
    const legacy = [
      record({ account: "old-name", configDir: account.configDir }),
    ];
    expect(accountLaunchOrdinal(legacy, account)).toBe(1);
    expect(
      accountLaunchOrdinal(
        [
          ...legacy,
          record({
            account: "old-name",
            configDir: account.configDir,
            accountLaunchOrdinal: 73,
          }),
        ],
        account,
      ),
    ).toBe(73);
  });
  it("keeps the exact old turn order when absent, including after a previous launch", () => {
    const table = slotTable(
      accounts,
      [],
      0,
      "/nonexistent-state-root",
      weights(),
    );
    expect(admitRearm(table, "a", PASS)).toMatchObject({
      admitted: { account: { name: "b" } },
    });
    entry(table, 1).held = 1000;
    expect(admitRearm(table, "a", PASS)).toMatchObject({
      admitted: { account: { name: "a" } },
    });
    expect(sequence(undefined, 8)).toEqual([
      "a",
      "b",
      "a",
      "b",
      "a",
      "b",
      "a",
      "b",
    ]);
  });
  it("names configured and effective weights for full and unsupported accounts", () => {
    const table = slotTable(
      accounts,
      [],
      0,
      "/nonexistent-state-root",
      weights("accounts: {a: 75, b: 25}"),
    );
    entry(table).held = entry(table).account.maxPerAccount;
    entry(table, 1).account = {
      ...entry(table, 1).account,
      vendor: "unsupported",
    };
    const result = admitRearm(table, null, PASS);
    expect(result).toEqual({
      waits: expect.stringContaining("a weight 75 (effective 0)"),
    });
    expect("waits" in result && result.waits).toContain(
      "b weight 25 (effective 0)",
    );
  });
  it("gives 75/25 accounts three launches in four (within one launch in 400)", () => {
    const selected = sequence("accounts: {a: 75, b: 25}");
    expect(
      Math.abs(selected.filter((name) => name === "a").length - 300),
    ).toBeLessThanOrEqual(1);
  });
  it("spreads unequal fractional weights over three accounts without constructing a period", () => {
    const listed = [
      ...accounts,
      { ...entry(accounts), name: "c", configDir: "/config/c" },
    ];
    const selected = sequence(
      "accounts: {a: 0.75, b: 0.2, c: 0.05}",
      4096,
      listed,
    );
    for (const [name, share] of [
      ["a", 0.75],
      ["b", 0.2],
      ["c", 0.05],
    ] as const)
      expect(
        Math.abs(
          selected.filter((value) => value === name).length / selected.length -
            share,
        ),
      ).toBeLessThan(0.002);
  });
  it("keeps proportional shares for subnormal weights", () => {
    const selected = sequence("accounts: {a: 5e-324, b: 1e-323}", 4096);
    expect(selected.filter((name) => name === "a").length).toBeGreaterThan(
      1364,
    );
    expect(selected.filter((name) => name === "a").length).toBeLessThan(1367);
    expect(selected.filter((name) => name === "b").length).toBeGreaterThan(
      2729,
    );
    expect(selected.filter((name) => name === "b").length).toBeLessThan(2733);
  });
  it("redistributes a full account's share without reserving slots or catching up on return", () => {
    const configured = weights("accounts: {a: 75, b: 25}");
    const table = slotTable(
      accounts,
      [],
      0,
      "/nonexistent-state-root",
      configured,
    );
    entry(table).held = 1000;
    const records = Array.from({ length: 100 }, (_, i) =>
      record({ id: `${i}`, account: "b", configDir: "/config/b" }),
    );
    expect(admitRearm(table, "b", PASS, new Set(), records)).toMatchObject({
      admitted: { account: { name: "b" } },
    });
    entry(table).held = 0;
    const selected: string[] = [];
    for (let i = 0; i < 16; i++) {
      const result = admitRearm(table, "b", PASS, new Set(), records);
      expect("admitted" in result).toBe(true);
      if (!("admitted" in result)) return;
      const name = result.admitted.account.name;
      selected.push(name);
      records.push(record({ account: name, configDir: `/config/${name}` }));
    }
    expect(selected.filter((name) => name === "a")).toHaveLength(12);
  });
  it("shows configured weight, effective zero and reset behind a wall, then the configured weight again", () => {
    const root = scratch();
    const configured = weights("accounts: {a: 75, b: 0}");
    writeWall(
      { account: "a", resetAt: isoFromMs(2000), source: "fixture" },
      root,
    );
    const table = slotTable(accounts, [], 1000, root, configured);
    expect(weightReport(entry(table))).toMatchObject({
      configured: 75,
      effective: 0,
      reason: expect.stringContaining(isoFromMs(2000)),
    });
    const waits = admitRearm(table, null, PASS);
    expect(waits).toEqual({
      waits: expect.stringContaining("a weight 75 (effective 0)"),
    });
    expect("waits" in waits && waits.waits).toContain("b weight 0");
    expect(
      weightReport(entry(slotTable(accounts, [], 2001, root, configured))),
    ).toMatchObject({ configured: 75, effective: 75 });
  });
  it.skipIf(
    skipsOnWindows("file-system", "a fixture symlink requires host privileges"),
  )("does not mistake a dangling symlink for an absent file", () => {
    const path = join(scratch(), "weights.local.yaml");
    symlinkSync(join(scratch(), "missing"), path);
    expect(readLocalWeights(path).document.ok).toBe(false);
  });
  it("reports an existing path that cannot be read as a file", () => {
    const path = join(scratch(), "weights.local.yaml");
    mkdirSync(path);
    expect(readLocalWeights(path).document.ok).toBe(false);
  });
  it("pauses new launches and a takeover while leaving the held count alone", () => {
    const configured = weights("accounts: {a: 0, b: 0}");
    const held = record({ account: "a", configDir: "/config/a" });
    const table = slotTable(
      accounts,
      [held],
      0,
      "/nonexistent-state-root",
      configured,
    );
    expect(table[0]?.held).toBe(1);
    const result = admitRearm(table, null, PASS);
    expect(result).toEqual({ waits: expect.stringContaining("a weight 0") });
    expect("waits" in result && result.waits).toContain("b weight 0");
    expect(admitTakeover(table, held, 5400, { on: true })).toEqual({
      waits: expect.stringContaining("weight 0"),
    });
    expect(sequence("accounts: {a: 0}", 8)).toEqual(Array(8).fill("b"));
  });
  it("fails closed on unreadable syntax, an unknown section and invalid values, independently of lanes", () => {
    for (const text of [
      "accounts: [",
      "acounts: {a: 0}",
      "accounts: {a: -1}",
      "accounts: {a: 101}",
      "accounts: {a: nope}",
    ])
      expect(
        [...weights(text).values()].every(
          (value) =>
            value.configured === null &&
            value.reason.includes("weights.local.yaml"),
        ),
      ).toBe(true);
    expect(
      weights("accounts: {a: 0}\nlanes: invalid").get("a")?.configured,
    ).toBe(0);
    expect(weights("lanes: invalid").get("a")?.configured).toBe(100);
  });
});
