/**
 * What the forge's answers show through `gh`: the repository's name and
 * default branch, the recent merged pull requests and who reviewed them, the
 * review bots among those reviewers, and the open pull requests stacked on
 * one another.
 */
import type { Fact } from "./fact.ts";
import { ghJson } from "./read.ts";

/** A merged pull request as the forge lists it. */
export interface Pull {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  statusCheckRollup?: {
    name?: string;
    context?: string;
    conclusion?: string;
  }[];
  reviews?: { author?: { login?: string } }[];
  comments?: { author?: { login?: string } }[];
}

const RECENT = 20;
const AUTOMATION =
  /^(dependabot|renovate|github-actions|codecov|netlify|vercel)/i;

/** A login as the review skills compare it: without `[bot]`, lower case. */
export const normalLogin = (login: string) =>
  login.replace(/\[bot\]$/, "").toLowerCase();

/** The repository as the forge describes it. */
export interface ForgeRepo {
  nameWithOwner: string;
  defaultBranchRef?: { name?: string };
  deleteBranchOnMerge?: boolean;
}

/** The forge's description of the repository at `root`, or why it gave none. */
export async function forgeRepo(
  root: string,
): Promise<{ ok: true; value: ForgeRepo } | { ok: false; reason: string }> {
  const view = await ghJson(
    [
      "repo",
      "view",
      "--json",
      "nameWithOwner,defaultBranchRef,deleteBranchOnMerge",
    ],
    root,
  );
  return view.ok ? { ok: true, value: view.value as ForgeRepo } : view;
}

/** `review.repo_slug`: the repository the forge names. */
export function repoSlug(repo: ForgeRepo): Fact & { value: string } {
  const slug = repo.nameWithOwner;
  return {
    field: "review.repo_slug",
    value: slug,
    evidence: [`the forge names this repository ${slug}`],
  };
}

/** The last merged pull requests into `base`, or null when unreadable. */
export async function mergedPulls(
  base: string,
  root: string,
): Promise<Pull[] | null> {
  const merged = await ghJson(
    [
      "pr",
      "list",
      "--state",
      "merged",
      "--base",
      base,
      "--limit",
      String(RECENT),
      "--json",
      "number,title,headRefName,baseRefName,statusCheckRollup,reviews,comments",
    ],
    root,
  );
  return merged.ok && Array.isArray(merged.value)
    ? (merged.value as Pull[])
    : null;
}

/** How many of the pull requests each login reviewed or commented on. */
export function reviewerCounts(pulls: Pull[]): Map<string, number> {
  const authors = new Map<string, number>();
  for (const p of pulls) {
    const seen = new Set(
      [...(p.reviews ?? []), ...(p.comments ?? [])]
        .map((r) => r.author?.login)
        .filter((l): l is string => typeof l === "string")
        .map(normalLogin),
    );
    for (const login of seen) authors.set(login, (authors.get(login) ?? 0) + 1);
  }
  return authors;
}

/** Whether a login looks like a review bot that reviewed often enough to list. */
function likelyReviewBot(login: string, count: number): boolean {
  return (
    /(bot|review|ai)$|^ai[-_]|review/i.test(login) &&
    !AUTOMATION.test(login) &&
    count >= 2
  );
}

/**
 * The login the review skills match for `login`: the forge's GraphQL drops a
 * bot's `[bot]` suffix, and the skills match `review.bots` against the REST
 * login, which carries it. The suffix is added only when the forge confirms
 * the account is a bot, and the login stays as it is only when the forge says
 * there is no such bot; any other answer leaves it unknown (`null`).
 */
async function restLogin(login: string, root: string): Promise<string | null> {
  const user = await ghJson(["api", `users/${login}[bot]`], root);
  if (!user.ok) return /\bHTTP 404\b/.test(user.reason) ? login : null;
  const type =
    typeof user.value === "object" && user.value !== null
      ? (user.value as { type?: unknown }).type
      : undefined;
  return type === "Bot" ? `${login}[bot]` : null;
}

/**
 * The review bots among the merged pull requests' reviewers: a login named
 * like a review bot, not a dependency or deployment bot, that reviewed or
 * commented on at least 2 of them. Each found one is a `review.bots` entry
 * under the login the review skills match; one whose login the forge could
 * not confirm is `unconfirmed`, with the same evidence and no value.
 */
export async function reviewBots(
  pulls: Pull[],
  root: string,
): Promise<{
  found: (Fact & { login: string })[];
  unconfirmed: { login: string; evidence: string }[];
}> {
  const found: (Fact & { login: string })[] = [];
  const unconfirmed: { login: string; evidence: string }[] = [];
  for (const [login, count] of reviewerCounts(pulls)) {
    if (!likelyReviewBot(login, count)) continue;
    const evidence = `${login} reviewed ${count} of the last ${pulls.length} merged pull requests`;
    const rest = await restLogin(login, root);
    if (rest === null) unconfirmed.push({ login, evidence });
    else
      found.push({
        field: "review.bots",
        login,
        value: [rest],
        evidence: [evidence],
      });
  }
  return { found, unconfirmed };
}

/** An open pull request's number, the branch it targets and its own branch. */
export interface OpenPull {
  number: number;
  baseRefName: string;
  headRefName: string;
}

/** How many open pull requests the stacking reading reads. */
export const OPEN_PULL_LIMIT = 200;

/** The open pull requests, or null when unreadable. */
export async function openPulls(root: string): Promise<OpenPull[] | null> {
  const open = await ghJson(
    [
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      String(OPEN_PULL_LIMIT),
      "--json",
      "number,baseRefName,headRefName",
    ],
    root,
  );
  return open.ok && Array.isArray(open.value)
    ? (open.value as OpenPull[])
    : null;
}

/**
 * The open pull requests stacked on another: based on another open pull
 * request's branch rather than `base`. A pull request into a release or
 * backport branch targets another branch than the base too, but no open
 * pull request has that branch as its own. `unresolved` are the ones based
 * on a branch none of the read pull requests has, when a full page was
 * read: the parent may be among those left out, so they may be stacked all
 * the same.
 */
export function stackedPulls(
  pulls: OpenPull[],
  base: string,
): { stacked: OpenPull[]; unresolved: OpenPull[] } {
  const heads = new Set(pulls.map((p) => p.headRefName));
  const stacked = pulls.filter(
    (p) => p.baseRefName !== base && heads.has(p.baseRefName),
  );
  const unresolved =
    pulls.length >= OPEN_PULL_LIMIT
      ? pulls.filter((p) => p.baseRefName !== base && !heads.has(p.baseRefName))
      : [];
  return { stacked, unresolved };
}

/**
 * `pull_requests.stacking` for open pull requests stacked on another:
 * `branch`, since they are base-branch chaining, which is what `branch`
 * declares. Whether they also form a GitHub stack, which `native` declares,
 * the open pull requests do not show, so the evidence says so.
 */
export function stacking(
  base: string,
  stacked: OpenPull[],
): Fact & { value: string } {
  const examples = stacked
    .slice(0, 5)
    .map((p) => `#${p.number} → ${p.baseRefName}`)
    .join(", ");
  return {
    field: "pull_requests.stacking",
    value: "branch",
    evidence: [
      `${stacked.length} open pull request(s) are based on another open pull request's branch, not ${base} (${examples}): base-branch chaining; native instead if they are linked as a GitHub stack`,
    ],
  };
}
