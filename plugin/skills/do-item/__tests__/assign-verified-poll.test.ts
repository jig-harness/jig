import { expect, test } from "bun:test";
import {
  assignVerified,
  type AssigneeChange,
} from "../scripts/lib/tracker/assign-verified.ts";

function world(visibleAfter: number, race = false) {
  let now = 0;
  let current: string | null = null;
  let reads = 0;
  const writes: (string | null)[] = [];
  const changes: AssigneeChange[] = [];
  return {
    writes,
    current: () => current,
    now: () => now,
    options: {
      clock: {
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
      },
      timeoutMs: 30,
      pollMs: 10,
    },
    ops: {
      assignee: async () => current,
      assign: async (id: string | null) => {
        if (race && writes.length === 0) current = "other";
        changes.push({ from: current, to: id, at: "2026-11-01T00:00:01Z" });
        current = id;
        writes.push(id);
      },
      assignIfCurrent: async (expected: string | null, id: string | null) => {
        if (current !== expected) return false;
        changes.push({ from: current, to: id, at: "2026-11-01T00:00:01Z" });
        current = id;
        writes.push(id);
        return true;
      },
      history: async () => (++reads >= visibleAfter ? [...changes] : []),
    },
  };
}

test("waits for history visibility instead of standing down a successful write", async () => {
  const w = world(4);
  expect(await assignVerified(w.ops, "me", w.options)).toEqual({
    assigned: true,
  });
  expect(w.writes).toEqual(["me"]);
  expect(w.now()).toBe(20);
});

test("unverifiable assignment is cleared at the deadline", async () => {
  const w = world(Infinity);
  expect(await assignVerified(w.ops, "me", w.options)).toEqual({
    assigned: false,
    reason: "unverified",
  });
  expect(w.now()).toBe(30);
  expect(w.writes).toEqual(["me", null]);
  expect(w.current()).toBeNull();
});

test("a genuine replacement is restored and reported as a race", async () => {
  const w = world(1, true);
  expect(await assignVerified(w.ops, "me", w.options)).toEqual({
    assigned: false,
    reason: "race",
  });
  expect(w.writes).toEqual(["me", "other"]);
  expect(w.now()).toBe(0);
});

test("waits for a lagging assignee read as well as the history", async () => {
  const w = world(1);
  const read = w.ops.assignee;
  let reads = 0;
  w.ops.assignee = async () => (++reads < 4 ? null : read());
  expect(await assignVerified(w.ops, "me", w.options)).toEqual({
    assigned: true,
  });
  expect(w.now()).toBe(20);
  expect(w.writes).toEqual(["me"]);
});

test("does not clear a new owner seen on the final cleanup read", async () => {
  const w = world(Infinity);
  w.ops.assignIfCurrent = async (_expected, _id) => {
    // Simulate an adapter's final ownership read observing a new owner.
    return false;
  };
  expect(await assignVerified(w.ops, "me", w.options)).toEqual({
    assigned: false,
    reason: "unverified",
  });
  expect(w.writes).toEqual(["me"]);
});

test("waits for the claimant's replacement evidence after seeing a partial race", async () => {
  const w = world(1, true);
  const own = w.ops.history;
  let reads = 0;
  w.ops.history = async () => {
    ++reads;
    if (reads === 1) return [];
    if (reads === 2)
      return [{ from: null, to: "other", at: "2026-11-01T00:00:00Z" }];
    return own();
  };
  expect(await assignVerified(w.ops, "me", w.options)).toEqual({
    assigned: false,
    reason: "race",
  });
  expect(w.writes).toEqual(["me", "other"]);
  expect(w.current()).toBe("other");
  expect(w.now()).toBe(10);
});

test("retains a partial race across disappearing history and never guesses its former owner", async () => {
  const w = world(1, true);
  let reads = 0;
  w.ops.history = async () =>
    ++reads === 2
      ? [
          { from: null, to: "other", at: "2026-11-01T00:00:00Z" },
          { from: "other", to: null, at: "2026-11-01T00:00:01Z" },
        ]
      : [];
  expect(await assignVerified(w.ops, "me", w.options)).toEqual({
    assigned: false,
    reason: "race-unverified",
  });
  expect(w.writes).toEqual(["me"]);
  expect(w.now()).toBe(30);
});

test("a later incomplete listing cannot certify success after a known conflict", async () => {
  const w = world(1);
  let reads = 0;
  w.ops.history = async () => {
    ++reads;
    if (reads === 1) return [];
    return reads === 2
      ? [{ from: null, to: "other", at: "2026-11-01T00:00:00Z" }]
      : [{ from: null, to: "me", at: "2026-11-01T00:00:01Z" }];
  };
  expect(await assignVerified(w.ops, "me", w.options)).toEqual({
    assigned: false,
    reason: "race-unverified",
  });
  expect(w.writes).toEqual(["me"]);
  expect(w.now()).toBe(30);
});

test("a coherent sequence that cleared another owner before our write verifies from nobody", async () => {
  const w = world(1);
  let reads = 0;
  const other: AssigneeChange = {
    from: null,
    to: "other",
    at: "2026-11-01T00:00:00Z",
  };
  w.ops.history = async () => {
    ++reads;
    if (reads === 1) return [];
    if (reads === 2) return [other];
    return [
      other,
      { from: "other", to: null, at: "2026-11-01T00:00:01Z" },
      { from: null, to: "me", at: "2026-11-01T00:00:02Z" },
    ];
  };
  expect(await assignVerified(w.ops, "me", w.options)).toEqual({
    assigned: true,
  });
  expect(w.writes).toEqual(["me"]);
  expect(w.now()).toBe(10);
});

test("uses a complete listing to reconcile tied-time history observed partially", async () => {
  let current: string | null = null;
  let histories = 0;
  let now = 0;
  const first: AssigneeChange = {
    from: "other",
    to: null,
    at: "2026-11-01T00:00:01Z",
  };
  const complete: AssigneeChange[] = [
    { from: null, to: "other", at: first.at },
    first,
    { from: null, to: "me", at: "2026-11-01T00:00:02Z" },
  ];
  expect(
    await assignVerified(
      {
        assignee: async () => current,
        assign: async (id) => {
          current = id;
        },
        assignIfCurrent: async (expected, id) => {
          if (current !== expected) return false;
          current = id;
          return true;
        },
        history: async () => {
          histories++;
          return histories === 1 ? [] : histories === 2 ? [first] : complete;
        },
      },
      "me",
      {
        clock: {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
        },
        timeoutMs: 30,
        pollMs: 10,
      },
    ),
  ).toEqual({ assigned: true });
});
