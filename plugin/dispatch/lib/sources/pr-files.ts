/** Read the changed files of every open pull request, reusing a complete comparison between ticks. */
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import { isoFromMs } from "../../../shared/time.ts";
import { branchHead, type ListedPr, pullRequestFiles } from "../forge.ts";
import { pickupReads } from "../pickup-reads.ts";
import { readFailureOf } from "../read-failures.ts";
import type { ReadFailure } from "../types.ts";
import {
  ended,
  heldRead,
  passedRead,
  secondsLeft,
  type TickBound,
} from "./bounded.ts";

/** The most pull requests a repository reads fresh in one tick, even if every read fails. */
const FRESH_LIMIT = 8;
/**
 * Fallback listings need a live base-tip witness before their cached files can
 * be reused. Leave room for a population larger than the two fresh-read
 * batches so every member can become decidable on a later tick.
 */
const FALLBACK_TIP_LIMIT = FRESH_LIMIT * 2 + 1;
/** Temporal.Instant accepts epoch milliseconds only in this inclusive range. */
const EPOCH_MS_LIMIT = 8_640_000_000_000_000;

type Reading = Outcome<string[], "unreadable" | "deferred">;
type BranchReading = Outcome<string, "unreadable">;

interface Snapshot {
  comparison: string | null;
  files: string[];
  readAtMs: number;
}

interface Entry {
  attemptedAtMs: number;
  snapshot: Snapshot | null;
}

function epochMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= EPOCH_MS_LIMIT
  );
}

/** Stored reads are process-independent JSON: validate them before a cache hit can use them. */
function entryOf(value: unknown): Entry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const entry = value as Record<string, unknown>;
  if (!epochMs(entry.attemptedAtMs)) return null;
  const snapshot = snapshotOf(entry.snapshot);
  if (snapshot === undefined) return null;
  return { attemptedAtMs: entry.attemptedAtMs, snapshot };
}

function snapshotOf(value: unknown): Snapshot | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const snapshot = value as Record<string, unknown>;
  if (
    (typeof snapshot.comparison !== "string" && snapshot.comparison !== null) ||
    !Array.isArray(snapshot.files) ||
    !snapshot.files.every((file) => typeof file === "string") ||
    !epochMs(snapshot.readAtMs)
  )
    return undefined;
  return {
    comparison: snapshot.comparison,
    files: snapshot.files,
    readAtMs: snapshot.readAtMs,
  };
}

interface FilesEvidence {
  pr: number;
  readAt: string;
  ageMs: number;
}

interface MissingEvidence {
  reason: string;
  failure?: ReadFailure;
}

type Evidence<Files> =
  | (FilesEvidence & Files & { status: "fresh" | "cached" })
  | (FilesEvidence & Files & MissingEvidence & { status: "aged" })
  | (MissingEvidence & { pr: number; status: "unread" });

type PrFileEvidence = Evidence<{ files: string[] }>;

/** A receipt carries counts and provenance. Full paths stay on the observation and in the cache. */
export type PrFileSummary = Evidence<{ pathCount: number }>;

export interface FilesObservation {
  evidence: PrFileEvidence[];
  /** Serialization needs current evidence. An aged reading retains its files only on the observation. */
  files(pr: number): Promise<Reading>;
}

interface WorkItem {
  pr: ListedPr;
  key: string;
  entry: Entry | null;
  comparison: string | null;
}

/**
 * Current serialization evidence needs the live base tip. A fallback listing
 * obtains that witness through a bounded branch read before it can reuse its
 * changed-file snapshot.
 */
function comparison(pr: ListedPr, liveTip: string | undefined): string | null {
  const { headRefOid, baseRefName, baseRefOid } = pr;
  const baseTipOid = pr.baseTipOid ?? liveTip;
  if (!headRefOid || !baseRefName || !baseRefOid || !baseTipOid) return null;
  return JSON.stringify([
    headRefOid,
    baseRefName,
    baseRefOid,
    baseTipOid ?? null,
  ]);
}

function fileEvidence(
  pr: number,
  snapshot: Snapshot,
  nowMs: number,
): FilesEvidence & { files: string[] } {
  return {
    pr,
    files: snapshot.files,
    readAt: isoFromMs(snapshot.readAtMs),
    ageMs: Math.max(0, nowMs - snapshot.readAtMs),
  };
}

function missingEvidence(
  pr: number,
  snapshot: Snapshot | null,
  failure: Extract<Reading, { ok: false }>["failure"],
  nowMs: number,
): PrFileEvidence {
  const cause = readFailureOf(failure);
  const detail = {
    reason: failure.reason,
    ...(cause === undefined ? {} : { failure: cause }),
  };
  return snapshot === null
    ? { pr, status: "unread", ...detail }
    : { ...fileEvidence(pr, snapshot, nowMs), status: "aged", ...detail };
}

export function summarizePrFiles(
  evidence: FilesObservation["evidence"],
): PrFileSummary[] {
  return evidence.map((entry) => {
    if (!("files" in entry)) return entry;
    const { files, ...summary } = entry;
    return { ...summary, pathCount: files.length };
  });
}

function oldestFirst(a: WorkItem, b: WorkItem): number {
  return (a.entry?.attemptedAtMs ?? -1) - (b.entry?.attemptedAtMs ?? -1);
}

async function prepareWork(
  slug: string,
  open: readonly ListedPr[],
  skipped: string | null,
  bound: TickBound | undefined,
  store: typeof pickupReads,
  head: typeof branchHead,
): Promise<WorkItem[]> {
  const prefix = `forge:pr-files:${slug}:`;
  const tips = new Map<string, BranchReading>();
  async function liveTip(pr: ListedPr): Promise<string | undefined> {
    if (pr.baseTipOid !== undefined) return pr.baseTipOid;
    if (pr.baseRefName === undefined || pr.baseRefName === "") return undefined;
    let reading = tips.get(pr.baseRefName);
    // Bound fallback witnesses separately from file reads: one branch can
    // witness many pull requests, and an unwitnessed branch remains fresh-only.
    if (reading === undefined && tips.size < FALLBACK_TIP_LIMIT) {
      reading = await heldRead(
        bound,
        "the base branch's live tip was read",
        () => head(slug, pr.baseRefName as string, secondsLeft(bound)),
      );
      tips.set(pr.baseRefName, reading);
    }
    return reading?.ok === true ? reading.value : undefined;
  }
  const work: WorkItem[] = open.map((pr) => ({
    pr,
    key: `${prefix}${pr.number}`,
    entry: entryOf(store.get<unknown>(`${prefix}${pr.number}`)),
    comparison: null,
  }));
  // Allocate the bounded fallback witnesses in the same age order as fresh
  // file reads, so a large population of distinct base branches progresses.
  work.sort(oldestFirst);
  for (const item of work)
    item.comparison = comparison(
      item.pr,
      skipped === null ? await liveTip(item.pr) : undefined,
    );
  store.prune(
    prefix,
    work.map(({ key }) => key),
  );
  return work.sort(oldestFirst);
}

function deferredRead(
  bound: TickBound | undefined,
  skipped: string | null,
  fresh: number,
): Extract<Reading, { ok: false }> | null {
  if (ended(bound)) return passedRead("the pull request's files were read");
  if (skipped !== null) return failed("deferred", skipped);
  if (fresh >= FRESH_LIMIT)
    return failed(
      "deferred",
      "the tick reached its fresh pull request file read limit",
    );
  return null;
}

export async function observePrFiles(
  slug: string,
  open: readonly ListedPr[],
  nowMs: number,
  skipped: string | null,
  bound?: TickBound,
  store = pickupReads,
  read = pullRequestFiles,
  head = branchHead,
): Promise<FilesObservation> {
  const readings = new Map<number, Reading>();
  const evidence: PrFileEvidence[] = [];
  const work = await prepareWork(slug, open, skipped, bound, store, head);

  let fresh = 0;

  for (const { pr, key, entry, comparison } of work) {
    const snapshot = entry?.snapshot ?? null;
    if (comparison !== null && snapshot?.comparison === comparison) {
      readings.set(pr.number, ok(snapshot.files));
      evidence.push({
        ...fileEvidence(pr.number, snapshot, nowMs),
        status: "cached",
      });
      continue;
    }

    const deferred = deferredRead(bound, skipped, fresh);
    const result =
      deferred ??
      (await heldRead(bound, "the pull request's file listing", () =>
        read(slug, pr.number, bound),
      ));
    if (deferred === null) fresh++;
    readings.set(pr.number, result);

    if (result.ok) {
      const next = { comparison, files: result.value, readAtMs: nowMs };
      store.set(key, { attemptedAtMs: nowMs, snapshot: next } satisfies Entry);
      evidence.push({
        ...fileEvidence(pr.number, next, nowMs),
        status: "fresh",
      });
    } else {
      if (deferred === null)
        store.set(key, { attemptedAtMs: nowMs, snapshot } satisfies Entry);
      evidence.push(
        missingEvidence(pr.number, snapshot, result.failure, nowMs),
      );
    }
  }

  return {
    evidence: evidence.sort((a, b) => a.pr - b.pr),
    files: async (pr) =>
      readings.get(pr) ??
      failed("unreadable", "the pull request was absent from the open listing"),
  };
}
