/**
 * The `linked` scenario: the merge scenario with the work each row is linked
 * to and each repository's tracker, as a tick that reads them writes them. It
 * holds every case the cards tell apart: a pull request with two linked items,
 * one with three (two on the face, then "+1 more"), an item linked to a pull
 * request, a row whose links came back empty, and one whose links the tick
 * could not tell. The repositories name Linear, Jira and GitHub Issues, one
 * whose tracker setting does not read and one the line says nothing of.
 *
 * Its record text never uses the word "tracker", so any the page shows is the
 * page's own words.
 */
import type {
  LineLinks,
  LineSnapshot,
} from "../plugin/dispatch/lib/dashboard-contract.ts";
import type { LogRow } from "../plugin/dispatch/lib/log.ts";
import { API, INF, MOB, prUrl, WEB } from "./fixture-rows.ts";

/** Where each repository's items live in this scenario. */
const ITEM_BASE: Record<string, string> = {
  [WEB]: "https://linear.example/acme/issue/",
  [API]: "https://jira.example/browse/",
};

function item(repo: string, key: string, linked = true): LineLinks["items"][0] {
  return { key, url: linked ? `${ITEM_BASE[repo] ?? ""}${key}` : null };
}

function pr(repo: string, number: number): LineLinks["prs"][0] {
  return { number, url: prUrl(repo, number) };
}

const NONE: LineLinks = { items: [], prs: [] };

/** Each row's links by `<repo> <target>`; a row not named keeps none, as a tick that could not tell. */
const LINKS: Record<string, LineLinks> = {
  [`${WEB} PR #456`]: {
    items: [item(WEB, "WEB-401"), item(WEB, "WEB-405", false)],
    prs: [],
  },
  [`${API} PR #1210`]: {
    items: [item(API, "API-50"), item(API, "API-51"), item(API, "API-52")],
    prs: [],
  },
  [`${WEB} PR #475`]: NONE,
  [`${API} API-77`]: { items: [], prs: [pr(API, 1207)] },
  [`${API} PR #1207`]: { items: [item(API, "API-77")], prs: [] },
  [`${WEB} PR #468`]: NONE,
  [`${WEB} WEB-412`]: { items: [], prs: [pr(WEB, 480)] },
  [`${WEB} PR #480`]: { items: [item(WEB, "WEB-412")], prs: [] },
  [`${WEB} PR #461`]: { items: [item(WEB, "WEB-399")], prs: [] },
  [`${API} PR #1201`]: NONE,
};

const TRACKERS: Record<string, { adapter: string } | null> = {
  [WEB]: { adapter: "linear" },
  [API]: { adapter: "jira" },
  [INF]: { adapter: "github" },
  [MOB]: null,
};

/** Every string of a value with the word rewritten, so the record text holds none. */
function withoutWord<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll("tracker.example", "issues.example")
      .replaceAll("Tracker", "Issues")
      .replaceAll("tracker", "issues"),
  );
}

function linksOf<T extends { repo: string; target: string }>(row: T): T {
  const links = LINKS[`${row.repo} ${row.target}`];
  return links === undefined ? row : { ...row, links };
}

export function linkedLine(base: LineSnapshot): LineSnapshot {
  const line = withoutWord(base);
  return {
    ...line,
    sessions: line.sessions.map(linksOf),
    needs: line.needs.map(linksOf),
    queue: line.queue.map(linksOf),
    ready: (line.ready ?? []).map((r) => {
      const links = LINKS[`${r.repo} PR #${r.pr}`];
      return links === undefined ? r : { ...r, links };
    }),
    repos: line.repos.map((r) => {
      const slug = r.slug ?? "";
      return Object.hasOwn(TRACKERS, slug)
        ? { ...r, tracker: TRACKERS[slug] ?? null }
        : r;
    }),
  };
}

export function linkedRows(rows: LogRow[]): LogRow[] {
  return withoutWord(rows);
}
