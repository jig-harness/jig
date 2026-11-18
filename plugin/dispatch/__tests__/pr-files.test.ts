import { expect, it } from "bun:test";
import { failed, ok } from "../../shared/outcome.ts";
import { failedBy, outboundFailure } from "../../shared/outbound/failure.ts";
import type { ListedPr } from "../lib/forge.ts";
import type { pickupReads } from "../lib/pickup-reads.ts";
import { observePrFiles } from "../lib/sources/pr-files.ts";

function cache(): typeof pickupReads {
  const entries = new Map<string, unknown>();
  return {
    get: <T>(key: string) => (entries.get(key) ?? null) as T | null,
    set: (key, value) => void entries.set(key, value),
    prune: (prefix, liveKeys) => {
      for (const key of entries.keys())
        if (key.startsWith(prefix) && !liveKeys.includes(key))
          entries.delete(key);
    },
  };
}

const pr = (number: number): ListedPr => ({
  number,
  url: "",
  title: "",
  headRefName: `branch-${number}`,
  headRefOid: "head",
  baseRefName: "main",
  baseRefOid: "snapshot",
  baseTipOid: "tip",
});

it("advances past failed reads and treats the fresh-read cap as a deferral", async () => {
  const store = cache();
  const open = Array.from({ length: 9 }, (_, index) => pr(index + 1));
  const calls: number[] = [];
  const read = async (_slug: string, number: number) => {
    calls.push(number);
    return failed("unreadable", "the forge did not answer");
  };
  const first = await observePrFiles(
    "owner/repo",
    open,
    100,
    null,
    undefined,
    store,
    read,
  );
  expect(calls).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(first.evidence.at(-1)).toMatchObject({ pr: 9, status: "unread" });
  expect(await first.files(9)).toMatchObject({
    ok: false,
    failure: { code: "deferred" },
  });
  calls.length = 0;
  await observePrFiles("owner/repo", open, 200, null, undefined, store, read);
  expect(calls[0]).toBe(9);
});

it("preserves aged files and failure class while withholding them from serialization", async () => {
  const store = cache();
  await observePrFiles(
    "owner/repo",
    [pr(1)],
    100,
    null,
    undefined,
    store,
    async () => ok(["old-path"]),
  );
  const open = [{ ...pr(1), baseTipOid: "new-tip" }, pr(2)];
  const refusal = failedBy(
    "unreadable",
    outboundFailure("unreachable", "offline"),
    "offline",
  );
  const read = await observePrFiles(
    "owner/repo",
    open,
    200,
    null,
    undefined,
    store,
    async () => refusal,
  );
  expect(read.evidence).toEqual([
    {
      pr: 1,
      status: "aged",
      files: ["old-path"],
      readAt: "1970-01-01T00:00:00.100Z",
      ageMs: 100,
      reason: "offline",
      failure: { class: "unreachable" },
    },
    {
      pr: 2,
      status: "unread",
      reason: "offline",
      failure: { class: "unreachable" },
    },
  ]);
  expect(await read.files(1)).toEqual(refusal);

  const retried = await observePrFiles(
    "owner/repo",
    open,
    300,
    null,
    undefined,
    store,
    async () => ok(["new-path"]),
  );
  expect(await retried.files(1)).toEqual(ok(["new-path"]));
  expect(retried.evidence.map(({ status }) => status)).toEqual([
    "fresh",
    "fresh",
  ]);
});

it("reuses matching comparisons when the optional read budget is low", async () => {
  const store = cache();
  await observePrFiles(
    "owner/repo",
    [pr(1)],
    100,
    null,
    undefined,
    store,
    async () => ok(["path"]),
  );
  let calls = 0;
  const observed = await observePrFiles(
    "owner/repo",
    [pr(1), pr(2)],
    200,
    "low budget",
    undefined,
    store,
    async () => {
      calls++;
      return ok([]);
    },
  );
  expect(calls).toBe(0);
  expect(observed.evidence.map(({ status }) => status)).toEqual([
    "cached",
    "unread",
  ]);
});

it("reuses a fallback listing's stable comparison until a complete listing refreshes it", async () => {
  const store = cache();
  const { baseTipOid: _missing, ...fallback } = pr(1);
  const open = [fallback];
  await observePrFiles(
    "owner/repo",
    open,
    100,
    null,
    undefined,
    store,
    async () => ok(["before"]),
  );
  const after = await observePrFiles(
    "owner/repo",
    open,
    200,
    null,
    undefined,
    store,
    async () => ok(["after"]),
  );
  expect(after.evidence[0]).toMatchObject({
    pr: 1,
    status: "cached",
    files: ["before"],
  });
  expect(await after.files(1)).toEqual(ok(["before"]));
});

it("treats malformed persisted cache entries as a fresh read", async () => {
  const store = cache();
  store.set("forge:pr-files:owner/repo:1", {
    attemptedAtMs: "never",
    snapshot: { comparison: "old", files: [], readAtMs: "also never" },
  });
  const observed = await observePrFiles(
    "owner/repo",
    [pr(1)],
    100,
    null,
    undefined,
    store,
    async () => ok(["fresh"]),
  );
  expect(observed.evidence[0]).toMatchObject({
    status: "fresh",
    files: ["fresh"],
  });
});
