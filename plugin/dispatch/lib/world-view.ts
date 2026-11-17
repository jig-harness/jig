/**
 * The world view: what the forge and the tracker say, as one repository's
 * observe phase reads it. Every read the tick makes of the forge's
 * repository facts (which repository a checkout is, its configuration on
 * the default branch), of its pull requests (the open ones with their drive
 * ledgers, the merges with their follow-up markers) and of the tracker's
 * queues goes through one `WorldView`, which the tick's caller can supply
 * (`TickOptions.world`): a test drives a tick from a world of its own, and
 * a hub can serve the reads it holds. Without one, the tick reads through
 * `directWorldView`, which makes the reads the observe phase always made,
 * in the same order and through the same shared reads (`tick-reads.ts`).
 *
 * Every fact the view returns carries its freshness class, the longest it
 * may be stale when a caller serves it from a copy:
 *
 * | Class | Which facts | Stale for at most |
 * | --- | --- | --- |
 * | `active` | An open pull request whose drive runs or is armed: its ledger says its driver runs (`driven`, `silent`), or another instance holds its drive (`refused`) | `ACTIVE_BOUND_MS`, 10 minutes |
 * | `background` | Every other pull request, the repository's own facts, the tracker's queues and items | `BACKGROUND_BOUND_MS`, 75 minutes |
 *
 * A third class, a fact that gates a write, is never served here: it is
 * read on the forge or the tracker at use. That is a launch's fresh read of
 * its pull request, its ledger, its labels and heads (`actions/drive.ts`,
 * `actions/followup.ts`, the reads before a launch in `tick-apply.ts`), a
 * claim's write and read-back (`shared-launches.ts`), the label
 * projection's re-read before each state write (`label-freshness.ts`) and a
 * pickup's fresh read of its item on the tracker (`actions/pickup.ts`).
 *
 * The view holds the world alone. What this host did, its launch records,
 * is the machine view, read beside it (`launches.ts`) and never written
 * into a fact the view returned: the observe phase settles the forge's
 * drives by those records into a list of its own (`RepoObservation.drives`).
 */
import type { SharedRecords } from "../../shared/records/shared.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { defaultBranchConfig, repoTarget } from "./forge.ts";
import type { LabelConfig } from "./labels.ts";
import {
  ended,
  heldRead,
  passedBefore,
  type TickBound,
} from "./sources/bounded.ts";
import type { TickContext, TickOptions } from "./tick-context.ts";
import { type ForgeRead, readForge } from "./tick-forge.ts";
import type { OpenedRepo } from "./tick-observe.ts";
import type { TickReads } from "./tick-reads.ts";
import {
  readTracker,
  type Tracked,
  type TrackerRequest,
} from "./tick-tracker.ts";
import { prepareTrackers } from "./tick-trackers.ts";
import type {
  DispatchSection,
  LedgerClass,
  RepoReport,
  RepoTarget,
} from "./types.ts";

/** How stale a fact the world view returns may be when it is served from a copy. */
export type FreshnessClass = "active" | "background";

/** The longest an `active` fact may be stale: 10 minutes. */
export const ACTIVE_BOUND_MS = 10 * 60_000;

/** The longest a `background` fact may be stale: 75 minutes, an hourly sweep and its own 15. */
export const BACKGROUND_BOUND_MS = 75 * 60_000;

/** Each class's bound, in milliseconds. */
export const FRESHNESS_BOUND_MS: Readonly<Record<FreshnessClass, number>> = {
  active: ACTIVE_BOUND_MS,
  background: BACKGROUND_BOUND_MS,
};

/** One fact the world view returns, with its class. */
export interface Fact<T> {
  readonly value: T;
  readonly freshness: FreshnessClass;
}

/** The forge's part of a repository's tick, with each pull request's class: the read's own class is the strictest of them. */
export interface ForgeFacts extends Fact<ForgeRead> {
  /** Each pull request the read names, open or merged, by number. */
  readonly pullRequests: ReadonlyMap<number, FreshnessClass>;
}

/** What the forge's part of a repository's tick is asked with. */
export interface ForgeRequest {
  repo: RepoTarget;
  /** The report the read's records and unplaced targets go on. */
  report: RepoReport;
  section: DispatchSection;
  /** The dispatch labels, where the repository turns them on. */
  labels: LabelConfig | null;
  nowMs: number;
  /** The shared records as the forge's login, through which the merges' follow-up markers are read. */
  shared: (login: string | null) => SharedRecords;
}

/** Which repository a checkout is: `passed` when the tick's bound ended before it was read. */
export type TargetOutcome = Outcome<Fact<RepoTarget>, "unreadable" | "passed">;

/** The configuration file on a repository's default branch; `null` where it holds none. */
export type ConfigurationOutcome = Outcome<Fact<string | null>, "unreadable">;

/** The forge and the tracker as one repository's observe phase reads them. */
export interface WorldView {
  /** Which repository the checkout at `path` is. */
  target(path: string): Promise<TargetOutcome>;
  /** The configuration on `repo`'s default branch, the repository the checkout at `path` is. */
  configuration(path: string, repo: RepoTarget): Promise<ConfigurationOutcome>;
  /**
   * The tracker queues every opened repository reads, gathered once for
   * all of them before any derives its pickups (`tick-trackers.ts`); each
   * repository's `tracker` read is answered from them.
   */
  gatherQueues(
    opened: readonly OpenedRepo[],
    context: TickContext,
  ): Promise<void>;
  /** The tracker's part of one repository's tick; its `tracker` is the handle a pickup's fresh read goes through, never a fact. */
  tracker(request: TrackerRequest): Promise<Fact<Tracked>>;
  /** The forge's part of one repository's tick. */
  forge(request: ForgeRequest): Promise<ForgeFacts>;
}

/** The ledger classes of a drive that runs or is armed. */
const ACTIVE_CLASSES: ReadonlySet<LedgerClass> = new Set<LedgerClass>([
  "driven",
  "silent",
  "refused",
]);

/** A fact of the `background` class. */
export function background<T>(value: T): Fact<T> {
  return { value, freshness: "background" };
}

/** The forge's read with each pull request's class, from the drives the forge read: `active` for an open one whose drive runs or is armed. */
export function forgeFacts(read: ForgeRead): ForgeFacts {
  const pullRequests = new Map<number, FreshnessClass>();
  for (const pr of [...read.merged, ...read.open])
    pullRequests.set(pr.number, "background");
  const open = new Set(read.open.map((pr) => pr.number));
  for (const drive of read.drives)
    if (open.has(drive.number) && ACTIVE_CLASSES.has(drive.class))
      pullRequests.set(drive.number, "active");
  const active = [...pullRequests.values()].includes("active");
  return {
    value: read,
    freshness: active ? "active" : "background",
    pullRequests,
  };
}

/**
 * The reads the observe phase always made, through the tick's shared reads
 * `reads`, kept to `bound`: a repository's facts from its query, else read
 * one by one; the tracker's queues and part; the forge's part
 * (`tick-forge.ts`).
 */
export function directWorldView(
  reads: TickReads,
  bound: TickBound | undefined,
): WorldView {
  return {
    async target(path) {
      const queried = await reads.repository(path);
      if (queried.ok) return ok(background(queried.value.target));
      // The one-by-one reads are not started once the bound has ended.
      if (ended(bound))
        return failed("passed", passedBefore("this repository was opened"));
      const read = await reads.pool.run(() =>
        heldRead(bound, "this repository was identified", () =>
          repoTarget(path),
        ),
      );
      return read.ok ? ok(background(read.value)) : read;
    },
    async configuration(path, repo) {
      const queried = await reads.repository(path);
      if (queried.ok) return ok(background(queried.value.config));
      const read = await reads.pool.run(() =>
        heldRead(bound, "its dispatch section was read", () =>
          defaultBranchConfig(repo),
        ),
      );
      return read.ok ? ok(background(read.value)) : read;
    },
    gatherQueues: (opened, context) => prepareTrackers(opened, context),
    async tracker(request) {
      return background(
        await reads.pool.run(() => readTracker(request, bound, reads)),
      );
    },
    async forge(request) {
      return forgeFacts(
        await readForge(
          request.repo,
          request.report,
          request.section,
          request.labels,
          request.nowMs,
          request.shared,
          reads,
        ),
      );
    },
  };
}

/** The world view one tick reads through: the direct one over its shared reads, as its caller's `world` makes it over that. */
export function tickWorld(
  options: Pick<TickOptions, "world">,
  reads: TickReads,
  bound: TickBound | undefined,
): WorldView {
  const direct = directWorldView(reads, bound);
  return options.world === undefined ? direct : options.world(direct);
}

/** The world view a phase reads through: the tick's, else the direct one over its shared reads. */
export function worldOf(context: {
  world?: WorldView | undefined;
  reads: TickReads;
  bound?: TickBound | undefined;
}): WorldView {
  return context.world ?? directWorldView(context.reads, context.bound);
}
