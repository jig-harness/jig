/** Tracker footprints are predictions, with explicit age and a reason when no fresh answer exists. */
import type { OutboundFailure } from "../../../../../shared/outbound/failure.ts";
import type { CommentFact } from "./comment-port.ts";
import type { FootprintRecord } from "../../../../../shared/footprint.ts";

export interface FootprintItem {
  key: string;
  updatedAt?: string;
  labels: readonly string[];
  /** Claim's session id, supplied only after the caller verifies that session is running. */
  activePickup?: string;
}
export interface FootprintReading {
  key: string;
  source: FootprintRecord["source"] | "labels" | "unknown";
  paths: string[];
  areas: string[];
  record: FootprintRecord | null;
  /** Time of the last complete comment read, null when never read. */
  readAt: number | null;
  ageMs: number | null;
  stale: boolean;
  reason?: string;
  failure?: OutboundFailure;
}
/** Caller-owned in-memory cache may live across ticks of the same adapter instance. */
export interface FootprintCacheEntry {
  updatedAt: string | undefined;
  scopeRead: string;
  readAt: number;
  comments: CommentFact[];
}
export interface FootprintReadOptions {
  /** One identity per tick: failures and successful reads are not sent again in that tick. */
  cycle: object;
  /** Changes on each scheduled full tracker scope read; needed when comments do not move updatedAt. */
  scopeRead: string;
  /** Reader-private keys prevent reuse across adapter instances, workspaces or credentials. */
  cache: Map<string, FootprintCacheEntry>;
  /** Catalog's own area labels, without its implied-area closure. */
  areaLabels?: Readonly<Record<string, readonly string[]>>;
  /** Wanted pickups go first in the input order. Default 20; hard ceiling 100. */
  maxFresh?: number;
  deadline?: number;
  signal?: AbortSignal;
}
export interface TrackerFootprints {
  /** Whether a comment reliably moves an item's updatedAt; false uses scopeRead as well. */
  readonly footprintCommentsUpdateIssue: boolean;
  footprints(
    items: readonly FootprintItem[],
    options: FootprintReadOptions,
  ): Promise<Map<string, FootprintReading>>;
  /** Append a prediction. Refuses malformed payloads before sending, never edits an existing comment. */
  writeFootprint(record: FootprintRecord, signal?: AbortSignal): Promise<void>;
}
