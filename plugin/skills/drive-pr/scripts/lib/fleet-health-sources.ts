/**
 * The fleet-health sensor's I/O: what it reads off GitHub and the issue
 * tracker, and how it classifies a PR's files with the change-area catalog.
 *
 * Kept apart from `lib/fleet-health.ts` so the core stays pure and pinnable
 * against fixtures. Everything here is a thin, defensive read that either
 * returns what it was asked for or throws with a reason the caller records as a
 * GAP — never a shorter population presented as complete.
 *
 * The tracker is reached through do-item's tracker port (the adapter the
 * consumer names in `issue_tracker.adapter`); the change-area catalog is the
 * consumer's file (`drive.change_areas_catalog`), read directly.
 */

import {
  type DeliveryFact,
  type EpicActivityFact,
  type IssueFact,
  parseIssueRefs,
  type WindowSpec,
} from "./fleet-health.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openTracker } from "../../../do-item/scripts/lib/tracker/index.ts";
import { parseTrackerConfig } from "../../../do-item/scripts/lib/tracker/config.ts";
import type {
  IssueComments,
  Tracker,
} from "../../../do-item/scripts/lib/tracker/port.ts";
import {
  consumerRoot,
  OVERLAY_RELPATH,
} from "../../../resolve-review-comments/scripts/lib/consumer.ts";
import { load as loadYaml } from "../../../resolve-review-comments/scripts/lib/yaml.ts";
import type { FleetHealthConfig } from "./fleet-health-config.ts";
import { ghCall as realGhCall } from "./proc.ts";

/** The `gh` chokepoint; injectable so the paging and budget logic are testable without a network. */
export type Gh = typeof realGhCall;

import type { Repo } from "./sample.ts";

// ── GitHub ─────────────────────────────────────────────────────────────────

export interface PrListing {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  /** Last activity of any kind; a listing is ordered by it. */
  updatedAt: string;
}

function parseRestPr(raw: unknown, i: number): PrListing {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (
    typeof p.number !== "number" ||
    !Number.isInteger(p.number) ||
    p.number < 1
  ) {
    throw new Error(`pulls[${i}]: no usable PR number`);
  }
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const at = `pulls[${i}] (#${p.number})`;
  // GitHub sends `body: null` for an empty description; an ABSENT property or
  // any other non-string is a malformed row, never an empty description.
  if (p.body !== null && typeof p.body !== "string") {
    throw new Error(`${at}: body is not a string`);
  }
  const parses = (v: unknown): v is string =>
    typeof v === "string" && Number.isFinite(Date.parse(v));
  // `keep` and the window filters compare these as instants: an unparseable
  // value would be dropped or misordered with no gap recorded.
  if (!parses(p.created_at) || !parses(p.updated_at)) {
    throw new Error(`${at}: created_at/updated_at is not a timestamp`);
  }
  // `merged_at`/`closed_at` are null until the event happens; REST always sends
  // the key, so it must be an explicit timestamp or `null` — an ABSENT key is a
  // malformed row, never coerced to null (that turns a merged PR into an
  // unmerged one and overstates the ceremony ratio).
  for (const field of ["merged_at", "closed_at"] as const) {
    const v = p[field];
    if (v !== null && !parses(v)) {
      throw new Error(`${at}: ${field} is not a timestamp`);
    }
  }
  // Only the two states REST defines; anything else is unreadable, not CLOSED.
  if (p.state !== "open" && p.state !== "closed") {
    throw new Error(`${at}: state is not open/closed`);
  }
  const mergedAt = str(p.merged_at) || null;
  const closedAt = str(p.closed_at) || null;
  return {
    number: p.number,
    title: str(p.title),
    body: str(p.body),
    state:
      mergedAt !== null ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED",
    createdAt: p.created_at,
    mergedAt,
    closedAt,
    updatedAt: p.updated_at,
  };
}

export interface Candidates {
  prs: PrListing[];
  /** True when a listing hit its cap, so the oldest PRs were not read. */
  capped: boolean;
}

/** Pages of 100 read before a listing gives up and reports itself capped. */
const MAX_LIST_PAGES = 25;

/**
 * The PRs that could have activity in the window: every PR that existed during
 * it — created before it ended and not closed before it began — read from the
 * REST pulls list ordered by last update, newest first, until the listing falls
 * behind the window.
 *
 * REST rather than `gh pr list --search`, for two measured reasons. GitHub's
 * `closed:` search qualifier was measured not to return a closed-unmerged PR
 * that an `is:pr created:` search does find, so a
 * search-driven listing silently drops exactly the PRs a review carousel that
 * never landed is made of. And a search listing is GraphQL, the budget every
 * agent on this token shares and the sampler needs; REST pulls draw on a
 * separate, larger one.
 *
 * A historical window sees the PRs that existed during it and are still within
 * the page cap of the update-ordered list; one updated only long after the
 * window may sit further down than the cap reaches. The caller says so when
 * `until` is in the past.
 */
export async function listCandidatePrs(
  repo: Repo,
  win: WindowSpec,
  limit: number,
  ghCall: Gh = realGhCall,
): Promise<Candidates> {
  const sinceIso = new Date(win.sinceMs).toISOString();
  const untilIso = new Date(win.untilMs).toISOString();
  // Keyed by number: the list is paged by position while it is being written to,
  // so a PR created or updated mid-walk shifts every later row down by one and
  // the last row of one page reappears as the first of the next. A duplicate here
  // would double-charge a PR's review rounds to its epic.
  const byNumber = new Map<number, PrListing>();
  let capped = false;
  const readPage = async (page: number): Promise<PrListing[]> => {
    const r = await ghCall(
      [
        "api",
        `repos/${repo.owner}/${repo.name}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
      ],
      { stderr: "ignore" },
    );
    if (r.code !== 0) {
      throw new Error(
        `the REST pulls listing failed on page ${page} (exit ${r.code})`,
      );
    }
    let rows: unknown;
    try {
      rows = JSON.parse(r.stdout);
    } catch {
      throw new Error(
        `the REST pulls listing returned unparsable JSON on page ${page}`,
      );
    }
    if (!Array.isArray(rows)) {
      throw new Error(`the REST pulls listing page ${page} is not an array`);
    }
    return rows.map((row, i) => parseRestPr(row, i));
  };
  const keep = (p: PrListing): boolean =>
    p.createdAt < untilIso &&
    // Existed during the window: closed inside or after it, or still open and
    // touched since it began (an old idle open PR is not activity).
    (p.closedAt === null ? p.updatedAt >= sinceIso : p.closedAt >= sinceIso);
  for (let page = 1; ; page++) {
    if (page > MAX_LIST_PAGES) {
      capped = true;
      break;
    }
    const listed = await readPage(page);
    if (listed.length === 0) break;
    for (const p of listed) if (keep(p)) byNumber.set(p.number, p);
    // Ordered by update time, so the first page ending behind the window ends the walk.
    const oldest = listed[listed.length - 1];
    if (
      listed.length < 100 ||
      (oldest !== undefined && oldest.updatedAt < sinceIso)
    )
      break;
  }
  // Anything updated while the walk was running has moved to the front of the
  // list, behind the page already read: read page 1 again and add what is new.
  // A PR already seen may have been edited or merged meanwhile: the fresher read
  // replaces the retained row.
  for (const p of await readPage(1)) {
    if (!keep(p)) continue;
    const seen = byNumber.get(p.number);
    if (seen === undefined || p.updatedAt > seen.updatedAt)
      byNumber.set(p.number, p);
  }
  // Newest-updated first, like the listing itself: a PR the final reread pulled
  // in sits at the FRONT, so trimming to `limit` must drop the stale tail, not
  // the entries appended last.
  const prs = [...byNumber.values()].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );
  if (prs.length > limit) capped = true;
  return { prs: prs.slice(0, limit), capped };
}

/**
 * Distinct commits any review was submitted against — a cheap, over-inclusive
 * stand-in for "how many rounds could this PR have", so the expensive GraphQL
 * sample is only spent where it can matter. REST, one call per PR; `null` when
 * unreadable (the caller then samples to be safe).
 */
export async function fetchReviewedHeads(
  repo: Repo,
  pr: number,
  ghCall: Gh = realGhCall,
): Promise<number | null> {
  const r = await ghCall(
    [
      "api",
      `repos/${repo.owner}/${repo.name}/pulls/${pr}/reviews?per_page=100`,
      "--paginate",
      "--jq",
      ".[].commit_id",
    ],
    { stderr: "ignore" },
  );
  if (r.code !== 0) return null;
  return new Set(r.stdout.split("\n").filter((l) => l !== "")).size;
}

export interface GraphqlBudget {
  remaining: number;
  /** ISO instant the window resets, or a description when GitHub gave none. */
  resetAt: string;
}

/**
 * GitHub's hourly GraphQL budget is shared by every tool and agent on this
 * token, and a sampling run is the single heaviest consumer of it. Read before
 * starting so a run that cannot finish refuses instead of starving everyone
 * else's `gh` calls.
 *
 * Asked of GraphQL ITSELF (`rateLimit { remaining resetAt }`, one point), not of
 * `gh api rate_limit`: measured on this token, the REST endpoint reported 4931
 * remaining while every GraphQL call was refusing with `RATE_LIMIT` and the
 * response header read 0. A budget is only worth gating on when it is read from
 * the resource it describes. An exhausted budget may answer with a `RATE_LIMIT`
 * error rather than a number, which is read as 0 remaining. `null` when the
 * probe cannot be read at all (the caller proceeds and the run's own failures
 * are reported as gaps).
 */
export async function graphqlBudget(
  ghCall: Gh = realGhCall,
): Promise<GraphqlBudget | null> {
  const r = await ghCall(
    ["api", "graphql", "-f", "query={ rateLimit { remaining resetAt } }"],
    { stderr: "ignore" },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const errors = parsed.errors;
  if (
    Array.isArray(errors) &&
    errors.some((e) => isRecord(e) && e.type === "RATE_LIMIT")
  ) {
    return { remaining: 0, resetAt: "the next hourly reset" };
  }
  const limit = isRecord(parsed.data) ? parsed.data.rateLimit : null;
  if (!isRecord(limit) || typeof limit.remaining !== "number") return null;
  return {
    remaining: limit.remaining,
    resetAt:
      typeof limit.resetAt === "string"
        ? limit.resetAt
        : "the next hourly reset",
  };
}

/** The body of any PR, for walking a follow-up chain back past the window. */
export async function fetchPrBody(
  repo: Repo,
  pr: number,
  ghCall: Gh = realGhCall,
): Promise<string | null> {
  // `--repo` is explicit, like every sibling reader here: without it `gh` picks
  // a repository from the working directory's remotes, which need not be the
  // one `resolveRepo()` chose (a fork checkout, or a cwd outside the clone).
  const r = await ghCall(
    [
      "pr",
      "view",
      String(pr),
      "--repo",
      `${repo.owner}/${repo.name}`,
      "--json",
      "body",
    ],
    { stderr: "ignore" },
  );
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as { body?: unknown } | null;
    if (parsed === null || typeof parsed !== "object") return null;
    // null is an empty description; a missing or non-string body is unreadable.
    if (parsed.body === null) return "";
    return typeof parsed.body === "string" ? parsed.body : null;
  } catch {
    return null;
  }
}

export interface PrFileStat {
  path: string;
  additions: number;
  deletions: number;
}

/** GitHub lists at most this many files per PR; a PR at the cap is truncated. */
export const GITHUB_FILE_CAP = 3000;

export async function fetchPrFiles(
  repo: Repo,
  pr: number,
  ghCall: Gh = realGhCall,
): Promise<PrFileStat[]> {
  const r = await ghCall(
    [
      "api",
      `repos/${repo.owner}/${repo.name}/pulls/${pr}/files?per_page=100`,
      "--paginate",
      "--jq",
      ".[] | [.filename, .additions, .deletions] | @tsv",
    ],
    { stderr: "ignore" },
  );
  if (r.code !== 0)
    throw new Error(`could not list the files of PR #${pr} (exit ${r.code})`);
  const out: PrFileStat[] = [];
  for (const line of r.stdout.split("\n")) {
    if (line === "") continue;
    const [path, a, d] = line.split("\t");
    // `Number('')` is 0, so an empty field must be refused by shape, not by value.
    const additions =
      a !== undefined && /^\d+$/.test(a) ? Number(a) : Number.NaN;
    const deletions =
      d !== undefined && /^\d+$/.test(d) ? Number(d) : Number.NaN;
    if (
      path === undefined ||
      path === "" ||
      !Number.isInteger(additions) ||
      !Number.isInteger(deletions)
    ) {
      throw new Error(`PR #${pr}: unreadable file row ${JSON.stringify(line)}`);
    }
    out.push({ path, additions, deletions });
  }
  // GitHub stops listing a PR's files at this many, silently. A PR at the cap
  // is a prefix, and the largest PRs are exactly the ones that move the
  // delivery-system share — so it is a failure (reported as a gap), not a figure.
  if (out.length >= GITHUB_FILE_CAP) {
    throw new Error(
      `PR #${pr} lists ${out.length} files, GitHub's listing limit, so the list is truncated`,
    );
  }
  return out;
}

// ── The change-area catalog ────────────────────────────────────────────────

export interface Classifier {
  /**
   * Does the merged diff touch a product area, and how do its lines split
   * between the delivery system and everything else?
   */
  classify(files: ReadonlyArray<PrFileStat>): {
    productPr: boolean;
    deliveryLines: number;
    totalLines: number;
    unclaimedSkillLines: number;
  };
}

/**
 * The part of a change-area catalog the sensor reads. The catalog is the
 * consumer's (`drive.change_areas_catalog`); this is the minimal schema:
 *
 *   areas:
 *     <area key>:
 *       paths: ["src/api/**"]          # globs that define membership
 *       generated: [{ source: [...] }] # optional: generator sources, also members
 *       labels: [delivery]             # optional: the area's tracker labels
 *                                      # (`linear: { labels: [...] }` is read too)
 */
export interface CatalogArea {
  globs: string[];
  labels: string[];
}

function stringList(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
    throw new Error(`${where}: expected a list of strings`);
  return v as string[];
}

/** Validate a parsed catalog into its areas. */
export function parseCatalog(raw: unknown): Map<string, CatalogArea> {
  if (!isRecord(raw) || !isRecord(raw.areas))
    throw new Error("the change-area catalog has no `areas` mapping");
  const out = new Map<string, CatalogArea>();
  for (const [key, area] of Object.entries(raw.areas)) {
    if (!isRecord(area)) throw new Error(`catalog area ${key}: not a mapping`);
    const generated = area.generated ?? [];
    if (!Array.isArray(generated))
      throw new Error(`catalog area ${key}.generated: expected a list`);
    const globs = [
      ...stringList(area.paths, `catalog area ${key}.paths`),
      ...generated.flatMap((g, i) =>
        stringList(
          isRecord(g) ? g.source : undefined,
          `catalog area ${key}.generated[${i}].source`,
        ),
      ),
    ];
    const tracker = isRecord(area.linear) ? area.linear.labels : undefined;
    const labels = [
      ...stringList(area.labels, `catalog area ${key}.labels`),
      ...stringList(tracker, `catalog area ${key}.linear.labels`),
    ];
    out.set(key, { globs, labels });
  }
  return out;
}

const globCache = new Map<string, RegExp>();

/**
 * A path glob as a regular expression: `**` spans directories, `*` and `?`
 * stay within one segment, `{a,b}` alternates and `[...]` is a character
 * class. Dotfiles match like any other name (the catalog lists paths such as
 * `.github/**`).
 */
export function globToRegExp(glob: string): RegExp {
  const hit = globCache.get(glob);
  if (hit !== undefined) return hit;
  let re = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        const slashAfter = glob.charAt(i + 2) === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      depth++;
      re += "(?:";
    } else if (c === "}" && depth > 0) {
      depth--;
      re += ")";
    } else if (c === "," && depth > 0) re += "|";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) re += "\\[";
      else {
        const body = glob.slice(i + 1, end).replace(/^!/, "^");
        re += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  const compiled = new RegExp(`^${re}$`);
  globCache.set(glob, compiled);
  return compiled;
}

export function matchesGlob(file: string, glob: string): boolean {
  return globToRegExp(glob).test(file);
}

/** The areas whose globs claim `file`. */
export function areasOf(
  file: string,
  catalog: ReadonlyMap<string, CatalogArea>,
): string[] {
  const out: string[] = [];
  for (const [key, area] of catalog)
    if (area.globs.some((g) => matchesGlob(file, g))) out.push(key);
  return out;
}

/** Read the consumer's catalog. Throws with the reason. */
export function loadCatalogFile(path: string): Map<string, CatalogArea> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `the change-area catalog ${path} could not be read (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return parseCatalog(loadYaml(text));
}

/**
 * Build the classifier from the consumer's catalog. A delivery-system area is
 * one whose own labels carry `labels.delivery_system` — the catalog's own
 * statement, not a second list here — and a product area is one
 * `progress.product_areas` names. Throws when the catalog is not configured
 * or cannot be loaded, or when the config names an area the catalog does not
 * have (a rename would otherwise silently shrink progress).
 */
export async function makeClassifier(
  cfg: FleetHealthConfig,
  load: (path: string) => Map<string, CatalogArea> = loadCatalogFile,
): Promise<Classifier> {
  if (cfg.catalogPath === null)
    throw new Error(
      "no change-area catalog is configured (drive.change_areas_catalog in the consumer overlay)",
    );
  const catalog = load(cfg.catalogPath);
  const missing = cfg.progress.productAreas.filter((a) => !catalog.has(a));
  if (missing.length > 0) {
    throw new Error(
      `the fleet-health config names product area(s) the catalog does not have: ${missing.join(", ")}`,
    );
  }
  const product = new Set(cfg.progress.productAreas);
  const deliveryLabel = cfg.labels.deliverySystem;
  const delivery = new Set(
    [...catalog]
      .filter(
        ([, a]) => deliveryLabel !== null && a.labels.includes(deliveryLabel),
      )
      .map(([k]) => k),
  );
  if (deliveryLabel !== null && delivery.size === 0) {
    // A catalog whose labels moved or were renamed would otherwise report a 0%
    // delivery-system share with no gap — which reads as a healthy fleet.
    throw new Error(
      `the change-area catalog names no area with the '${deliveryLabel}' label, so the delivery-system share cannot be derived`,
    );
  }
  return {
    classify(files) {
      let productPr = false;
      let deliveryLines = 0;
      let totalLines = 0;
      let unclaimedSkillLines = 0;
      for (const f of files) {
        const lines = f.additions + f.deletions;
        totalLines += lines;
        let isDelivery = false;
        for (const a of areasOf(f.path, catalog)) {
          if (product.has(a)) productPr = true;
          if (delivery.has(a)) isDelivery = true;
        }
        if (isDelivery) deliveryLines += lines;
        else if (f.path.startsWith(".claude/skills/"))
          unclaimedSkillLines += lines;
      }
      return { productPr, deliveryLines, totalLines, unclaimedSkillLines };
    },
  };
}

export function deliveryFactOf(
  parts: ReadonlyArray<{
    deliveryLines: number;
    totalLines: number;
    unclaimedSkillLines: number;
  }>,
): DeliveryFact {
  return {
    prs: parts.length,
    totalLines: parts.reduce((s, p) => s + p.totalLines, 0),
    deliveryLines: parts.reduce((s, p) => s + p.deliveryLines, 0),
    unclaimedSkillLines: parts.reduce((s, p) => s + p.unclaimedSkillLines, 0),
  };
}

// ── The issue tracker ──────────────────────────────────────────────────────

/** Open the consumer's tracker; throws with a reason. */
export function connectTracker(cfg: FleetHealthConfig): Tracker {
  if (cfg.teamKey === null)
    throw new Error(
      "no issue_tracker.team in the consumer overlay, so issue keys cannot be read",
    );
  const path =
    process.env.JIG_OVERLAY?.trim() ||
    join(cfg.root ?? consumerRoot(), OVERLAY_RELPATH);
  const overlay: unknown = loadYaml(readFileSync(path, "utf8"));
  if (!isRecord(overlay))
    throw new Error(`consumer overlay must be an object: ${path}`);
  return openTracker(parseTrackerConfig(overlay));
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Issues named by key, keyed by key. A key that resolves to nothing is simply absent. */
export async function fetchIssuesByIds(
  tracker: Tracker,
  ids: ReadonlyArray<string>,
): Promise<Map<string, IssueFact>> {
  return tracker.issuesByKeys(ids);
}

export interface WindowIssues {
  followups: IssueFact[];
  sdlcIssues: IssueFact[];
  completed: IssueFact[];
}

/**
 * The tree-side units: follow-ups and delivery-system issues created, and
 * issues completed, in the window. A label the consumer does not configure
 * is not read (its units are reported as not measured by the caller).
 */
export async function fetchWindowIssues(
  tracker: Tracker,
  win: WindowSpec,
  labels: FleetHealthConfig["labels"],
): Promise<WindowIssues> {
  const none = Promise.resolve([] as IssueFact[]);
  const [followups, sdlcIssues, completed] = await Promise.all([
    labels.followup === null
      ? none
      : tracker.issuesInWindow({ label: labels.followup, createdIn: win }),
    labels.deliverySystem === null
      ? none
      : tracker.issuesInWindow({
          label: labels.deliverySystem,
          createdIn: win,
        }),
    tracker.issuesInWindow({ completedIn: win }),
  ]);
  return { followups, sdlcIssues, completed };
}

/** Enumerate every current started epic and every direct child, not just window activity. */
export async function fetchEpicActivity(
  tracker: Tracker,
  epicLabel: string,
  signal?: AbortSignal,
): Promise<EpicActivityFact[]> {
  return tracker.startedIssueActivity(epicLabel, signal);
}

/**
 * The acceptance-verdict marker: an HTML comment on the comment's own last
 * line. The text is forgeable, so only a trusted author's comment counts —
 * a forged ACCEPT would add a progress unit and suppress a ceremony
 * suspicion. The marker must be the comment's LAST line, and a REJECT is a
 * verdict too: an unanchored search would count a comment that merely quotes
 * an earlier verdict, and ignoring REJECT would leave an epic counted as
 * accepted after a later rejection.
 */
const VERDICT_MARKER =
  /^<!--\s*epic-acceptance-verdict:\s*(ACCEPT-WITH-FOLLOWUPS|ACCEPT|REJECT)\s*-->$/;

/**
 * Equal-`createdAt` verdicts resolve the same way whatever order the tracker
 * returns them in, the more restrictive verdict winning.
 */
const VERDICT_TIE_RANK: Readonly<Record<string, number>> = {
  ACCEPT: 0,
  "ACCEPT-WITH-FOLLOWUPS": 1,
  REJECT: 2,
};

/**
 * Epics whose NEWEST verdict comment in the window is an accepting one
 * (ACCEPT or ACCEPT-WITH-FOLLOWUPS).
 */
export async function fetchAcceptedEpics(
  tracker: Tracker,
  win: WindowSpec,
  epicLabel: string,
): Promise<Set<string>> {
  const found = await tracker.commentsContaining({
    text: "epic-acceptance-verdict",
    issueLabel: epicLabel,
    createdIn: win,
  });
  const newest = new Map<string, { verdict: string; at: string }>();
  for (const n of found) {
    if (!n.trusted) continue;
    const lines = n.body.split("\n");
    const m = VERDICT_MARKER.exec((lines[lines.length - 1] ?? "").trim());
    if (m === null) continue;
    const verdict = m[1] as string;
    const prior = newest.get(n.issue);
    if (
      prior === undefined ||
      n.createdAt > prior.at ||
      (n.createdAt === prior.at &&
        (VERDICT_TIE_RANK[verdict] ?? 0) >
          (VERDICT_TIE_RANK[prior.verdict] ?? 0))
    ) {
      newest.set(n.issue, { verdict, at: n.createdAt });
    }
  }
  return new Set(
    [...newest]
      .filter(
        ([, v]) =>
          v.verdict === "ACCEPT" || v.verdict === "ACCEPT-WITH-FOLLOWUPS",
      )
      .map(([epic]) => epic),
  );
}

export type EpicComments = IssueComments;

/** Every comment on one epic (read to the end), and its tracker id for posting. */
export async function fetchEpicComments(
  tracker: Tracker,
  epic: string,
): Promise<EpicComments> {
  return tracker.issueComments(epic);
}

/** Issue keys named by a PR body (re-exported so callers need one import for attribution). */
export { parseIssueRefs };
