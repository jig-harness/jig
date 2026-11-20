/**
 * An issue created already assigned: Linear writes no history entry for an
 * assignee given at creation, so the issue's creator made its assignment.
 * Through a fake Linear workspace, the tick plans such an item only when its
 * creator could have assigned it, the read just before a launch answers the
 * same, and a served queue reads it as a wanted row.
 */
import { describe, expect, it } from "bun:test";
import { freshPickup, readPickups } from "../lib/sources/tracker.ts";
import type { DispatchSection } from "../lib/types.ts";
import { type FakeIssue, FakeLinear, LEAD } from "./served-linear-fake.ts";

const FACTORY = "factory@example.com";
const PERSON = "person@example.com";
const SECTION = { identity: FACTORY, states: ["todo"] } as DispatchSection;
const NO_CACHE = {
  get: <T>(_key: string): T | null => null,
  set: (_key: string, _value: unknown) => undefined,
};

/** One item assigned to the factory identity as `item` sets it up, read by a tick and again before its launch. */
async function pickup(item: Partial<FakeIssue>) {
  const fake = new FakeLinear();
  fake.add({ identifier: "ENG-1", assignee: FACTORY, ...item });
  const tracker = fake.tracker();
  const read = await readPickups(() => tracker, SECTION, undefined, {
    people: [],
    cache: NO_CACHE,
    nowMs: Date.now(),
    headroom: true,
  });
  const fresh = await freshPickup(tracker, SECTION, "ENG-1");
  return {
    wanted: read.wanted.map((w) => [w.key, w.assignedBy]),
    reason: read.unplaced.find((u) => u.target === "ENG-1")?.reason,
    fresh: typeof fresh === "string" ? fresh : fresh.identifier,
  };
}

describe("an item created assigned to the factory identity", () => {
  it("is planned when a team member created it, and launched on the fresh read", async () => {
    expect(await pickup({ history: "created" })).toEqual({
      wanted: [["ENG-1", "lead"]],
      reason: undefined,
      fresh: "ENG-1",
    });
  });

  it("is not planned when no user created it", async () => {
    const got = await pickup({ history: "created", creator: null });
    expect(got.wanted).toEqual([]);
    const why = `it was created assigned to ${FACTORY} by no user (an integration or an automation)`;
    expect(got.reason).toContain(why);
    expect(got.fresh).toContain(why);
  });

  it("is not planned when a guest or someone outside the team created it", async () => {
    for (const creator of [
      { ...LEAD, guest: true },
      { ...LEAD, teams: { nodes: [] } },
    ]) {
      const got = await pickup({ history: "created", creator });
      expect(got.wanted).toEqual([]);
      expect(got.reason).toContain(
        `created assigned to ${FACTORY} by lead, who cannot write to ENG`,
      );
      expect(got.fresh).toContain(
        `it was created assigned to ${FACTORY} by lead, who cannot write to ENG`,
      );
    }
  });

  it("still holds no assignment when its assignee changed only to someone else", async () => {
    const got = await pickup({ history: "none" });
    expect(got.wanted).toEqual([]);
    const why = `its history holds no assignment of ${FACTORY}`;
    expect(got.reason).toContain(why);
    expect(got.fresh).toContain(why);
  });

  it("is answered by its assignment entry's actor, whoever created it", async () => {
    expect(
      await pickup({ history: "assigned", creator: { ...LEAD, guest: true } }),
    ).toEqual({
      wanted: [["ENG-1", "lead"]],
      reason: undefined,
      fresh: "ENG-1",
    });
  });
});

describe("a served item created assigned to its person", () => {
  async function served(creator: Record<string, unknown>) {
    const fake = new FakeLinear();
    fake.add({
      identifier: "ENG-2",
      assignee: PERSON,
      history: "created",
      creator,
    });
    const tracker = fake.tracker();
    return readPickups(() => tracker, SECTION, undefined, {
      people: [
        { name: "Person", forge: ["person"], tracker: { linear: PERSON } },
      ],
      cache: NO_CACHE,
      nowMs: Date.now(),
      headroom: true,
    });
  }

  it("is a wanted row, not unreadable queue metadata", async () => {
    const read = await served({ ...LEAD, id: "person", name: "Person" });
    expect(read.wanted.map((w) => [w.key, w.assignedBy])).toEqual([
      ["ENG-2", "Person"],
    ]);
    expect(read.unplaced).toEqual([]);
  });

  it("names a creator who cannot write as the reason it waits", async () => {
    const read = await served({ ...LEAD, name: "Guest", guest: true });
    expect(read.wanted).toEqual([]);
    expect(read.unplaced.find((u) => u.target === "ENG-2")?.reason).toContain(
      `assignment to ${PERSON} was not made by a repository writer: Guest created it assigned`,
    );
  });
});
