import { expect, it } from "bun:test";
import { cacheByVersion, validatorCache } from "../outbound/cache.ts";

it("reuses stable absences by version and retries transient answers", async () => {
  const entries = new Map<string, unknown>();
  const store = {
    get: <T>(key: string) => entries.get(key) as T | undefined,
    set: <T>(key: string, value: T) => {
      entries.set(key, value);
    },
  };
  let calls = 0;
  const read = async () => {
    calls++;
    return null;
  };
  await cacheByVersion(store, "item", "v1", read);
  await cacheByVersion(store, "item", "v1", read);
  expect(calls).toBe(1);
  await cacheByVersion(store, "item", "v2", read);
  expect(calls).toBe(2);
  await cacheByVersion(store, "item", "v3", read, () => false);
  await cacheByVersion(store, "item", "v3", read, () => false);
  expect(calls).toBe(4);
  await cacheByVersion(store, "item", "", read);
  await cacheByVersion(store, "item", "", read);
  expect(calls).toBe(6);
});

it("does not persist a thrown read and preserves a stable failure value", async () => {
  const entries = new Map<string, unknown>();
  const store = {
    get: <T>(key: string) => entries.get(key) as T | undefined,
    set: <T>(key: string, value: T) => {
      entries.set(key, value);
    },
  };
  await expect(
    cacheByVersion(store, "item", "v1", async () => {
      throw new Error("unreachable");
    }),
  ).rejects.toThrow("unreachable");
  expect(entries.size).toBe(0);
  let calls = 0;
  const read = async () => {
    calls++;
    return { ok: false, code: "not-found" };
  };
  await cacheByVersion(store, "item", "v1", read);
  expect(await cacheByVersion(store, "item", "v1", read)).toEqual({
    ok: false,
    code: "not-found",
  });
  expect(calls).toBe(1);
});

it("keeps validators scoped by request and refuses malformed entries", () => {
  const entries = new Map<string, unknown>();
  const cache = validatorCache({
    get: (key) => entries.get(key),
    set: (key, value) => {
      entries.set(key, value);
    },
  });
  cache.set("one", "resource", "tag", "body");
  expect(cache.get("one", "resource")).toEqual({ etag: "tag", body: "body" });
  expect(cache.get("one", "other")).toBeNull();
  entries.set("one", { v: 1, path: "resource", etag: 5, body: "body" });
  expect(cache.get("one", "resource")).toBeNull();
});
