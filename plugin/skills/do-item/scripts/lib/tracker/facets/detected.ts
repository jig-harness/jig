/**
 * A tracker whose facets the configuration leaves to the GitHub default
 * (design/tracker-facets.md, "Defaults per adapter"): before the first read
 * or write that touches a facet, detection selects each unnamed facet's
 * store (facets/detect.ts), and the tracker is built over the stores it
 * selected. Detection runs once per tracker, its answer cached on the
 * machine for an hour, and never before an operation that touches no facet
 * (a comment, a state move, a label listing).
 *
 * A facet in conflict (labels and native values both present, no store
 * named) or refused (a Priority field whose options no longer name the
 * priorities) fails closed: every read and write of issues fails with an
 * error naming the stores and the line to add, until the configuration
 * names one; `facetStores()` reports it instead of failing. A detection read
 * that fails is that operation's failure, never labels. A write refused for
 * a value no store resolves drops the cached answer, so the next run reads
 * the tracker again.
 */

import { TrackerConfigError } from "../config-error.ts";
import {
  type Facet,
  type FacetStoreReport,
  type Tracker,
  TrackerRequestError,
} from "../port.ts";
import { readSignal } from "./bounds.ts";
import type { FacetEntry, Facets, ResolvedFacet } from "./config.ts";
import { type Detected, select } from "./detect.ts";

/** What the default needs from the adapter. */
export interface DefaultInputs {
  /** The facets as the configuration names them. */
  configured: Facets;
  /** The facets the configuration leaves to the default. */
  unnamed: Facet[];
  /** Detection for `unnamed`; throws on a failed read. */
  detect(signal?: AbortSignal): Promise<Detected>;
  /** The facets with the stores the default selected, each with why. */
  resolve(
    chosen: Partial<Record<Facet, FacetEntry>>,
    why: Partial<Record<Facet, ResolvedFacet["why"]>>,
  ): Facets;
  /** The tracker over `facets`; `detected` selected them, `null` for the configured ones. */
  build(facets: Facets, detected: Detected | null): Tracker;
  /** Drop the cached detection answer. */
  forget(): Promise<void>;
}

/** A facet whose reads and writes fail closed, and why. */
interface Blocked {
  why: "conflict" | "default";
  problem: string;
}

interface Settled {
  tracker: Tracker;
  blocked: Map<Facet, Blocked>;
}

/** The stores the default selected for `unnamed` from what detection found. */
function settleStores(inputs: DefaultInputs, detected: Detected): Settled {
  const chosen: Partial<Record<Facet, FacetEntry>> = {};
  const why: Partial<Record<Facet, ResolvedFacet["why"]>> = {};
  const blocked = new Map<Facet, Blocked>();
  for (const f of inputs.unnamed) {
    const found = detected.found[f];
    const selection =
      found === undefined
        ? {
            kind: "refused" as const,
            problem: `detection gave no answer for ${f}`,
          }
        : select(f, found);
    if (selection.kind !== "store") {
      blocked.set(f, {
        why: selection.kind === "conflict" ? "conflict" : "default",
        problem: selection.problem,
      });
      continue;
    }
    why[f] = selection.why;
    if (selection.store === "field")
      chosen[f] = { store: "field", field: selection.field ?? "" };
    else if (selection.store === "native") chosen[f] = { store: "native" };
  }
  return {
    tracker: inputs.build(inputs.resolve(chosen, why), detected),
    blocked,
  };
}

function stopReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error("the facet read was stopped");
}

/** Throw for the first of `facets` that fails closed. */
function refuseBlocked(
  settled: Settled,
  facets: ReadonlyArray<Facet> = ["type", "priority", "size"],
): void {
  for (const f of facets) {
    const b = settled.blocked.get(f);
    if (b !== undefined)
      throw new TrackerConfigError(`issue_tracker.facets.${f}`, b.problem);
  }
}

/** The tracker that runs the GitHub default before its first facet read or write. */
export function defaultedTracker(inputs: DefaultInputs): Tracker {
  const base = inputs.build(inputs.configured, null);
  if (inputs.unnamed.length === 0) return base;
  let settled: Promise<Settled> | undefined;
  let shared: AbortController | undefined;
  let waiting = 0;
  /**
   * The settlement, asked once and shared. Detection stops only when every
   * caller waiting on it has stopped; each caller's own signal ends its own
   * wait, whichever caller started the work.
   */
  function settle(signal?: AbortSignal): Promise<Settled> {
    if (signal?.aborted === true) return Promise.reject(stopReason(signal));
    if (settled === undefined) {
      const own = new AbortController();
      const attempt = inputs
        .detect(own.signal)
        .then((detected) => settleStores(inputs, detected));
      shared = own;
      waiting = 0;
      settled = attempt;
      // A failed detection is asked again by the next operation.
      attempt.catch(() => {
        if (settled === attempt) settled = undefined;
      });
    }
    const attempt = settled;
    const work = shared as AbortController;
    if (signal === undefined) {
      waiting = Number.POSITIVE_INFINITY;
      return attempt;
    }
    waiting += 1;
    return new Promise<Settled>((resolve, reject) => {
      const stop = () => {
        waiting -= 1;
        if (waiting <= 0 && settled === attempt) {
          settled = undefined;
          work.abort(signal.reason);
        }
        reject(stopReason(signal));
      };
      signal.addEventListener("abort", stop, { once: true });
      const done = () => signal.removeEventListener("abort", stop);
      attempt.then(
        (v) => {
          done();
          resolve(v);
        },
        (e) => {
          done();
          reject(e);
        },
      );
    });
  }
  /** `run` on the settled tracker, once no facet it needs fails closed. */
  async function on<T>(
    run: (t: Tracker) => Promise<T>,
    facets?: ReadonlyArray<Facet>,
    signal?: AbortSignal,
  ): Promise<T> {
    const s = await settle(signal);
    signal?.throwIfAborted();
    refuseBlocked(s, facets);
    return run(s.tracker);
  }
  /** A write; one refused for a value no store resolves drops the cached answer. */
  async function write<T>(
    run: (t: Tracker) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await on(run, undefined, signal);
    } catch (err) {
      if (err instanceof TrackerRequestError && err.code === "unresolved")
        await inputs.forget();
      throw err;
    }
  }
  return {
    ...base,
    stateName: base.stateName,
    getIssue: (key) => on((t) => t.getIssue(key)),
    openIssues: (query) => on((t) => t.openIssues(query)),
    openChildren: (key) => on((t) => t.openChildren(key)),
    poolIssue: (key, signal) =>
      on((t) => t.poolIssue(key, signal), undefined, signal),
    async assignedIssues(identity, states, options) {
      const s = await settle(readSignal(options));
      refuseBlocked(s);
      return s.tracker.assignedIssues(identity, states, options);
    },
    ledger: (query, onPage) => on((t) => t.ledger(query, onPage), ["priority"]),
    createIssue: (issue) => write((t) => t.createIssue(issue)),
    updateIssue: (key, patch, signal) =>
      write((t) => {
        signal?.throwIfAborted();
        return t.updateIssue(key, patch, signal);
      }, signal),
    async incompleteIssues(query, options) {
      const s = await settle(readSignal(options));
      refuseBlocked(s);
      return s.tracker.incompleteIssues(query, options);
    },
    async openPopulation(options) {
      const s = await settle(readSignal(options));
      refuseBlocked(s);
      return s.tracker.openPopulation(options);
    },
    async facetStores(options) {
      let s: Settled;
      try {
        s = await settle(readSignal(options));
      } catch {
        // The configured facets' own report shows the failed detection in
        // each facet's place.
        return base.facetStores(options);
      }
      const report = await s.tracker.facetStores(options);
      return {
        ...report,
        facets: report.facets.map((r): FacetStoreReport => {
          const b = s.blocked.get(r.facet);
          if (b === undefined) return r;
          const { pin: _, values: __, ...kept } = r;
          return { ...kept, store: null, why: b.why, problem: b.problem };
        }),
      };
    },
  };
}
