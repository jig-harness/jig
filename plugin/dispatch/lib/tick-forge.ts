/**
 * The forge's part of a repository's tick: the open pull requests (with
 * their labels where the repository turns dispatch labels on, in the same
 * listing) and their ledgers, and the merges with their follow-up markers,
 * read through the shared records (`shared/records/shared.ts`). Every
 * pull request's comments are listed once for the tick and shared between
 * its ledger, its park answers and its claims (`tick-comments.ts`), and a
 * merge whose `updatedAt` has not moved since the markers were last read
 * is not read again (`merge-reads.ts`). Under
 * `only_labeled`, a pull request that carries no label of the set is never
 * read for a ledger, and a merge that carries none wants no follow-up; the
 * scope itself is decided once, by `decideScope`.
 */
import type { SharedRecords } from "../../shared/records/shared.ts";
import { adoptionNote, adoptionOf } from "./adopt.ts";
import { readMarkers } from "./followup-marker.ts";
import { readReleases } from "./followup-releases.ts";
import { type ListedPr, mergedSince, openPullRequests } from "./forge.ts";
import { carriesSet, type LabelConfig } from "./labels.ts";
import {
  type FreshMergeRead,
  keptMarkers,
  readMergeReads,
  writeMergeReads,
} from "./merge-reads.ts";
import { readDrives } from "./sources/ledgers.ts";
import type { Pool } from "./pool.ts";
import type { TickComments } from "./tick-comments.ts";
import { failureText } from "./text.ts";
import type {
  DispatchSection,
  MarkedPr,
  MergedPr,
  RepoReport,
  RepoTarget,
} from "./types.ts";

/** What the forge gave one repository's tick. */
export interface ForgeRead {
  /** Whether the pull requests read in full. */
  ok: boolean;
  open: ListedPr[];
  /** The open pull requests read for a ledger: under `only_labeled`, the labelled ones. */
  read: Set<number>;
  /** Whether `only_labeled` limits what is done: a pull request outside `inScope`, or in `disputed`, then receives no write. */
  scoped: boolean;
  /** Under `only_labeled`, the pull requests in scope this tick: the only ones anything is done on, whatever a launch record says. */
  inScope: Set<number>;
  /** Under `only_labeled`, the pull requests whose scope this tick's listings disagree on: unplaced, nothing done or written on them. */
  disputed: Set<number>;
  /** When each pull request was created, from every observation of it, in scope or not: pickup bookkeeping reads it. */
  created: Map<number, string>;
  drives: Awaited<ReturnType<typeof readDrives>>;
  merged: MarkedPr[];
  login: string | null;
}

/** What the forge's part of a tick reads through beside the forge itself: the tick's comment listings, the login read once per tick, and the pool its listings run through. */
export interface ForgeReads {
  comments: TickComments;
  login(): Promise<string | null>;
  pool: Pool;
}

/**
 * Ask for the comments of every pull request in `prs` at once, so they are
 * read side by side within the pool while the readers that follow take each
 * in turn. A listing's failure is the answer its reader gets.
 */
function prefetch(
  comments: TickComments,
  slug: string,
  prs: readonly { number: number }[],
): void {
  for (const p of prs) comments.read(slug, p.number).catch(() => undefined);
}

/** The forge's part of a repository's tick; `shared` opens the shared records as the login the forge names. */
export async function readForge(
  repo: RepoTarget,
  report: RepoReport,
  section: DispatchSection,
  labels: LabelConfig | null,
  nowMs: number,
  shared: (login: string | null) => SharedRecords,
  reads: ForgeReads,
): Promise<ForgeRead> {
  const read = { labels: labels !== null };
  const managed = <T extends { labels?: string[] }>(prs: T[]): T[] =>
    labels?.onlyLabeled === true
      ? prs.filter((p) => carriesSet(labels, p.labels ?? []))
      : prs;
  const out: ForgeRead = {
    ok: false,
    open: [],
    read: new Set(),
    scoped: labels?.onlyLabeled === true,
    inScope: new Set(),
    disputed: new Set(),
    created: new Map(),
    drives: [],
    merged: [],
    login: null,
  };
  const remember = (prs: readonly { number: number; createdAt?: string }[]) => {
    for (const p of prs)
      if (p.createdAt !== undefined) out.created.set(p.number, p.createdAt);
  };
  const unread = (reason: string) => {
    report.records.push({
      record: "forge",
      source: `gh ${repo.slug}`,
      ok: false,
      detail: `the pull requests cannot be read: ${reason}`,
    });
    out.drives = [];
    out.merged = [];
    out.inScope = new Set();
    out.disputed = new Set();
  };
  try {
    const [open, login] = await Promise.all([
      reads.pool.run(() => openPullRequests(repo.slug, read)),
      reads.login(),
    ]);
    if (!open.ok) {
      unread(open.failure.reason);
      return out;
    }
    out.open = open.value;
    remember(out.open);
    out.login = login;
    const toRead = managed(out.open);
    prefetch(reads.comments, repo.slug, toRead);
    const unlabeled = out.open.length - toRead.length;
    const adoption = adoptionOf(section, out.login);
    out.drives = await readDrives(
      repo.slug,
      out.login,
      toRead,
      nowMs,
      labels,
      adoption,
      (pr) => reads.comments.read(repo.slug, pr),
      (read) => reads.pool.run(read),
    );
    const since = report.followupSince as string;
    out.read = new Set(toRead.map((p) => p.number));
    const observedMs = Date.now();
    const merges =
      section.followupCommand === null
        ? null
        : await reads.pool.run(() => mergedSince(repo.slug, since, read));
    if (merges !== null && !merges.ok) {
      unread(merges.failure.reason);
      return out;
    }
    const listed = merges === null ? [] : merges.value;
    remember(listed);
    const marked = await withMarkers(
      shared(out.login),
      repo.slug,
      managed(listed),
      nowMs,
      out.login,
      (pr) => {
        const began = reads.comments.startedAt(repo.slug, pr);
        return began !== null && began >= observedMs;
      },
    );
    out.merged = marked.merged;
    if (labels?.onlyLabeled === true)
      decideScope(out, report, labels, [out.open, listed]);
    out.ok = true;
    report.records.push({
      record: "forge",
      source: `gh ${repo.slug}`,
      ok: true,
      detail: `${out.open.length} open pull request(s), ${out.drives.length} with a drive ledger${labelNote(labels, unlabeled)}${adoptionNote(adoption, out.drives)}; ${
        section.followupCommand === null
          ? "no dispatch.followup_command: no follow-ups"
          : `${out.merged.length} merged since ${since} (${marked.kept} unchanged since a tick read their markers, not read again)`
      }`,
    });
  } catch (error) {
    unread(failureText(error));
  }
  return out;
}

/**
 * Under `only_labeled`, the scope is decided once per tick, from the
 * listings that hold each pull request (the open one, the merged one): a
 * pull request is in scope when each of them finds a label of the set on
 * it. One they disagree on is unplaced for this tick, as any record the
 * tick cannot place: reported, no action and no label written on it, its
 * notice records kept, and read again at the next tick. A launch's fresh
 * read is the observation that launch acts on, so it decides again there.
 */
function decideScope(
  out: ForgeRead,
  report: RepoReport,
  labels: LabelConfig,
  listings: ReadonlyArray<ReadonlyArray<{ number: number; labels?: string[] }>>,
): void {
  const seen = new Map<number, Set<boolean>>();
  for (const listing of listings)
    for (const p of listing) {
      const views = seen.get(p.number) ?? new Set<boolean>();
      views.add(carriesSet(labels, p.labels ?? []));
      seen.set(p.number, views);
    }
  for (const [n, views] of seen) {
    if (views.size > 1) {
      out.disputed.add(n);
      report.unplaced.push({
        target: `PR #${n}`,
        record: "forge",
        reason:
          "the open and the merged listing disagree on whether it carries a dispatch label, so whether it is in scope cannot be told this tick",
      });
    } else if (views.has(true)) out.inScope.add(n);
  }
}

function labelNote(labels: LabelConfig | null, unlabeled: number): string {
  if (labels === null) return "";
  return labels.onlyLabeled
    ? ` (dispatch labels on, only labelled pull requests: ${unlabeled} carry no label of the set and are not read)`
    : " (dispatch labels on)";
}

/**
 * Each merged pull request with its follow-up markers; a pull request whose
 * comments do not read carries why. The markers a tick kept of a pull
 * request whose `updatedAt` has not moved since are used as they are
 * (`merge-reads.ts`); the rest are read, and kept for the next tick.
 * `kept` counts the pull requests whose kept markers were used. Markers are
 * kept only when `after` says their comments were listed after the merged
 * listing was read: a listing the tick held from an earlier observation of
 * the pull request (the open one, another checkout's turn) may predate an
 * edit that listing's `updatedAt` already shows.
 */
async function withMarkers(
  shared: SharedRecords,
  slug: string,
  merged: MergedPr[],
  nowMs: number,
  login: string | null,
  after: (pr: number) => boolean,
): Promise<{ merged: MarkedPr[]; kept: number }> {
  const kept = readMergeReads(slug);
  const pending = pendingReleases(
    readReleases(
      slug,
      merged.map((p) => p.number),
    ),
  );
  const fresh: FreshMergeRead[] = [];
  const out: MarkedPr[] = [];
  let reused = 0;
  const reuses = merged.map((pr) =>
    pending.has(pr.number)
      ? null
      : keptMarkers(kept.get(pr.number), pr, nowMs, login),
  );
  // The markers to read are asked for at once; the pool bounds how many are in flight.
  const reading = merged.map((pr, i) => {
    if (reuses[i] !== null) return null;
    const read = readMarkers(shared, slug, pr.number);
    // Awaited in order below: one that fails first is not left unhandled meanwhile.
    read.catch(() => undefined);
    return read;
  });
  for (const [i, pr] of merged.entries()) {
    const reuse = reuses[i] ?? null;
    if (reuse !== null) {
      out.push({ ...pr, markers: reuse });
      reused += 1;
      continue;
    }
    const markers = await (reading[i] as ReturnType<typeof readMarkers>);
    out.push({ ...pr, markers });
    if (
      pr.updatedAt !== undefined &&
      !("unreadable" in markers) &&
      after(pr.number)
    )
      fresh.push({ pr: pr.number, updatedAt: pr.updatedAt, markers });
  }
  writeMergeReads(
    slug,
    fresh,
    merged.map((p) => p.number),
    nowMs,
    login,
  );
  return { merged: out, kept: reused };
}

/** The pull requests whose stale-claim release is still pending: their completion needs a fresh listing. */
function pendingReleases(
  releases: ReadonlyMap<number, { releasedAt: string | null }>,
): Set<number> {
  return new Set(
    [...releases].filter(([, r]) => r.releasedAt === null).map(([pr]) => pr),
  );
}
