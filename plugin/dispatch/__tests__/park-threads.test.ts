/**
 * dispatch: what a parked thread's kept reading is reused for: only while
 * the pull request's review comments stand as they did, and not past the
 * backstop.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { failed, ok } from "../../shared/outcome.ts";
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
  html_url: COMMENT.url,
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

/** Set the clock to `ms` past `START`. */
const at = (ms: number) => setSystemTime(new Date(START + ms));

/** Read the thread as a pull request first seen, then once the listing has settled, at `LISTING_SETTLE_MS`. */
async function settled(d: ParkThreadDeps): Promise<void> {
  at(0);
  await tick(d);
  at(LISTING_SETTLE_MS);
  await tick(d);
}

describe("a parked thread's kept reading", () => {
  it("is reused once the review comments have settled, and stored no more", async () => {
    const { out, state } = deps();
    await settled(out);
    const stored = state.sets;
    expect(await tick(out)).toEqual([COMMENT]);
    expect(await tick(out)).toEqual([COMMENT]);
    expect(state.sets).toBe(stored);
  });

  it("is not reused when taken as the pull request was first seen", async () => {
    at(0);
    const { out } = deps();
    expect(await tick(out)).toBeNull();
    at(LISTING_SETTLE_MS - 1);
    expect(await tick(out)).toBeNull();
    at(LISTING_SETTLE_MS);
    expect(await tick(out)).toBeNull();
    expect(await tick(out)).toEqual([COMMENT]);
  });

  it("is not reused once a review comment changed, and a reaction changes nothing", async () => {
    const { out, state } = deps();
    await settled(out);
    state.listing = [{ ...REVIEW, reactions: { total_count: 1 } }];
    expect(await tick(out)).toEqual([COMMENT]);
    let now = LISTING_SETTLE_MS;
    for (const changed of [
      [REVIEW, { ...REVIEW, id: 2 }],
      [{ ...REVIEW, body: "Keep two." }],
      [{ ...REVIEW, updated_at: "2026-10-30T23:00:00Z" }],
      [{ ...REVIEW, author_association: "NONE" }],
      [{ ...REVIEW, user: { login: "renamed" } }],
    ]) {
      state.listing = changed;
      expect(await tick(out)).toBeNull();
      now += LISTING_SETTLE_MS;
      at(now);
      expect(await tick(out)).toBeNull();
      expect(await tick(out)).toEqual([COMMENT]);
    }
  });

  it("is never kept for a thread the listing does not show", async () => {
    const { out, state } = deps([]);
    await settled(out);
    state.listing = [];
    at(LISTING_SETTLE_MS * 3);
    expect(await tick(out)).toBeNull();
    expect(await tick(out)).toBeNull();
  });

  it("is not reused from a reading taken just after the review comments changed", async () => {
    const { out, state } = deps();
    await settled(out);
    state.listing = [REVIEW, { ...REVIEW, id: 2 }];
    expect(await tick(out)).toBeNull();
    at(2 * LISTING_SETTLE_MS - 1);
    expect(await tick(out)).toBeNull();
    at(2 * LISTING_SETTLE_MS);
    expect(await tick(out)).toBeNull();
    expect(await tick(out)).toEqual([COMMENT]);
  });

  it("asks nothing once the tick's bound has ended, and gives the listing what is left", async () => {
    at(0);
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
    expect(asked).toEqual([1]);
  });

  it("is read again at the backstop, and kept from then", async () => {
    const { out } = deps();
    await settled(out);
    at(LISTING_SETTLE_MS + THREAD_BACKSTOP_MS - 1);
    expect(await tick(out)).toEqual([COMMENT]);
    at(LISTING_SETTLE_MS + THREAD_BACKSTOP_MS);
    expect(await tick(out)).toBeNull();
    expect(await tick(out)).toEqual([COMMENT]);
  });

  it("is not reused from a reading dated after now", async () => {
    const { out } = deps();
    await settled(out);
    at(LISTING_SETTLE_MS - 1);
    expect(await tick(out)).toBeNull();
  });

  it("is neither reused nor stored while the review comments do not list", async () => {
    const { out, state } = deps();
    await settled(out);
    const stored = state.sets;
    const down: ParkThreadDeps = {
      ...out,
      listing: async () => failed("unreadable", "no answer"),
    };
    expect(await tick(down)).toBeNull();
    expect(state.sets).toBe(stored);
  });

  it("is read again when the stored record does not read", async () => {
    const { out, held } = deps();
    await settled(out);
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
    at(0);
    (await keptParkThreads(SLUG, 7, undefined, out)).save();
    at(LISTING_SETTLE_MS);
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

  it("is not kept when the listing shows a reply the thread read lacks", async () => {
    const reply = {
      ...REVIEW,
      id: 2,
      html_url: "https://example.test/c/2",
      in_reply_to_id: 1,
    };
    const { out } = deps([REVIEW, reply]);
    await settled(out);
    expect(await tick(out)).toBeNull();
  });

  it("stores a retired thread's removal when only another thread is reused", async () => {
    const { out, held } = deps();
    await settled(out);
    const key = [...held.keys()][0] as string;
    const record = held.get(key) as { threads: Record<string, unknown> };
    record.threads.gone = record.threads.T;
    at(LISTING_SETTLE_MS * 2);
    const kept = await keptParkThreads(SLUG, 7, undefined, out);
    expect(kept.held("T")).not.toBeNull();
    kept.save();
    const after = held.get(key) as { threads: Record<string, unknown> };
    expect(Object.keys(after.threads)).toEqual(["T"]);
  });
});
