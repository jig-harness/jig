/**
 * drive-pr suite: a pass killed with only uncommitted edits still owes the
 * round that settles them. The driver names the witnessed HEAD however the
 * work was left, and the gate reads that HEAD on the PR head itself as an
 * inherited one, so the drive cannot end before a pass has run.
 */

import { describe, expect, it } from "bun:test";
import { inheritedHeadOf } from "../scripts/lib/driver/restart.ts";
import {
  headSyncState,
  mayEndWithoutWork,
} from "../scripts/lib/status/inherited-head.ts";

const HEAD = "a".repeat(40);
const leftovers = (uncommitted: string | null, unpushed: number | null) => ({
  uncommitted,
  unpushed,
  operation: null,
  head: HEAD,
});

describe("inheritedHeadOf", () => {
  it("names the head for uncommitted edits alone, and for unpushed commits", () => {
    expect(inheritedHeadOf(leftovers(" M a.ts", 0))).toBe(HEAD);
    expect(inheritedHeadOf(leftovers("", 2))).toBe(HEAD);
    expect(inheritedHeadOf(leftovers(null, 0))).toBe(HEAD);
  });

  it("names nothing for a clean, pushed tree", () => {
    expect(inheritedHeadOf(leftovers("", 0))).toBe("");
  });
});

describe("headSyncState on the PR head", () => {
  it("reads the named head as inherited, so the drive does not end", async () => {
    const sync = await headSyncState(true, HEAD, HEAD, HEAD);
    expect(sync).toBe("inherited");
    expect(mayEndWithoutWork(0, sync, false)).toBe(false);
  });

  it("owes the round with head sync off too, the local head unread", async () => {
    expect(await headSyncState(false, HEAD, "", HEAD)).toBe("inherited");
    expect(await headSyncState(false, HEAD, HEAD, HEAD)).toBe("inherited");
  });

  it("stays in sync when no head is named, or another one is", async () => {
    expect(await headSyncState(true, HEAD, HEAD, "")).toBe("in-sync");
    expect(await headSyncState(true, HEAD, HEAD, "b".repeat(40))).toBe(
      "in-sync",
    );
    expect(await headSyncState(false, HEAD, "", "")).toBe("in-sync");
  });
});
