/**
 * The issue-tracker port: everything the launcher asks of the tracker that
 * started it.
 *
 * The launch is the same whatever the tracker: read the issue, assign it to
 * whoever opened it, write the context cache, pick the repository from a label,
 * hand over to the workspace provider. Only how the issue is read and assigned
 * differs, and that is this interface. Linear is the first implementation.
 * Adding one means adding a file under `trackers/` and registering it in
 * `trackers/index.ts`; the launch code does not change.
 */
import type { ContextCache, FallbackEnvironment } from "./cache.ts";

export interface ReadRequest {
  /** The issue key, e.g. `ENG-123`. */
  issue: string;
  /** The label group whose value names the repository. */
  repoLabelGroup: string;
  /** Filled into the cache where the read leaves a field empty. */
  fallback: FallbackEnvironment;
  /** Stamped into the cache as `cached_at`. */
  nowSeconds: number;
  /**
   * Aborted when the launch stops waiting for the read. The tracker stops what
   * it started and reports the issue `unavailable`, so a stuck tracker cannot
   * hold the launch forever.
   */
  signal: AbortSignal;
}

export interface IssueRead {
  /**
   * The context cache to write, or null when what was read must not be
   * presented as a fresh read (a field the skill relies on could not be read
   * and has no fallback).
   */
  cache: ContextCache | null;
  /** The issue's label in `repoLabelGroup`, or null. */
  repoLabel: string | null;
  /** What the read left out or read only in part, one line each. */
  warnings: string[];
  /**
   * Assign the issue to whoever opened it; resolves whether it is now theirs
   * and, when not, why. Never throws; `signal` bounds it as it bounds the
   * read, resolving not assigned.
   */
  assignToOpener(signal: AbortSignal): Promise<AssignResult>;
}

export type AssignResult =
  | { assigned: true }
  | { assigned: false; reason: string };

export interface Tracker {
  /** The name `tracker:` uses. */
  readonly name: string;
  /** What the tracker passed in the launcher's environment. */
  readonly launchEnvironment: FallbackEnvironment;
  /**
   * Read the issue. Never throws: `unavailable` says why it could not be read
   * (no credential, unreachable), and the launch carries on without it.
   */
  read(request: ReadRequest): Promise<IssueRead | { unavailable: string }>;
}

export interface TrackerOptions {
  home: string;
  env: Record<string, string | undefined>;
}
