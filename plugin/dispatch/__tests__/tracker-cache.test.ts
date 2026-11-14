import { expect, it } from "bun:test";
import type {
  Tracker,
  PoolIssue,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type { DispatchSection } from "../lib/types.ts";
import { readPickups } from "../lib/sources/tracker.ts";
import { issue } from "./served-fixtures.ts";

function session(
  credential: string,
  persistent: boolean,
  queueCalls: { count: number },
) {
  const rows = [issue("TEAM-F", [], "factory"), issue("TEAM-A", [], "alex")];
  const unassigned = issue("TEAM-U", [], null);
  const raw = (value: PoolIssue) => ({
    identifier: value.identifier,
    value,
    parent: null,
    relations: [],
  });
  return {
    adapter: "linear",
    team: "TEAM",
    stateName: (state: string) => (state === "todo" ? "Todo" : null),
    user: async () => ({ id: "factory", name: "factory" }),
    viewer: async () => ({ id: "factory", name: "factory" }),
    assignedBy: async () => ({ id: "writer", name: "writer", trusted: true }),
    stateChangedBy: async () => ({
      id: "writer",
      name: "writer",
      trusted: true,
    }),
    unassignedIssues: async () => [unassigned],
    listRelations: async () => [],
    changedSince: async () => ({ keys: [], complete: true, latest: null }),
    dispatchSource: {
      credential: async () => credential,
      persistent,
      queue: async (identity: string) => {
        queueCalls.count++;
        return rows.filter((row) => row.assignee?.name === identity).map(raw);
      },
      issue: async () => null,
      children: async () => [],
      project: async (row: { value: unknown }) => row.value as PoolIssue,
    },
  } as unknown as Tracker;
}

const section = {
  identity: "factory",
  states: ["todo"],
  pool: { states: ["todo"] },
} as unknown as DispatchSection;
const people = [{ name: "Alex", forge: ["alex"], tracker: { linear: "alex" } }];

it("keeps all opaque credential pickup caches in memory across factory, served and ready-pool lanes", async () => {
  let durableReads = 0;
  const values = new Map<string, unknown>();
  const durable = {
    get: <T>(key: string) => {
      durableReads++;
      return (values.get(key) as T) ?? null;
    },
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
  const calls = { count: 0 };
  for (const credential of ["opaque-session-one", "opaque-session-two"]) {
    const tracker = session(credential, false, calls);
    const result = await readPickups(() => tracker, section, undefined, {
      cache: durable,
      people,
      nowMs: 100000,
      headroom: true,
      views: new Map(),
    });
    expect(result.wanted.map((row) => row.key).sort()).toEqual([
      "TEAM-A",
      "TEAM-F",
      "TEAM-U",
    ]);
  }
  expect(durableReads).toBe(0);
  expect(values.size).toBe(0);
});

it("persists identified HTTP credential readings and reuses them from another tracker session", async () => {
  const values = new Map<string, unknown>();
  const durable = {
    get: <T>(key: string) => (values.get(key) as T) ?? null,
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
  const calls = { count: 0 };
  for (const nowMs of [100000, 160000]) {
    const tracker = session("stable-http-credential", true, calls);
    const result = await readPickups(() => tracker, section, undefined, {
      cache: durable,
      people,
      nowMs,
      headroom: true,
      views: new Map(),
    });
    expect(result.wanted.map((row) => row.key).sort()).toEqual([
      "TEAM-A",
      "TEAM-F",
      "TEAM-U",
    ]);
  }
  expect(values.size).toBeGreaterThan(0);
  expect(calls.count).toBe(2);
});
