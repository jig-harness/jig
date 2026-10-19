import { expect, test } from "bun:test";
import {
  trackForegroundProcessTree,
  trackForegroundAnchor,
  type ForegroundTreeState,
} from "../scripts/lib/foreground-process-tree.ts";
import type { ProcessRow } from "../../../shared/process-table.ts";
const row = (pid: number, ppid = 0, start = `created-${pid}`): ProcessRow => ({
  pid,
  ppid,
  start,
  pgid: 0,
  stat: "R",
  args: "",
});
const state = (): ForegroundTreeState => ({
  root: null,
  targets: [],
  unknown: new Set(),
  unresolved: false,
  unverifiable: false,
});

test("a first partial snapshot retains its bound root and readable descendants", () => {
  const tracked = state();
  trackForegroundProcessTree(
    1,
    false,
    [row(1), row(2, 1), row(3, 1, "")],
    tracked,
  );
  expect(tracked.root).toEqual({ pid: 1, start: "created-1" });
  expect(tracked.targets.map((target) => target.pid).sort()).toEqual([1, 2]);
  expect([...tracked.unknown]).toEqual([3]);
  expect(tracked.unresolved).toBe(true);
});

test("unknown descendants remain uncertain after reparenting and becoming readable", () => {
  const tracked = state();
  trackForegroundProcessTree(
    1,
    false,
    [row(1), row(2, 1), row(3, 1, "")],
    tracked,
  );
  trackForegroundProcessTree(
    1,
    false,
    [row(1), row(2, 99), row(3, 99)],
    tracked,
  );
  expect(tracked.targets.map((target) => target.pid).sort()).toEqual([1, 2]);
  expect([...tracked.unknown]).toEqual([3]);
  expect(tracked.unresolved).toBe(true);
  trackForegroundProcessTree(1, false, [row(1), row(2, 99)], tracked);
  expect(tracked.unresolved).toBe(false);
});

test("readable grandchildren cannot bind through an unknown parent", () => {
  const tracked = state();
  trackForegroundProcessTree(
    1,
    false,
    [row(1), row(2, 1, ""), row(3, 2)],
    tracked,
  );
  expect(tracked.targets.map((target) => target.pid)).toEqual([1]);
  expect([...tracked.unknown].sort()).toEqual([2, 3]);
  trackForegroundProcessTree(1, false, [row(1), row(3, 99)], tracked);
  expect([...tracked.unknown]).toEqual([3]);
  expect(tracked.unresolved).toBe(true);
});

test("an unreadable captured identity retains ownership while siblings remain actionable", () => {
  const tracked = state();
  trackForegroundProcessTree(1, false, [row(1), row(2, 1), row(3, 1)], tracked);
  trackForegroundProcessTree(
    1,
    false,
    [row(1), row(2, 99, ""), row(3, 1)],
    tracked,
  );
  expect(tracked.targets).toContainEqual({ pid: 2, start: "created-2" });
  expect(tracked.targets).toContainEqual({ pid: 3, start: "created-3" });
  expect(tracked.unresolved).toBe(true);
  trackForegroundProcessTree(
    1,
    false,
    [row(1), row(2, 99), row(3, 1)],
    tracked,
  );
  expect(tracked.unresolved).toBe(false);
});

test("unbound and reused roots never authorize descendant adoption", () => {
  const unbound = state();
  trackForegroundProcessTree(1, false, [row(1, 0, ""), row(2, 1)], unbound);
  expect(unbound.root).toBeNull();
  expect(unbound.targets).toEqual([]);
  const tracked = state();
  trackForegroundProcessTree(1, false, [row(1)], tracked);
  trackForegroundProcessTree(
    1,
    false,
    [row(1, 0, "replacement"), row(2, 1)],
    tracked,
  );
  expect(tracked.root).toEqual({ pid: 1, start: "created-1" });
  expect(tracked.targets).toEqual([]);
});

test("an unavailable snapshot preserves all bound identities", () => {
  const tracked = state();
  trackForegroundProcessTree(1, false, [row(1), row(2, 1)], tracked);
  trackForegroundProcessTree(1, false, null, tracked);
  expect(tracked.targets).toHaveLength(2);
  expect(tracked.unresolved).toBe(true);
});

test("a readable snapshot missing an unbound command retains unverifiable completion", () => {
  const tracked = state();
  trackForegroundProcessTree(1, false, [], tracked);
  expect(tracked.root).toBeNull();
  expect(tracked.targets).toEqual([]);
  expect(tracked.unverifiable).toBe(true);
});

test("a prebound persistent anchor survives fast command exit and never enters the target set", () => {
  const tracked = state();
  tracked.root = { pid: 1, start: "created-1" };
  trackForegroundAnchor([row(1), row(2, 1)], tracked);
  expect(tracked.targets).toEqual([{ pid: 2, start: "created-2" }]);
  trackForegroundAnchor([row(1)], tracked);
  expect(tracked.targets).toEqual([]);
  expect(tracked.unresolved).toBe(false);
  expect(tracked.unverifiable).toBe(false);
});

test("a missing persistent anchor is unreadable even when all known workload is gone", () => {
  const tracked = state();
  tracked.root = { pid: 1, start: "created-1" };
  trackForegroundAnchor([], tracked);
  expect(tracked.targets).toEqual([]);
  expect(tracked.unresolved).toBe(true);
  trackForegroundAnchor([row(1)], tracked);
  expect(tracked.unresolved).toBe(false);
});

test("a persistent anchor keeps known siblings actionable beside sticky unknown ancestry", () => {
  const tracked = state();
  tracked.root = { pid: 1, start: "created-1" };
  trackForegroundAnchor([row(1), row(2, 1), row(3, 1, "")], tracked);
  expect(tracked.targets).toEqual([{ pid: 2, start: "created-2" }]);
  trackForegroundAnchor([row(1), row(2, 99), row(3, 99)], tracked);
  expect(tracked.targets).toEqual([{ pid: 2, start: "created-2" }]);
  expect(tracked.unresolved).toBe(true);
  expect([...tracked.unknown]).toEqual([3]);
});
