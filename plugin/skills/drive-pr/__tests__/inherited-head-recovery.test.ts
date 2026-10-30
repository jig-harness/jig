/**
 * drive-pr suite: a pass killed with only uncommitted edits still owes the
 * round that settles them. The driver names the witnessed HEAD however the
 * work was left, and the gate reads that HEAD on the PR head itself as an
 * inherited one, so the drive cannot end before a pass has run. Before every
 * gate the driver also hands on commits a pass left unpushed on top of the
 * head branch's remote ref, and stops over commits that do not build on it.
 */

import { describe, expect, it } from "bun:test";
import {
  describeLeftovers,
  inheritedHeadOf,
  type PassLeftovers,
} from "../scripts/lib/driver/restart.ts";
import {
  strandedReason,
  unpushedHeadOf,
  unpushedNoticeFor,
} from "../scripts/lib/driver/unpushed.ts";
import {
  headSyncState,
  mayEndWithoutWork,
} from "../scripts/lib/status/inherited-head.ts";

const HEAD = "a".repeat(40);
const leftovers = (
  uncommitted: string | null,
  unpushed: number | null,
  more: Partial<PassLeftovers> = {},
): PassLeftovers => ({
  uncommitted,
  unpushed,
  operation: null,
  head: HEAD,
  commits: [],
  onRemote: true,
  ...more,
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

describe("unpushedHeadOf", () => {
  it("names the head over commits on top of the remote ref", () => {
    expect(unpushedHeadOf(leftovers("", 1))).toBe(HEAD);
    expect(unpushedHeadOf(leftovers(" M a.ts", 3))).toBe(HEAD);
    // The gate checks the ancestry itself when the driver could not.
    expect(unpushedHeadOf(leftovers("", 1, { onRemote: null }))).toBe(HEAD);
  });

  it("names nothing when nothing is known to be unpushed", () => {
    // A pushed head the API lags behind: local HEAD is the remote ref.
    expect(unpushedHeadOf(leftovers("", 0))).toBe("");
    // Uncommitted edits alone leave HEAD on the PR head: no head lag.
    expect(unpushedHeadOf(leftovers(" M a.ts", 0))).toBe("");
    // No remote ref to count against (no upstream, no attach).
    expect(unpushedHeadOf(leftovers("", null, { onRemote: null }))).toBe("");
    expect(unpushedHeadOf(leftovers("", 1, { head: null }))).toBe("");
  });

  it("names nothing over commits that do not build on the remote ref", () => {
    expect(unpushedHeadOf(leftovers("", 1, { onRemote: false }))).toBe("");
  });
});

describe("strandedReason", () => {
  it("stops over unpushed commits that do not build on the remote ref", () => {
    const why = strandedReason(leftovers("", 2, { onRemote: false }));
    expect(why).toContain(`local HEAD ${HEAD}`);
    expect(why).toContain("does not build on");
  });

  it("lets every other tree through", () => {
    expect(strandedReason(leftovers("", 2))).toBeNull();
    expect(strandedReason(leftovers("", 2, { onRemote: null }))).toBeNull();
    // Behind the remote ref with nothing of its own: not a stranded commit.
    expect(strandedReason(leftovers("", 0, { onRemote: false }))).toBeNull();
    expect(strandedReason(leftovers("", null, { onRemote: false }))).toBeNull();
  });
});

describe("unpushedNoticeFor", () => {
  const notice = "UNPUSHED COMMITS: …";

  it("tells the pass about the unpushed commits", () => {
    expect(
      unpushedNoticeFor({
        inheritedHead: HEAD,
        passNotice: "",
        unpushedNotice: notice,
      }),
    ).toBe(notice);
  });

  it("says nothing twice when the restart notice already names the head", () => {
    expect(
      unpushedNoticeFor({
        inheritedHead: HEAD,
        passNotice: `RESTARTED AFTER A PASS DEADLINE … \`--inherited-head ${HEAD}\``,
        unpushedNotice: notice,
      }),
    ).toBe("");
  });
});

describe("describeLeftovers", () => {
  it("names each unpushed commit under the count", () => {
    const lines = describeLeftovers(
      leftovers("?? stray.txt", 2, {
        commits: ["1234567 second fix", "89abcde first fix"],
      }),
    );
    expect(lines).toContain("  ?? stray.txt");
    expect(lines).toContain("  1234567 second fix");
    expect(lines).toContain("  89abcde first fix");
  });

  it("says how many it did not list", () => {
    const lines = describeLeftovers(
      leftovers("", 30, { commits: ["1234567 newest fix"] }),
    );
    expect(lines).toContain("  … and 29 more");
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
