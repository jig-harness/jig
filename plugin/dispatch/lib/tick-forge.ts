/**
 * The forge's part of a repository's tick: the open pull requests (with
 * their labels where the repository turns dispatch labels on, in the same
 * listing) and their ledgers, and the merges with their follow-up markers,
 * read through the shared records (`shared/records/shared.ts`). Under
 * `only_labeled`, a pull request that carries no label of the set is never
 * read for a ledger, and a merge that carries none wants no follow-up; the
 * scope itself is decided once, by `decideScope`.
 */
import type { SharedRecords } from "../../shared/records/shared.ts";
import { resolveLogin } from "../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { adoptionNote, adoptionOf } from "./adopt.ts";
import { readMarkers } from "./followup-marker.ts";
import { mergedSince, openPullRequests } from "./forge.ts";
import { carriesSet, type LabelConfig } from "./labels.ts";
import { readDrives } from "./sources/ledgers.ts";
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
  open: Awaited<ReturnType<typeof openPullRequests>>;
  /** The open pull requests read for a ledger: under `only_labeled`, the labelled ones. */
  read: Set<number>;
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

/** The forge's part of a repository's tick; `shared` opens the shared records as the login the forge names. */
export async function readForge(
  repo: RepoTarget,
  report: RepoReport,
  section: DispatchSection,
  labels: LabelConfig | null,
  nowMs: number,
  shared: (login: string | null) => SharedRecords,
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
  try {
    out.open = await openPullRequests(repo.slug, read);
    remember(out.open);
    out.login = await resolveLogin();
    const toRead = managed(out.open);
    const unlabeled = out.open.length - toRead.length;
    const adoption = adoptionOf(section, out.login);
    out.drives = await readDrives(
      repo.slug,
      out.login,
      toRead,
      nowMs,
      labels,
      adoption,
    );
    const since = report.followupSince as string;
    out.read = new Set(toRead.map((p) => p.number));
    const listed =
      section.followupCommand === null
        ? []
        : await mergedSince(repo.slug, since, read);
    remember(listed);
    out.merged = await withMarkers(
      shared(out.login),
      repo.slug,
      managed(listed),
    );
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
          : `${out.merged.length} merged since ${since}`
      }`,
    });
  } catch (error) {
    report.records.push({
      record: "forge",
      source: `gh ${repo.slug}`,
      ok: false,
      detail: `the pull requests cannot be read: ${failureText(error)}`,
    });
    out.drives = [];
    out.merged = [];
    out.inScope = new Set();
    out.disputed = new Set();
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

/** Each merged pull request with its follow-up markers; a pull request whose comments do not read carries why. */
async function withMarkers(
  shared: SharedRecords,
  slug: string,
  merged: MergedPr[],
): Promise<MarkedPr[]> {
  const out: MarkedPr[] = [];
  for (const pr of merged)
    out.push({ ...pr, markers: await readMarkers(shared, slug, pr.number) });
  return out;
}
