/** An account's `stages`: what the machine file accepts, and how admission passes over an account that does not serve an action's stage. */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slotTable } from "../lib/accounts.ts";
import { serves } from "../lib/account-stages.ts";
import { admission } from "../lib/actions/admission.ts";
import { admitAccount, type ApplyState } from "../lib/actions/launch.ts";
import { takesPickup } from "../lib/tick-trackers.ts";
import type { ReadRecord } from "../lib/launches.ts";
import {
  type MachineAccount,
  parseMachineConfigText,
} from "../lib/machine-config.ts";
import type { Action } from "../lib/types.ts";

/** The machine file with one account whose entry ends with `extra`. */
function parsed(extra: string) {
  return parseMachineConfigText(
    `accounts:\n  - {name: work, vendor: claude, config_dir: /tmp/work, identity: me@example.com${extra}}\n`,
    "dispatch.yaml",
  );
}

describe("an account's stages in the machine file", () => {
  it("reads a left-out list as every stage", () => {
    const read = parsed("");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const work = read.value.accounts[0] as MachineAccount;
    expect(work.stages).toBeUndefined();
    for (const stage of ["pickup", "rearm", "followup", "steward"])
      expect(serves(work, stage)).toBe(true);
  });

  it("keeps a valid list", () => {
    const read = parsed(", stages: [pickup, followup]");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const work = read.value.accounts[0] as MachineAccount;
    expect(work.stages).toEqual(["pickup", "followup"]);
    expect(serves(work, "rearm")).toBe(false);
    expect(serves(work, "steward")).toBe(false);
  });

  for (const [value, says] of [
    ["[deploy]", "unknown stage deploy"],
    ["[pickup, pickup]", "lists pickup twice"],
    ["[]", "is empty"],
    ["[notify]", "names notify, a stage that launches no session"],
    ["[pickup, steer]", "names steer, a stage that launches no session"],
    ["pickup", "must be a list"],
  ] as const)
    it(`refuses ${value}, naming the account and the value`, () => {
      const read = parsed(`, stages: ${value}`);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.failure.code).toBe("invalid");
      expect(read.failure.reason).toContain("dispatch.yaml");
      expect(read.failure.reason).toContain("accounts[0].stages");
      expect(read.failure.reason).toContain("work");
      expect(read.failure.reason).toContain(says);
    });
});

const account = (
  name: string,
  stages?: MachineAccount["stages"],
): MachineAccount => ({
  name,
  vendor: "claude",
  configDir: `/tmp/config-${name}`,
  identity: `${name}@example.com`,
  maxPerAccount: 2,
  ...(stages === undefined ? {} : { stages }),
});

const ROOT = "/nonexistent-state-root";

/** A launch record on `on`, in `state`. */
function record(
  id: string,
  on: string,
  state: ReadRecord["state"] = { kind: "pending" },
  replaces: string | null = null,
): ReadRecord {
  return {
    state,
    record: {
      version: 1,
      id,
      token: "t",
      action: replaces === null ? "rearm" : "takeover",
      repo: "o/r",
      repoPath: "/tmp/r",
      pr: 7,
      account: on,
      vendor: "claude",
      configDir: `/tmp/config-${on}`,
      wallBackoffMs: 1000,
      replaces,
      facts: "f",
      createdAt: "2026-01-01T00:00:00.000Z",
      workspace: null,
      attempts: [],
      item: null,
      agentId: null,
      model: null,
      effort: null,
      released: false,
      command: null,
      marker: null,
    },
    result: null,
  };
}

/** What admission reads of a tick: these accounts, these records, the turn after `last`. */
function state(
  accounts: MachineAccount[],
  records: ReadRecord[] = [],
  last: string | null = null,
) {
  return {
    table: slotTable(accounts, records, Date.now(), ROOT),
    last,
    records,
    codexOptIn: { on: true } as const,
    passDeadlineSec: 5400,
  };
}

const action = (stage: Action["stage"], fields: Partial<Action> = {}) =>
  ({
    stage,
    target: stage === "pickup" ? "#12" : "PR #7",
    record: "forge",
    reason: "wanted",
    evidence: {},
    ...fields,
  }) satisfies Action;

const REARM = action("rearm");
const REDRIVE = action("rearm", {
  redrive: { cause: "its head moved", change: "abc" },
});
const CONFLICT_REDRIVE = action("rearm", {
  redrive: { cause: "it conflicts", change: "def", conflictStop: true },
});

/** The account an action is admitted on, or the wait. */
function admitted(
  s: ReturnType<typeof state>,
  a: Action,
): string | { waits: string } {
  const answer = admission(s, a, new Set(), 10_800);
  return "admitted" in answer ? answer.admitted.account.name : answer;
}

describe("admission among accounts that serve some stages", () => {
  const accounts = () => [
    account("narrow", ["pickup", "followup"]),
    account("wide"),
  ];

  for (const [name, a] of [
    ["a re-arm", REARM],
    ["a re-drive", REDRIVE],
    ["a conflict re-drive", CONFLICT_REDRIVE],
  ] as const)
    it(`admits ${name} only on the account that serves rearm, whatever the turn`, () => {
      for (const last of [null, "narrow", "wide"])
        expect(admitted(state(accounts(), [], last), a)).toBe("wide");
    });

  for (const [name, a] of [
    ["a pickup", action("pickup")],
    ["a follow-up", action("followup")],
  ] as const)
    it(`admits ${name} on either account by the turn`, () => {
      expect(admitted(state(accounts(), [], null), a)).toBe("narrow");
      expect(admitted(state(accounts(), [], "narrow"), a)).toBe("wide");
      expect(admitted(state(accounts(), [], "wide"), a)).toBe("narrow");
    });

  it("passes a steward pass over an account that does not serve steward", () => {
    for (const last of [null, "wide"])
      expect(admitted(state(accounts(), [], last), action("steward"))).toBe(
        "wide",
      );
  });

  it("waits, naming the full accounts, when the only account that serves the stage has no free slot", () => {
    const full = [record("r1", "wide"), record("r2", "wide")];
    const answer = admitted(state(accounts(), full), REARM);
    expect(answer).toEqual({
      waits: expect.stringContaining("no account has a free slot"),
    });
  });
});

describe("a stage no listed account serves", () => {
  it("waits naming the stage, not a lack of free slots", () => {
    const s = state([
      account("one", ["pickup"]),
      account("two", ["pickup", "followup"]),
    ]);
    for (const [stage, a] of [
      ["rearm", REARM],
      ["rearm", CONFLICT_REDRIVE],
      ["steward", action("steward")],
    ] as const) {
      const answer = admitted(s, a);
      expect(answer).toEqual({
        waits: expect.stringContaining(`no account serves the ${stage} stage`),
      });
      expect(JSON.stringify(answer)).not.toContain(
        "no account has a free slot",
      );
    }
  });
});

describe("a takeover whose replaced record's account does not serve rearm", () => {
  const accounts = () => [account("narrow", ["pickup"]), account("wide")];
  const replaced = () =>
    record("old", "narrow", {
      kind: "alive",
      process: {
        hostId: "",
        host: "h",
        bootId: "b",
        pid: 1,
        start: "s",
        claimedAt: "2026-01-01T00:00:00.000Z",
      },
    });
  const takeover = action("rearm", { takeover: "old" });

  it("is not admitted on that account, and takes a free slot on one that serves rearm", () => {
    expect(admitted(state(accounts(), [replaced()], "wide"), takeover)).toBe(
      "wide",
    );
  });

  it("waits with the usual reasons when no account that serves rearm has a free slot", () => {
    const records = [replaced(), record("r1", "wide"), record("r2", "wide")];
    expect(admitted(state(accounts(), records), takeover)).toEqual({
      waits: expect.stringContaining("no account has a free slot"),
    });
  });

  it("waits naming the stage when no account serves rearm at all", () => {
    expect(
      admitted(state([account("narrow", ["pickup"])], [replaced()]), takeover),
    ).toEqual({
      waits: expect.stringContaining("no account serves the rearm stage"),
    });
  });

  it("holds a slot of its own on the account it runs on, beside the replaced record's", () => {
    const records = [
      replaced(),
      record("new", "wide", { kind: "pending" }, "old"),
    ];
    const table = slotTable(accounts(), records, Date.now(), ROOT);
    expect(table.map((s) => [s.account.name, s.held])).toEqual([
      ["narrow", 1],
      ["wide", 1],
    ]);
  });

  it("still shares the replaced record's slot when both are on the same account", () => {
    const both = [account("narrow", ["pickup", "rearm"]), account("wide")];
    expect(admitted(state(both, [replaced()]), takeover)).toBe("narrow");
    const records = [
      replaced(),
      record("new", "narrow", { kind: "pending" }, "old"),
    ];
    const table = slotTable(both, records, Date.now(), ROOT);
    expect(table.map((s) => [s.account.name, s.held])).toEqual([
      ["narrow", 1],
      ["wide", 0],
    ]);
  });
});

describe("a pickup's headroom among accounts that serve some stages", () => {
  /** Whether some account could take a pickup with these records. */
  const headroom = (accounts: MachineAccount[], records: ReadRecord[]) =>
    slotTable(accounts, records, Date.now(), ROOT).some(takesPickup);

  it("sees no room when the only free slot is on an account that does not serve pickup", () => {
    const accounts = [account("pick", ["pickup"]), account("drive", ["rearm"])];
    const full = [record("p1", "pick"), record("p2", "pick")];
    expect(headroom(accounts, full)).toBe(false);
  });

  it("sees room on a free account that serves pickup", () => {
    const accounts = [account("pick", ["pickup"]), account("drive", ["rearm"])];
    const full = [record("d1", "drive"), record("d2", "drive")];
    expect(headroom(accounts, full)).toBe(true);
  });
});

describe("a moved takeover whose first account fails its identity check", () => {
  const dir = mkdtempSync(join(tmpdir(), "account-stages-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** An account whose configuration directory resolves to `resolves`, listed with `identity`. */
  function listed(
    name: string,
    identity: string,
    resolves: string,
    stages?: MachineAccount["stages"],
  ): MachineAccount {
    const configDir = join(dir, name);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: resolves } }),
    );
    return {
      ...account(name, stages),
      configDir,
      identity,
    };
  }

  it("tries the next account that serves rearm, as a re-arm does", async () => {
    const accounts = [
      listed("narrow", "narrow@example.com", "narrow@example.com", ["pickup"]),
      listed("stale", "stale@example.com", "someone-else@example.com"),
      listed("good", "good@example.com", "good@example.com"),
    ];
    const replaced = record("old", "narrow", {
      kind: "alive",
      process: {
        hostId: "",
        host: "h",
        bootId: "b",
        pid: 1,
        start: "s",
        claimedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    replaced.record.configDir = join(dir, "narrow");
    const s = {
      ...state(accounts, [replaced]),
      root: ROOT,
      machine: { runtimeTimeoutMs: 30_000 },
    } as unknown as ApplyState;
    const answer = await admitAccount(
      s,
      "o/r",
      action("rearm", { takeover: "old" }),
    );
    expect(answer).toMatchObject({ slots: { account: { name: "good" } } });
  }, 60_000);
});
