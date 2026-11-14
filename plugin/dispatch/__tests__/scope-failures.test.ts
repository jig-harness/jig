import { expect, it } from "bun:test";
import { sharedDispatchRead } from "../../skills/do-item/scripts/lib/tracker/dispatch-shared.ts";
import { AssignerUnknown } from "../../skills/do-item/scripts/lib/tracker/assigner-unknown.ts";
import { LinearApiError } from "../../skills/do-item/scripts/lib/tracker/linear-transport.ts";
import { GitHubApiError } from "../../skills/do-item/scripts/lib/tracker/github/transport.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { sharedView, type ServedViews } from "../lib/sources/served-reads.ts";

it("latches transport failures across distinct fact keys and people, but keeps definite missing assigners local", async () => {
  let later = 0;
  let metadata: Map<string, Promise<unknown>> | undefined;
  const tracker = {
    adapter: "linear",
    team: "TEAM",
    stateName: () => null,
    dispatchSource: {
      credential: async () => "credential",
      shareReads: (reads: Map<string, Promise<unknown>>) => {
        metadata = reads;
      },
      queue: async () => [],
      issue: async () => {
        later++;
        return null;
      },
      children: async () => [],
    },
  } as unknown as Tracker;
  const views: ServedViews = new Map();
  const cache = { get: () => null, set: () => undefined };
  const options = { nowMs: 100000, headroom: true };
  const a = await sharedView(views, tracker, "alex", options, cache);
  const b = await sharedView(views, tracker, "sam", options, cache);
  await expect(
    a.once("missing assigner", async () => {
      throw new AssignerUnknown("no user assigned it");
    }),
  ).rejects.toThrow("no user assigned");
  expect(await b.once("another item", async () => "read")).toBe("read");
  await expect(
    a.once("history", async () => {
      throw new LinearApiError("network unreachable", null);
    }),
  ).rejects.toThrow("network unreachable");
  await expect(
    b.once("parent body", async () => {
      later++;
      return "body";
    }),
  ).rejects.toThrow("network unreachable");
  await expect(
    sharedDispatchRead(metadata, "field definitions", async () => {
      later++;
      return "fields";
    }),
  ).rejects.toThrow("network unreachable");
  await expect(b.pool("TEAM-P")).rejects.toThrow("network unreachable");
  expect(b.unavailable).toBe("network unreachable");
  expect(a.scope).toBe(b.scope);
  expect(later).toBe(0);
});

it("latches unavailable metadata answers before another metadata or raw issue read", async () => {
  const reads = new Map<string, Promise<unknown>>();
  await expect(
    sharedDispatchRead(reads, "invalid item", async () => {
      throw new Error("malformed item");
    }),
  ).rejects.toThrow("malformed item");
  expect(
    await sharedDispatchRead(reads, "valid item", async () => "read"),
  ).toBe("read");
  await expect(
    sharedDispatchRead(reads, "field evidence", async () => {
      throw new GitHubApiError("host unavailable", { unavailable: true });
    }),
  ).rejects.toThrow("host unavailable");
  let later = 0;
  await expect(
    sharedDispatchRead(reads, "different field evidence", async () => {
      later++;
      return "fields";
    }),
  ).rejects.toThrow("host unavailable");
  expect(later).toBe(0);
});
