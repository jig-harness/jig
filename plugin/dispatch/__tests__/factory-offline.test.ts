/** A failed native queue never turns unknown factory claims into an empty list. */
import { expect, it } from "bun:test";
import { LinearApiError } from "../../skills/do-item/scripts/lib/tracker/linear-transport.ts";
import { readPickups } from "../lib/sources/tracker.ts";
import type { DispatchSection } from "../lib/types.ts";
import { FakeLinear } from "./served-linear-fake.ts";

it("shares one invocation's native queue and authority read between factory and served lanes without caller views", async () => {
  const fake = new FakeLinear();
  fake.add({ identifier: "ENG-1", assignee: "factory@example.com" });
  const tracker = fake.tracker();
  const cache = {
    get: <T>(_key: string): T | null => null,
    set: (_key: string, _value: unknown) => undefined,
  };
  const read = await readPickups(
    () => tracker,
    { identity: "factory@example.com", states: ["todo"] } as DispatchSection,
    undefined,
    {
      people: [
        {
          name: "Factory",
          forge: [],
          tracker: { linear: "factory@example.com" },
        },
      ],
      cache,
      nowMs: Date.now(),
      headroom: true,
    },
  );
  expect(read.wanted.map((item) => item.key)).toEqual(["ENG-1"]);
  expect(
    fake.requests.filter((operation) => operation === "TrackerNativeQueue"),
  ).toHaveLength(1);
  expect(
    fake.requests.filter(
      (operation) => operation === "TrackerAssignmentHistory",
    ),
  ).toHaveLength(1);
});

it("preserves configured factory states outside the served open and working lanes", async () => {
  const fake = new FakeLinear();
  fake.add({
    identifier: "ENG-1",
    assignee: "factory@example.com",
    state: { name: "In Review", type: "started" },
  });
  const tracker = fake.tracker();
  const saved = new Map<string, unknown>();
  const cache = {
    get: <T>(key: string) => (saved.get(key) as T | undefined) ?? null,
    set: (key: string, value: unknown) => {
      saved.set(key, value);
    },
  };
  const section = {
    identity: "factory@example.com",
    states: ["in_review"],
  } as DispatchSection;
  const read = await readPickups(() => tracker, section, undefined, {
    people: [],
    cache,
    nowMs: Date.now(),
    headroom: true,
    views: new Map(),
  });
  expect(read.wanted.map((item) => item.key)).toEqual(["ENG-1"]);
});

it("keeps the factory queue and its age while a scope is unreachable, with claims unknown", async () => {
  const fake = new FakeLinear();
  fake.add({ identifier: "ENG-1", assignee: "factory@example.com" });
  const tracker = fake.tracker();
  const saved = new Map<string, unknown>();
  const cache = {
    get: <T>(key: string) => (saved.get(key) as T | undefined) ?? null,
    set: (key: string, value: unknown) => {
      saved.set(key, value);
    },
  };
  const section = {
    identity: "factory@example.com",
    states: ["todo"],
  } as DispatchSection;
  const nowMs = Date.parse("2026-11-10T12:00:00Z");
  const first = await readPickups(() => tracker, section, undefined, {
    people: [],
    cache,
    nowMs,
    headroom: true,
    views: new Map(),
  });
  expect(first.wanted).toHaveLength(1);
  const mark = fake.count();
  const offline = {
    ...tracker,
    changedSince: async () => {
      throw new LinearApiError("connection unavailable", null, "unreachable");
    },
  };
  const second = await readPickups(() => offline, section, undefined, {
    people: [],
    cache,
    nowMs: nowMs + 60_000,
    headroom: true,
    views: new Map(),
  });
  expect(second.read.ok).toBe(false);
  expect(second.read.failure?.class).toBe("unreachable");
  expect(second.claimed).toBeNull();
  expect(second.unplaced).toEqual([
    expect.objectContaining({
      target: "linear ENG",
      reason: expect.stringContaining("2026-11-10T12:00:00.000Z"),
    }),
  ]);
  expect(fake.count()).toBe(mark);
});
