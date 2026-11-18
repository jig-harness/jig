/** Read the changed files of every open pull request, reusing a complete comparison between ticks. */
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import { isoFromMs } from "../../../shared/time.ts";
import { branchHead, type ListedPr, pullRequestFiles } from "../forge.ts";
import { pickupReads } from "../pickup-reads.ts";
import { readFailureOf } from "../read-failures.ts";
import type { ReadFailure } from "../types.ts";
import { ended, heldRead, passedRead, type TickBound } from "./bounded.ts";

/** The most pull requests a repository reads fresh in one tick, even if every read fails. */
const FRESH_LIMIT = 8;
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
  if (entry.snapshot === null)
    return { attemptedAtMs: entry.attemptedAtMs, snapshot: null };
  if (typeof entry.snapshot !== "object" || Array.isArray(entry.snapshot))
    return null;
  const snapshot = entry.snapshot as Record<string, unknown>;
  if (
    (typeof snapshot.comparison !== "string" && snapshot.comparison !== null) ||
    !Array.isArray(snapshot.files) ||
    !snapshot.files.every((file) => typeof file === "string") ||
    !epochMs(snapshot.readAtMs)
  )
    return null;
  return {
    attemptedAtMs: entry.attemptedAtMs,
    snapshot: {
      comparison: snapshot.comparison,
      files: snapshot.files,
      readAtMs: snapshot.readAtMs,
    },
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
  const prefix = `forge:pr-files:${slug}:`;
  const tips = new Map<string, BranchReading>();
  async function liveTip(pr: ListedPr): Promise<string | undefined> {
    if (pr.baseTipOid !== undefined) return pr.baseTipOid;
    if (pr.baseRefName === undefined || pr.baseRefName === "") return undefined;
    let reading = tips.get(pr.baseRefName);
    // Bound fallback witnesses separately from file reads: one branch can
    // witness many pull requests, and an unwitnessed branch remains fresh-only.
    if (reading === undefined && tips.size < FRESH_LIMIT) {
      reading = await heldRead(
        bound,
        "the base branch's live tip was read",
        () => head(slug, pr.baseRefName as string),
      );
      tips.set(pr.baseRefName, reading);
    }
    return reading?.ok === true ? reading.value : undefined;
  }
  const work = [];
  for (const pr of open) {
    const key = `${prefix}${pr.number}`;
    work.push({
      pr,
      key,
      entry: entryOf(store.get<unknown>(key)),
      comparison: comparison(pr, await liveTip(pr)),
    });
  }
  store.prune(
    prefix,
    work.map(({ key }) => key),
  );
  // A repeatedly refused or too large pull request leaves room for the others next tick.
  work.sort(
    (a, b) => (a.entry?.attemptedAtMs ?? -1) - (b.entry?.attemptedAtMs ?? -1),
  );

  let fresh = 0;
  function deferral(): Extract<Reading, { ok: false }> | null {
    if (ended(bound)) return passedRead("the pull request's files were read");
    if (skipped !== null) return failed("deferred", skipped);
    if (fresh >= FRESH_LIMIT)
      return failed(
        "deferred",
        "the tick reached its fresh pull request file read limit",
      );
    return null;
  }

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

    const deferred = deferral();
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
