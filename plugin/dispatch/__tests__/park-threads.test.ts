/**
 * dispatch: what a parked thread's kept reading is reused for: only while
 * the pull request's review comments stand as they did, and not past the
 * backstop.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { failed, ok } from "../../shared/outcome.ts";
import { isoFromMs } from "../../shared/time.ts";
import type { CommentLike } from "../../skills/drive-pr/scripts/lib/driver/rearm.ts";
import {
  forgetClosedParkThreads,
  keptParkThreads,
  LISTING_SETTLE_MS,
  type ParkThreadDeps,
  THREAD_BACKSTOP_MS,
} from "../lib/sources/park-threads.ts";

const SLUG = "example-org/example-repo";
const START = 1_800_000_000_000;
const COMMENT: CommentLike = {
  author: "a-maintainer",
  association: "OWNER",
  at: "2026-10-30T22:00:00Z",
  editedAt: null,
  url: "https://example.test/c/1",
  body: "Keep three retries.",
};
const REVIEW = {
  id: 1,
  updated_at: "2026-10-30T22:00:00Z",
  author_association: "OWNER",
  user: { login: "a-maintainer" },
  body: "Keep three retries.",
};

afterEach(() => {
  setSystemTime();
});

/** A forge answering `listing` and a store held in a map. */
function deps(start: unknown[] = [REVIEW]) {
  const held = new Map<string, unknown>();
  const state = { listing: start, sets: 0 };
  const out: ParkThreadDeps = {
    listing: async () => ok(state.listing),
    store: {
      get: <T>(key: string) => (held.get(key) ?? null) as T | null,
      set: (key, value) => {
        state.sets += 1;
        held.set(key, JSON.parse(JSON.stringify(value)));
      },
    },
  };
  return { out, state, held };
}

/** One tick's reading of thread `T`: what it reused, keeping `COMMENT` when it had to read. */
async function tick(d: ParkThreadDeps): Promise<CommentLike[] | null> {
  const kept = await keptParkThreads(SLUG, 7, undefined, d);
  const held = kept.held("T");
  if (held === null) kept.keep("T", [COMMENT]);
  kept.save();
  return held;
}

describe("a parked thread's kept reading", () => {
  it("is reused while the review comments stand, and stored once", async () => {
    const { out, state } = deps();
    expect(await tick(out)).toBeNull();
    expect(await tick(out)).toEqual([COMMENT]);
    expect(await tick(out)).toEqual([COMMENT]);
    expect(state.sets).toBe(1);
  });

  it("is not reused once a review comment changed, and a reaction changes nothing", async () => {
    let now = START;
    setSystemTime(new Date(now));
    const { out, state } = deps();
    await tick(out);
    state.listing = [{ ...REVIEW, reactions: { total_count: 1 } }];
    expect(await tick(out)).toEqual([COMMENT]);
    for (const changed of [
      [REVIEW, { ...REVIEW, id: 2 }],
      [{ ...REVIEW, body: "Keep two." }],
      [{ ...REVIEW, updated_at: "2026-10-30T23:00:00Z" }],
      [{ ...REVIEW, author_association: "NONE" }],
      [{ ...REVIEW, user: { login: "renamed" } }],
      [],
    ]) {
      state.listing = changed;
      expect(await tick(out)).toBeNull();
      now += LISTING_SETTLE_MS;
      setSystemTime(new Date(now));
      expect(await tick(out)).toBeNull();
      expect(await tick(out)).toEqual([COMMENT]);
    }
  });

  it("is not reused from a reading taken just after the review comments changed", async () => {
    setSystemTime(new Date(START));
    const { out, state } = deps();
    await tick(out);
    state.listing = [REVIEW, { ...REVIEW, id: 2 }];
    expect(await tick(out)).toBeNull();
    setSystemTime(new Date(START + LISTING_SETTLE_MS - 1));
    expect(await tick(out)).toBeNull();
    setSystemTime(new Date(START + LISTING_SETTLE_MS));
    expect(await tick(out)).toBeNull();
    expect(await tick(out)).toEqual([COMMENT]);
  });

  it("settles a first reading from the time of the newest review comment", async () => {
    setSystemTime(new Date(START));
    const written = isoFromMs(START - LISTING_SETTLE_MS + 1);
    const { out } = deps([{ ...REVIEW, updated_at: written }]);
    expect(await tick(out)).toBeNull();
    expect(await tick(out)).toBeNull();

    const older = isoFromMs(START - LISTING_SETTLE_MS);
    const { out: settled } = deps([{ ...REVIEW, updated_at: older }]);
    expect(await tick(settled)).toBeNull();
    expect(await tick(settled)).toEqual([COMMENT]);
  });

  it("asks nothing once the tick's bound has ended, and gives the listing what is left", async () => {
    setSystemTime(new Date(START));
    const asked: Array<number | undefined> = [];
    const { out } = deps();
    const counted: ParkThreadDeps = {
      ...out,
      listing: (target, deadline) => {
        asked.push(deadline.timeoutSec);
        return out.listing(target, deadline);
      },
    };
    const { signal } = new AbortController();
    const ended = await keptParkThreads(
      SLUG,
      7,
      { signal, deadline: START },
      counted,
    );
    expect(ended.held("T")).toBeNull();
    expect(asked).toEqual([]);
    await keptParkThreads(
      SLUG,
      7,
      { signal, deadline: START + 5_000 },
      counted,
    );
    expect(asked).toEqual([5]);
  });

  it("is read again at the backstop, and kept from then", async () => {
    setSystemTime(new Date(START));
    const { out } = deps();
    await tick(out);
    setSystemTime(new Date(START + THREAD_BACKSTOP_MS - 1));
    expect(await tick(out)).toEqual([COMMENT]);
    setSystemTime(new Date(START + THREAD_BACKSTOP_MS));
    expect(await tick(out)).toBeNull();
    expect(await tick(out)).toEqual([COMMENT]);
  });

  it("is not reused from a reading dated after now", async () => {
    setSystemTime(new Date(START));
    const { out } = deps();
    await tick(out);
    setSystemTime(new Date(START - 1));
    expect(await tick(out)).toBeNull();
  });

  it("is neither reused nor stored while the review comments do not list", async () => {
    const { out, state } = deps();
    await tick(out);
    const down: ParkThreadDeps = {
      ...out,
      listing: async () => failed("unreadable", "no answer"),
    };
    expect(await tick(down)).toBeNull();
    expect(state.sets).toBe(1);
  });

  it("is read again when the stored record does not read", async () => {
    const { out, held } = deps();
    await tick(out);
    const [key] = [...held.keys()];
    for (const bad of [
      "garbage",
      { listing: 1, threads: {} },
      {
        listing: "x",
        changedAt: 0,
        threads: { T: { readAt: "soon", comments: [] } },
      },
      { listing: "x", threads: {} },
    ]) {
      held.set(key as string, bad);
      expect(await tick(out)).toBeNull();
    }
  });

  it("keeps only what this tick read or reused", async () => {
    const { out, held } = deps();
    const first = await keptParkThreads(SLUG, 7, undefined, out);
    first.keep("T", [COMMENT]);
    first.keep("gone", [COMMENT]);
    first.save();
    const next = await keptParkThreads(SLUG, 7, undefined, out);
    next.held("T");
    next.keep("new", [COMMENT]);
    next.save();
    const [record] = [...held.values()] as Array<{
      threads: Record<string, unknown>;
    }>;
    expect(Object.keys(record?.threads ?? {}).sort()).toEqual(["T", "new"]);
  });

  it("is forgotten for pull requests no longer open, within its repository alone", () => {
    const calls: Array<[string, readonly string[]]> = [];
    forgetClosedParkThreads(SLUG, [7, 9], {
      prune: (prefix, live) => calls.push([prefix, live]),
    });
    expect(calls).toEqual([
      [
        `park-threads:${SLUG}#`,
        [`park-threads:${SLUG}#7`, `park-threads:${SLUG}#9`],
      ],
    ]);
  });
});
