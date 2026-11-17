/** Native reads shared by dispatch before repository-specific interpretation. */
import type {
  CanonicalState,
  Tracker,
  FacetReadOptions,
  PoolIssue,
  QueueRelation,
  IssueRelation,
} from "./port.ts";
import { trackerStateMaps } from "./port.ts";

/** Native selectors a scope must retain before any repository's state interpretation. */
export function nativeQueueRequirements(
  tracker: Pick<Tracker, "stateName" | "stateMaps">,
  states: readonly CanonicalState[],
): string[] {
  const names = trackerStateMaps(tracker).flatMap((map) =>
    states.flatMap((state) =>
      map[state] === null ? [] : [`queue-state:${map[state]}`],
    ),
  );
  const closed = states.some(
    (state) =>
      state === "done" || state === "canceled" || state === "duplicate",
  );
  return [...new Set([...names, ...(closed ? ["queue-closed"] : [])])];
}

/** The selectors the repositories sharing one scope demand, growing as each configures. */
export interface Demand {
  readonly selectors: ReadonlySet<string>;
  configure(union: readonly string[]): void;
  readonly shape: string;
}

/** Start from `requirements`; `configure` widens the set and `shape` names it stably. */
export function demandOf(requirements: readonly string[]): Demand {
  let selectors: ReadonlySet<string> = new Set(requirements);
  return {
    get selectors() {
      return selectors;
    },
    configure(union) {
      selectors = new Set([...selectors, ...union]);
    },
    get shape() {
      return JSON.stringify([...selectors].sort((a, b) => a.localeCompare(b)));
    },
  };
}

/** A native tracker row retained before a repository interprets states and facets. */
export interface DispatchRawIssue {
  identifier: string;
  value: unknown;
  relations?: QueueRelation[] | null;
  parent?: {
    issue: DispatchRawIssue;
    description: string;
    parent: string | null;
  } | null;
}

/** Native reads shared by dispatch's repositories, with the local interpretation kept separate. */
export interface DispatchSource {
  /** False when authentication cannot be fingerprinted across processes: no durable issue readings. */
  readonly persistent?: boolean;
  /**
   * Interpret native links under this repository's relation configuration;
   * `null` when the row does not carry them in full, so they are read on
   * their own.
   */
  projectRelations?(
    raw: DispatchRawIssue,
    options?: FacetReadOptions,
  ): Promise<IssueRelation[] | null>;
  /**
   * The row's description and its parent's key (`null` for none), when the
   * row carries both; `null` when it does not, so they are read on their own.
   */
  describe?(
    raw: DispatchRawIssue,
  ): { description: string; parent: string | null } | null;
  /**
   * Who made the current assignment of `assignee` to `key`, without whether
   * that person may start work: `Tracker.assignedBy` in two parts, so a
   * reader keeps the assignment by the item's update time and asks each
   * person's standing once (`writeAccess`). Throws as `assignedBy` does.
   * Present together with `writeAccess`.
   */
  assignmentActor?(
    key: string,
    assignee: string | undefined,
    options?: FacetReadOptions,
  ): Promise<{ id: string; name: string }>;
  /** Whether `person`, an `assignmentActor` id, may start work: `Assigner.trusted`. */
  writeAccess?(person: string, options?: FacetReadOptions): Promise<boolean>;
  readonly requirements?: readonly string[];
  configure?(requirements: readonly string[]): void;
  /** Reuse only native read answers within this credential scope and tick. */
  shareReads?(reads: Map<string, Promise<unknown>>): void;
  readonly shape?: string;
  /** A one-way credential identity; never the credential itself. */
  credential(options?: FacetReadOptions): Promise<string>;
  queue(
    identity: string,
    options?: FacetReadOptions,
  ): Promise<DispatchRawIssue[]>;
  issue(
    key: string,
    options?: FacetReadOptions,
  ): Promise<DispatchRawIssue | null>;
  issues?(
    keys: ReadonlyArray<string>,
    options?: FacetReadOptions,
  ): Promise<Map<string, DispatchRawIssue>>;
  children(
    key: string,
    options?: FacetReadOptions,
  ): Promise<DispatchRawIssue[]>;
  includes?(
    raw: DispatchRawIssue,
    options?: FacetReadOptions,
  ): Promise<boolean>;
  project(
    raw: DispatchRawIssue,
    options?: FacetReadOptions,
  ): Promise<PoolIssue>;
}
