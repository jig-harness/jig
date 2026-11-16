import { expect, it } from "bun:test";
import { nativeFacts } from "../lib/sources/native-facts.ts";
import type {
  DispatchRawIssue,
  DispatchSource,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";

function row(identifier: string): DispatchRawIssue {
  return { identifier, value: {} };
}

it("falls back per key after a non-rate-limited native batch failure", async () => {
  const singles: string[] = [];
  const source: DispatchSource = {
    credential: async () => "credential",
    queue: async () => [],
    issue: async (key) => {
      singles.push(key);
      return row(key);
    },
    issues: async () => {
      throw new Error("one batch member is inaccessible");
    },
    children: async () => [],
    project: async () => {
      throw new Error("not used by this test");
    },
  };
  const facts = nativeFacts(source, new Map(), undefined);

  expect(
    [...(await facts.issues(["#1", "#2", "#1"]))].map(([key]) => key),
  ).toEqual(["#1", "#2"]);
  expect(singles).toEqual(["#1", "#2"]);
  await facts.issue("#1");
  expect(singles).toEqual(["#1", "#2"]);
});

it("bounds and retains per-key fallbacks after a native batch failure", async () => {
  let active = 0;
  let maximum = 0;
  const source: DispatchSource = {
    credential: async () => "credential",
    queue: async () => [],
    issue: async (key) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return row(key);
    },
    issues: async () => {
      throw new Error("the batch failed");
    },
    children: async () => [],
    project: async () => {
      throw new Error("not used by this test");
    },
  };
  const facts = nativeFacts(source, new Map(), undefined);

  await facts.issues(Array.from({ length: 98 }, (_, i) => `#${i + 1}`));
  expect(maximum).toBe(6);
});

it.each(["rejected", "partial"] as const)(
  "keeps concurrent arrivals bounded while a %s batch recovers",
  async (mode) => {
    let active = 0;
    let maximum = 0;
    const source: DispatchSource = {
      credential: async () => "credential",
      queue: async () => [],
      children: async () => [],
      project: async () => {
        throw new Error("not used by this test");
      },
      issue: async (key) => {
        active++;
        maximum = Math.max(maximum, active);
        for (let i = 0; i < 4; i++) await Promise.resolve();
        active--;
        return row(key);
      },
      issues: async () => {
        if (mode === "rejected") throw new Error("batch failed");
        return new Map();
      },
    };
    const facts = nativeFacts(source, new Map(), undefined);
    const recovering = facts.issues(
      Array.from({ length: 98 }, (_, i) => `#${i}`),
    );
    const arriving = [];
    for (let i = 0; i < 98; i++) {
      await Promise.resolve();
      arriving.push(facts.issue(`#extra-${i}`));
    }
    await Promise.all([recovering, ...arriving]);
    expect(maximum).toBeLessThanOrEqual(6);
  },
);
