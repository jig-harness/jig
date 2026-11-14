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
  /** Interpret native links under this repository's relation configuration. */
  projectRelations?(
    raw: DispatchRawIssue,
    options?: FacetReadOptions,
  ): Promise<IssueRelation[]>;
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
