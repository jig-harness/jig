/**
 * A tick over waiting items that did not change sends no per-item tracker
 * read: who assigned each item is kept by the item's update time, whether
 * that person can write is asked once per person (and again only after
 * `WRITE_ACCESS_MS`), and an item's dependency links come with the native
 * rows the queue read already carries. Exercised through the GitHub adapter
 * over a fake transport that counts each operation it is sent.
 */
import { afterEach, expect, it, setSystemTime } from "bun:test";
import assert from "node:assert/strict";
import {
  type Call,
  conn,
  gitHub,
  issueNode,
} from "../../skills/do-item/__tests__/github-fixtures.ts";
import { isoFromMs } from "../../shared/time.ts";
import type { PickupReads } from "../lib/pickup-reads.ts";
import { dispatchSection } from "../lib/section.ts";
import { WRITE_ACCESS_MS } from "../lib/sources/assigner-reads.ts";
import { readPickups } from "../lib/sources/tracker.ts";

const START = 1_767_398_400_000;
const at = (minute: number) => START + minute * 60_000;
const PER_ITEM = [
  "TrackerAssignedBy",
  "TrackerCollaborator",
  "TrackerComments",
  "TrackerIssue",
];

afterEach(() => {
  setSystemTime();
});

function row(number: number, updatedAt: string) {
  return issueNode({
    number,
    assignee: "factory",
    labels: ["Todo"],
    updatedAt,
    extra: {
      subIssues: conn([]),
      blockedBy: conn([]),
      blocking: conn([]),
    },
  });
}

function world() {
  const values = new Map<string, unknown>();
  const cache: PickupReads = {
    get: <T>(key: string) => (values.get(key) as T) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
  };
  let rows = [row(1, isoFromMs(START)), row(2, isoFromMs(START))];
  let changes: unknown[] = [];
  const fake = gitHub((call: Call) => {
    const number = call.variables.number;
    switch (call.op) {
      case "TrackerDispatchQueue":
        return { repository: { issues: conn(rows) } };
      case "TrackerDispatchChanges":
        return {
          repository: {
            issues: conn(
              changes.map((change) => ({
                state: "OPEN",
                stateReason: null,
                labels: conn([{ name: "Todo" }]),
                assignees: conn([{ login: "factory" }]),
                parent: null,
                ...(change as object),
              })),
            ),
          },
        };
      case "TrackerDispatchIssues":
        return Object.fromEntries(
          Object.keys(call.variables)
            .filter((key) => /^number\d+$/.test(key))
            .map((key) => [
              `i${key.slice(6)}`,
              {
                issue:
                  rows.find((r) => r.number === call.variables[key]) ?? null,
              },
            ]),
        );
      case "TrackerAssignedBy":
        return {
          repository: {
            issue: {
              assignees: { nodes: [{ login: "factory" }] },
              timelineItems: {
                pageInfo: { hasPreviousPage: false },
                nodes: [
                  {
                    createdAt: isoFromMs(START - 60_000),
                    actor: { login: "dana" },
                    assignee: { login: "factory" },
                  },
                ],
              },
            },
          },
        };
      case "TrackerCollaborator":
        return {
          repository: {
            collaborators: {
              edges: [{ permission: "WRITE", node: { login: "dana" } }],
            },
          },
        };
      case "TrackerIssue":
        return {
          repository: {
            issue: {
              ...(rows.find((r) => r.number === number) ??
                row(Number(number), isoFromMs(START))),
              relatesTo: conn([]),
              duplicateOf: null,
              timelineItems: conn([]),
            },
          },
        };
      case "TrackerComments":
        return {
          repository: {
            issue: { id: `I_${String(number)}`, comments: conn([]) },
          },
        };
      default:
        return new Error(`unexpected operation ${call.op}`);
    }
  });
  assert(fake.t.dispatchSource);
  const tracker = {
    ...fake.t,
    dispatchSource: {
      ...fake.t.dispatchSource,
      credential: async () => "test-credential",
    },
  };
  const parsed = dispatchSection({ dispatch: { identity: "factory" } });
  if (!parsed.ok) throw new Error(parsed.failure.reason);
  const section = parsed.value;
  return {
    calls: fake.calls,
    tick: async (minute: number) => {
      setSystemTime(at(minute));
      const mark = fake.calls.length;
      const reading = await readPickups(() => tracker, section, undefined, {
        cache,
        people: [],
        nowMs: at(minute),
        headroom: true,
        views: new Map(),
      });
      return {
        reading,
        sent: fake.calls
          .slice(mark)
          .filter((call) => PER_ITEM.includes(call.op))
          .map(
            (call) =>
              `${call.op} ${String(call.variables.number ?? call.variables.login)}`,
          ),
      };
    },
    change: (number: number, minute: number) => {
      const time = isoFromMs(at(minute));
      rows = rows.map((r) => (r.number === number ? row(number, time) : r));
      changes = [{ number, updatedAt: time }];
    },
    quiet: () => {
      changes = [];
    },
  };
}

it("asks each assigner's write access once, however many items they assigned", async () => {
  const w = world();
  const first = await w.tick(0);
  expect(first.reading.wanted.map((item) => item.key).sort()).toEqual([
    "#1",
    "#2",
  ]);
  expect(
    first.sent.filter((sent) => sent.startsWith("TrackerCollaborator")),
  ).toEqual(["TrackerCollaborator dana"]);
});

it("sends no per-item tracker read on a tick over unchanged items, and re-reads only an item that changed", async () => {
  const w = world();
  await w.tick(0);
  const unchanged = await w.tick(5);
  expect(unchanged.reading.wanted).toHaveLength(2);
  expect(unchanged.sent).toEqual([]);
  w.change(1, 6);
  const changed = await w.tick(7);
  expect(changed.reading.wanted).toHaveLength(2);
  expect(changed.sent).toEqual(["TrackerAssignedBy 1"]);
  w.quiet();
  expect((await w.tick(8)).sent).toEqual([]);
});

it("keeps who assigned each item through a full reading, and asks write access again once it has aged out", async () => {
  const w = world();
  await w.tick(0);
  const minute = Math.ceil(WRITE_ACCESS_MS / 60_000) + 1;
  const full = await w.tick(minute);
  expect(full.reading.wanted).toHaveLength(2);
  expect(full.sent).toEqual(["TrackerCollaborator dana"]);
});
