/**
 * The `linked` scenario: the merge scenario with the work each row is linked
 * to and each repository's tracker, as a tick that reads them writes them. It
 * holds every case the cards tell apart: a pull request with two linked items,
 * one with three (two on the face, then "+1 more"), an item linked to a pull
 * request, a row whose links came back empty, and one whose links the tick
 * could not tell. The repositories name Linear, Jira and GitHub Issues, one
 * whose tracker setting does not read and one the line says nothing of, and
 * a need of the whole host, whose target is an account rather than work.
 *
 * Its record text is the dispatcher's own, so the page's word check reads
 * what the dispatcher writes.
 */
import type {
  LineLinks,
  LineSnapshot,
} from "../plugin/dispatch/lib/dashboard-contract.ts";
import { need } from "./fixture-line.ts";
import { API, INF, MOB, prUrl, T, WEB } from "./fixture-rows.ts";

/** A need of the host's, as the preflight writes one for an account that cannot reach a repository's issues. */
const HOST_NEED = need({
  cause: "tracker-unreachable",
  stage: "followup",
  repo: "host",
  item: "account a",
  title: "",
  since: T(8, 20),
  reason: `account a cannot reach the issues of ${WEB}, so its followup launches there are held: the keychain is waiting for an approval`,
});

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

function linksOf<T extends { repo: string; target: string }>(row: T): T {
  const links = LINKS[`${row.repo} ${row.target}`];
  return links === undefined ? row : { ...row, links };
}

export function linkedLine(base: LineSnapshot): LineSnapshot {
  return {
    ...base,
    sessions: base.sessions.map(linksOf),
    needs: [...base.needs.map(linksOf), HOST_NEED],
    queue: base.queue.map(linksOf),
    ready: (base.ready ?? []).map((r) => {
      const links = LINKS[`${r.repo} PR #${r.pr}`];
      return links === undefined ? r : { ...r, links };
    }),
    repos: base.repos.map((r) => {
      const slug = r.slug ?? "";
      return Object.hasOwn(TRACKERS, slug)
        ? { ...r, tracker: TRACKERS[slug] ?? null }
        : r;
    }),
  };
}
