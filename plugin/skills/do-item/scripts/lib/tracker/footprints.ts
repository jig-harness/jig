/** Adapter-independent footprint reads reuse trusted comments and governed writes. */
import { randomUUID } from "node:crypto";
import { withOperation } from "../../../../../shared/outbound/ledger.ts";
import {
  failureOf,
  OutboundError,
} from "../../../../../shared/outbound/failure.ts";
import { currentMs } from "../../../../../shared/time.ts";
import { withCommentBound } from "./comment-bounds.ts";
import { FOOTPRINT_BATCH_SIZE, withFootprintBatch } from "./footprint-batch.ts";
import { footprintBody } from "../../../../../shared/footprint.ts";
import { footprintReading } from "./footprint-reading.ts";
import type {
  FootprintCacheEntry,
  FootprintItem,
  FootprintReading,
  TrackerFootprints,
  FootprintReadOptions,
} from "./footprint-port.ts";
import type { Tracker } from "./port.ts";

type Comments = Pick<Tracker, "issueComments" | "postComment"> &
  Partial<Pick<Tracker, "adapter" | "team" | "instance" | "configKey">>;
type Attempt = {
  entry?: FootprintCacheEntry;
  failure?: ReturnType<typeof failureOf>;
};
interface Cycle {
  attempts: Map<string, Promise<Attempt>>;
  fresh: number;
}
interface ReadContext {
  options: FootprintReadOptions;
  cycle: Cycle;
  maxFresh: number;
  signal: AbortSignal;
}

function freshLimit(options: FootprintReadOptions): number {
  const max = options.maxFresh ?? 20;
  if (!Number.isInteger(max) || max < 0 || max > 100)
    throw new OutboundError(
      "invalid",
      "footprint maxFresh must be an integer from 0 to 100",
    );
  return max;
}
function readSignal(options: FootprintReadOptions): AbortSignal {
  const left =
    Math.min(options.deadline ?? Infinity, currentMs() + 30_000) - currentMs();
  const timeout =
    left <= 0
      ? AbortSignal.abort(
          new DOMException("footprint deadline elapsed", "TimeoutError"),
        )
      : AbortSignal.timeout(left);
  return options.signal === undefined
    ? timeout
    : AbortSignal.any([timeout, options.signal]);
}
function reusable(
  entry: FootprintCacheEntry | undefined,
  item: FootprintItem,
  context: ReadContext,
  commentsUpdateIssue: boolean,
): boolean {
  if (entry === undefined || item.updatedAt === undefined) return false;
  return (
    entry.updatedAt === item.updatedAt &&
    (commentsUpdateIssue || entry.scopeRead === context.options.scopeRead)
  );
}

class FootprintReader {
  readonly cycles = new WeakMap<object, Cycle>();
  readonly tracker: Comments;
  readonly commentsUpdateIssue: boolean;
  /** Trust and item identities belong to this adapter instance, not its display team name. */
  readonly scope = randomUUID();
  constructor(tracker: Comments, commentsUpdateIssue: boolean) {
    this.tracker = tracker;
    this.commentsUpdateIssue = commentsUpdateIssue;
  }
  context(options: FootprintReadOptions): ReadContext {
    const maxFresh = freshLimit(options);
    let cycle = this.cycles.get(options.cycle);
    if (cycle === undefined) {
      cycle = { attempts: new Map(), fresh: 0 };
      this.cycles.set(options.cycle, cycle);
    }
    return { options, cycle, maxFresh, signal: readSignal(options) };
  }
  async fresh(
    item: FootprintItem,
    key: string,
    context: ReadContext,
  ): Promise<Attempt> {
    return withOperation("footprint", () =>
      withCommentBound(async () => {
        try {
          context.signal.throwIfAborted();
          const { comments } = await this.tracker.issueComments(
            item.key,
            context.signal,
          );
          const entry = {
            comments,
            updatedAt: item.updatedAt,
            scopeRead: context.options.scopeRead,
            readAt: currentMs(),
          };
          context.options.cache.set(key, entry);
          return { entry };
        } catch (error) {
          return { failure: failureOf(error) };
        }
      }),
    );
  }
  async item(
    item: FootprintItem,
    context: ReadContext,
  ): Promise<FootprintReading> {
    const key = JSON.stringify([this.scope, item.key]);
    const previous = context.options.cache.get(key);
    if (reusable(previous, item, context, this.commentsUpdateIssue))
      return footprintReading(item, previous, context.options);
    let attempt = context.cycle.attempts.get(key);
    if (attempt === undefined && context.cycle.fresh >= context.maxFresh)
      return footprintReading(
        item,
        previous,
        context.options,
        "fresh footprint read limit",
      );
    if (attempt === undefined) {
      context.cycle.fresh++;
      attempt = this.fresh(item, key, context);
      context.cycle.attempts.set(key, attempt);
    }
    const result = await attempt;
    return footprintReading(
      item,
      result.entry ?? previous,
      context.options,
      result.failure?.code,
      result.failure,
    );
  }
  async read(
    items: readonly FootprintItem[],
    options: FootprintReadOptions,
  ): Promise<Map<string, FootprintReading>> {
    const context = this.context(options);
    const out = new Map<string, FootprintReading>();
    for (let start = 0; start < items.length; start += FOOTPRINT_BATCH_SIZE) {
      const batch = items.slice(start, start + FOOTPRINT_BATCH_SIZE);
      const results = await withFootprintBatch(() =>
        Promise.all(batch.map((item) => this.item(item, context))),
      );
      for (const result of results) out.set(result.key, result);
    }
    return out;
  }
}

/** All adapters get this port after their comment trust policy and transport have been installed. */
export function trackerFootprints(
  tracker: Comments,
  commentsUpdateIssue: boolean,
): TrackerFootprints {
  const reader = new FootprintReader(tracker, commentsUpdateIssue);
  return {
    footprintCommentsUpdateIssue: commentsUpdateIssue,
    footprints: (items, options) => reader.read(items, options),
    async writeFootprint(record, signal) {
      const body = footprintBody(record);
      await withOperation("footprint", () =>
        tracker.postComment(record.key, body, signal),
      );
    },
  };
}
