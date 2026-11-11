/**
 * The forge reads a tick makes for one repository, through the signed-in
 * `gh` command-line client and under its deadline: which repository a
 * checkout is, the repository's `.config/jig.yaml` and change-area catalog
 * on its default branch, its open pull requests (each with its head commit,
 * its base branch, its mergeability with that base and whether a check on its
 * head fails, read with it) and the
 * files each one changes, the head of a base branch, the pull requests merged
 * since a date, and, for Control and
 * serialization, a pull request's unresolved review threads and whether a
 * closed one merged. Where the repository turns dispatch labels on, each listing
 * and view carries the pull requests' labels and descriptions too, and a pull request's
 * labels are changed with one `gh pr edit` call; with them off, no label
 * is used or written. A tick reads most of this for each repository in one
 * query (`forge-batch.ts`): which repository the checkout is, its
 * configuration file and its open pull requests with their labels, which
 * are dropped when the repository's section turns the labels off
 * (`listedOpen`). When that query does not read in full, the tick makes the
 * same reads one by one here.
 *
 * Each read and write returns an outcome (`shared/outcome.ts`), so a
 * population read in part is never planned from. Its failure's code says
 * which:
 *
 * - `unreadable`: a read failed, came back in a form that does not read,
 *   or holds more than one read can, so it would be a read in part.
 * - `not-open`: a pull request read again before a launch is no longer open.
 * - `not-closed`: a pull request asked whether it merged has neither merged
 *   nor closed.
 * - `refused`: the forge refused a write (a label that does not exist, no
 *   permission).
 */
import { isRecord } from "../../shared/guards.ts";
import { ghCall, ghRepoEnv } from "../../skills/drive-pr/scripts/lib/proc.ts";
import { OVERLAY_RELPATH } from "../../shared/config-layers.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { checksFail } from "./automation.ts";
import type { MergedPr, RepoTarget } from "./types.ts";

/** The most pull requests one listing reads; a full page means a partial read. */
const PR_LIMIT = 1000;

/** A failed read: the forge's answer did not read. */
function unreadable(reason: string): Outcome<never, "unreadable"> {
  return failed("unreadable", reason);
}

/** What `gh` printed, or why it did not answer under `code`. */
async function gh<Code extends string>(
  args: string[],
  code: Code,
  cwd?: string,
  timeoutSec?: number,
): Promise<Outcome<string, Code>> {
  const r = await ghCall(args, {
    stderr: "pipe",
    env: ghRepoEnv(),
    ...(cwd === undefined ? {} : { cwd }),
    ...(timeoutSec === undefined ? {} : { timeoutSec }),
  });
  if (r.code === 0) return ok(r.stdout);
  const tail = r.stderr.trim().split("\n").at(-1) ?? "";
  return failed(
    code,
    `gh ${args.slice(0, 2).join(" ")} exited ${r.code}${tail === "" ? "" : `: ${tail}`}`,
  );
}

function parsed(text: string, what: string): Outcome<unknown, "unreadable"> {
  try {
    return ok(JSON.parse(text));
  } catch (error) {
    return failed("unreadable", `${what} is not JSON`, error);
  }
}

/** What a `gh` read answered, parsed as JSON; `what` names it in the failure. */
async function ghJson(
  args: string[],
  what: string,
  cwd?: string,
  timeoutSec?: number,
): Promise<Outcome<unknown, "unreadable">> {
  const text = await gh(args, "unreadable", cwd, timeoutSec);
  return text.ok ? parsed(text.value, what) : text;
}

/** The forge repository a checkout belongs to, or the one `slug` names, and its default branch. */
export async function repoTarget(
  path: string,
  slug?: string,
): Promise<Outcome<RepoTarget, "unreadable">> {
  const read = await ghJson(
    [
      "repo",
      "view",
      ...(slug === undefined ? [] : [slug]),
      "--json",
      "nameWithOwner,defaultBranchRef",
    ],
    "the repository view",
    path,
  );
  if (!read.ok) return read;
  const out = read.value;
  const named = isRecord(out) ? out.nameWithOwner : undefined;
  const branch =
    isRecord(out) && isRecord(out.defaultBranchRef)
      ? out.defaultBranchRef.name
      : undefined;
  if (typeof named !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(named))
    return unreadable("the repository view names no owner/name");
  if (typeof branch !== "string" || branch === "")
    return unreadable(`${named} reports no default branch`);
  return ok({ path, slug: named, defaultBranch: branch });
}

/**
 * The repository's configuration file as its default branch holds it on
 * the forge, never a checkout's copy; `null` when the branch has none.
 */
export async function defaultBranchConfig(
  repo: RepoTarget,
): Promise<Outcome<string | null, "unreadable">> {
  return defaultBranchFile(repo, OVERLAY_RELPATH);
}

/**
 * One file as the repository's default branch holds it on the forge, by
 * its repository-relative path; `null` when the branch has no such file.
 */
export async function defaultBranchFile(
  repo: RepoTarget,
  path: string,
): Promise<Outcome<string | null, "unreadable">> {
  const where = `${path} on ${repo.slug}@${repo.defaultBranch}`;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const r = await ghCall(
    [
      "api",
      `repos/${repo.slug}/contents/${encoded}?ref=${encodeURIComponent(repo.defaultBranch)}`,
    ],
    { stderr: "pipe", env: ghRepoEnv() },
  );
  if (r.code !== 0) {
    if (/HTTP 404/.test(r.stderr)) return ok(null);
    const tail = r.stderr.trim().split("\n").at(-1) ?? "";
    return unreadable(
      `${where} could not be read (gh exited ${r.code}${tail === "" ? "" : `: ${tail}`})`,
    );
  }
  const read = parsed(r.stdout, "the contents answer");
  if (!read.ok) return read;
  const file = read.value;
  if (
    !isRecord(file) ||
    file.encoding !== "base64" ||
    typeof file.content !== "string"
  )
    return unreadable(`${where} came back without base64 content`);
  return ok(Buffer.from(file.content, "base64").toString("utf8"));
}

/** The files one page of a pull request's file listing holds. */
const FILES_PAGE = 100;

/** The most files the forge lists for one pull request: a listing that reaches it is cut short. */
const FILES_LIMIT = 3000;

/**
 * Every file a pull request changes, as the forge lists them, read page by
 * page; a renamed file counts under both its names. Unreadable when a
 * page does not read, or when the pull request changes as many files as the
 * forge lists at most: a list read in part would place it in too few areas.
 */
export async function pullRequestFiles(
  slug: string,
  pr: number,
): Promise<Outcome<string[], "unreadable">> {
  const files: string[] = [];
  for (let page = 1; ; page++) {
    const read = await ghJson(
      [
        "api",
        `repos/${slug}/pulls/${pr}/files?per_page=${FILES_PAGE}&page=${page}`,
      ],
      `PR #${pr}'s file listing`,
    );
    if (!read.ok) return read;
    const out = read.value;
    if (!Array.isArray(out))
      return unreadable(`PR #${pr}'s file listing is not a list`);
    for (const f of out) {
      const names = fileNames(f);
      if (names === null)
        return unreadable(`PR #${pr}'s file listing is unreadable`);
      files.push(...names);
    }
    if (out.length < FILES_PAGE) return ok(files);
    if (page * FILES_PAGE >= FILES_LIMIT)
      return unreadable(
        `PR #${pr} changes ${FILES_LIMIT} or more files, more than the forge lists`,
      );
  }
}

/** One listed file's names: its path, and the path it was renamed from; `null` when it does not read. */
function fileNames(f: unknown): string[] | null {
  const name = field(f, "filename");
  if (typeof name !== "string" || name === "") return null;
  const before = field(f, "previous_filename");
  return typeof before === "string" && before !== "" ? [name, before] : [name];
}

/** One pull request as a listing or a view reads it. */
export interface ListedPr {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  createdAt?: string;
  mergedAt?: string;
  /** An open pull request's head commit, as the forge reports it. */
  headRefOid?: string;
  /** An open pull request's base branch. */
  baseRefName?: string;
  /** An open pull request's mergeability with its base: `MERGEABLE`, `CONFLICTING`, or `UNKNOWN` while the forge computes it. */
  mergeable?: string;
  /** Its labels' names, when the read asked for them. */
  labels?: string[];
  /** An open pull request's author, as the forge reports it. */
  author?: { login: string; bot: boolean };
  /** Whether an open pull request is a draft. */
  isDraft?: boolean;
  /** When an open pull request was last updated. */
  updatedAt?: string;
  /** Its description, when the read asked for it with the labels. */
  body?: string;
  /** Whether a check on an open pull request's head fails; absent when its checks do not read. */
  failingChecks?: boolean;
  /** An open pull request's unresolved review threads, where the repository's query read them. */
  unresolvedThreads?: number;
}

/** Whether a read carries the pull requests' labels, and their descriptions with them: only where the repository turns dispatch labels on. */
interface LabelRead {
  labels: boolean;
}

const NO_LABELS: LabelRead = { labels: false };

/** The fields every listing reads. */
const LISTED = ["number", "url", "title", "headRefName", "createdAt"];

/** What an open pull request adds: its head commit, its base branch, its mergeability, and what the adoption rule reads (its author, whether it is a draft, its last update, its checks). */
const OPEN_FIELDS = [
  "headRefOid",
  "baseRefName",
  "mergeable",
  "author",
  "isDraft",
  "updatedAt",
  "statusCheckRollup",
];

/** A pull request's author as the listing gives it (`{ login, is_bot }`); nothing when it does not read. */
function authorOf(value: unknown): {
  author?: { login: string; bot: boolean };
} {
  if (!isRecord(value) || typeof value.login !== "string" || value.login === "")
    return {};
  return { author: { login: value.login, bot: value.is_bot === true } };
}

/** What says an open pull request needs work, where the read gave it: whether a check fails, and its unresolved review threads. */
function troubleFacts(
  p: Record<string, unknown>,
): Pick<ListedPr, "failingChecks" | "unresolvedThreads"> {
  const failing = checksFail(p.statusCheckRollup);
  const threads = p.unresolvedThreads;
  return {
    ...(failing === undefined ? {} : { failingChecks: failing }),
    ...(typeof threads === "number" ? { unresolvedThreads: threads } : {}),
  };
}

/** A pull request's label names, or why they do not read. */
function labelNames(
  value: unknown,
  what: string,
): Outcome<string[], "unreadable"> {
  if (
    !Array.isArray(value) ||
    value.some((l) => !isRecord(l) || typeof l.name !== "string")
  )
    return unreadable(`${what}'s labels are unreadable`);
  return ok(value.map((l) => (l as { name: string }).name));
}

/** One pull request of a listing or a view, or why it does not read. */
function listedPr(
  p: unknown,
  what: string,
  read = NO_LABELS,
): Outcome<ListedPr, "unreadable"> {
  if (
    !isRecord(p) ||
    typeof p.number !== "number" ||
    typeof p.headRefName !== "string"
  )
    return unreadable(`${what} is unreadable`);
  const labels = read.labels ? labelNames(p.labels, what) : null;
  if (labels !== null && !labels.ok) return labels;
  const text = (key: string) =>
    typeof p[key] === "string" ? { [key]: p[key] as string } : {};
  return ok({
    number: p.number,
    url: typeof p.url === "string" ? p.url : "",
    title: typeof p.title === "string" ? p.title : "",
    headRefName: p.headRefName,
    ...text("createdAt"),
    ...text("mergedAt"),
    ...text("headRefOid"),
    ...text("baseRefName"),
    ...text("mergeable"),
    ...text("updatedAt"),
    ...(read.labels ? text("body") : {}),
    ...troubleFacts(p),
    ...authorOf(p.author),
    ...(typeof p.isDraft === "boolean" ? { isDraft: p.isDraft } : {}),
    ...(labels === null ? {} : { labels: labels.value }),
  });
}

async function listPrs(
  slug: string,
  extra: string[],
  read: LabelRead,
): Promise<Outcome<ListedPr[], "unreadable">> {
  const fields = [...LISTED];
  if (extra.includes("merged")) fields.push("mergedAt", "updatedAt");
  if (extra.includes("open")) fields.push(...OPEN_FIELDS);
  if (read.labels) fields.push("labels", "body");
  const listing = await ghJson(
    [
      "pr",
      "list",
      "--repo",
      slug,
      "--state",
      ...extra,
      "--limit",
      String(PR_LIMIT),
      "--json",
      fields.join(","),
    ],
    "the pull request listing",
  );
  if (!listing.ok) return listing;
  const out = listing.value;
  if (!Array.isArray(out))
    return unreadable("the pull request listing is not a list");
  if (out.length >= PR_LIMIT)
    return unreadable(
      `${slug} lists ${PR_LIMIT} or more pull requests, more than one read holds`,
    );
  return listedAll(out, "of the listing", read);
}

/** Each pull request of a listing, `where` naming the listing; the first that does not read. */
function listedAll(
  listed: readonly unknown[],
  where: string,
  read: LabelRead,
): Outcome<ListedPr[], "unreadable"> {
  const prs: ListedPr[] = [];
  for (const [i, p] of listed.entries()) {
    const pr = listedPr(p, `pull request ${i} ${where}`, read);
    if (!pr.ok) return pr;
    prs.push(pr.value);
  }
  return ok(prs);
}

/**
 * Every open pull request of the repository in one listing, each with its
 * head commit and mergeability, and its labels when `read` asks for them.
 */
export async function openPullRequests(
  slug: string,
  read = NO_LABELS,
): Promise<Outcome<ListedPr[], "unreadable">> {
  return listPrs(slug, ["open"], read);
}

/**
 * The open pull requests a repository's query listed (`forge-batch.ts`),
 * read as `openPullRequests` reads its listing: their labels only when
 * `read` asks for them.
 */
export function listedOpen(
  listed: readonly unknown[],
  read = NO_LABELS,
): Outcome<ListedPr[], "unreadable"> {
  return listedAll(listed, "of the repository query", read);
}

/**
 * One open pull request read again, as the listing reads it, for the fresh
 * read before a launch; `not-open` when it is no longer open.
 */
export async function openPullRequest(
  slug: string,
  pr: number,
  read = NO_LABELS,
): Promise<Outcome<ListedPr, "unreadable" | "not-open">> {
  const view = await ghJson(
    [
      "pr",
      "view",
      String(pr),
      "--repo",
      slug,
      "--json",
      [
        ...LISTED,
        ...OPEN_FIELDS,
        "state",
        ...(read.labels ? ["labels", "body"] : []),
      ].join(","),
    ],
    "the pull request view",
  );
  if (!view.ok) return view;
  const state = field(view.value, "state");
  if (state !== "OPEN")
    return failed("not-open", `PR #${pr} reads ${String(state)}`);
  return listedPr(view.value, `PR #${pr}'s view`, read);
}

/**
 * The commit a branch of the repository is at now. A pull request's own
 * `baseRefOid` is not it: the forge records that commit when the pull request
 * last moved, and it stays put while the base branch moves on.
 */
export async function branchHead(
  slug: string,
  branch: string,
  timeoutSec?: number,
): Promise<Outcome<string, "unreadable">> {
  const ref = branch.split("/").map(encodeURIComponent).join("/");
  const out = await ghJson(
    ["api", `repos/${slug}/git/ref/heads/${ref}`],
    `branch ${branch}'s ref`,
    undefined,
    timeoutSec,
  );
  if (!out.ok) return out;
  const sha = field(field(out.value, "object"), "sha");
  if (typeof sha !== "string" || sha === "")
    return unreadable(`branch ${branch}'s ref names no commit`);
  return ok(sha);
}

/** One pull request's label names, read now whatever state it is in. */
export async function pullRequestLabels(
  slug: string,
  pr: number,
): Promise<Outcome<string[], "unreadable">> {
  const out = await ghJson(
    ["pr", "view", String(pr), "--repo", slug, "--json", "labels"],
    "the pull request view",
  );
  if (!out.ok) return out;
  return labelNames(field(out.value, "labels"), `PR #${pr}`);
}

/** The head commit of open pull request `pr`, read now; a pull request that is no longer open does not read. */
export async function pullRequestHead(
  slug: string,
  pr: number,
  timeoutSec?: number,
): Promise<Outcome<string, "unreadable">> {
  const out = await ghJson(
    ["pr", "view", String(pr), "--repo", slug, "--json", "headRefOid,state"],
    "the pull request view",
    undefined,
    timeoutSec,
  );
  if (!out.ok) return out;
  const state = field(out.value, "state");
  if (state !== "OPEN")
    return failed("unreadable", `PR #${pr} reads ${String(state)}`);
  const head = field(out.value, "headRefOid");
  return typeof head === "string" && head !== ""
    ? ok(head)
    : failed("unreadable", `PR #${pr}'s head did not read`);
}

/** Every pull request merged at or after `since` (ISO 8601). */
export async function mergedSince(
  slug: string,
  since: string,
  read = NO_LABELS,
): Promise<Outcome<MergedPr[], "unreadable">> {
  const day = since.slice(0, 10);
  const listing = await listPrs(
    slug,
    ["merged", "--search", `merged:>=${day}`],
    read,
  );
  if (!listing.ok) return listing;
  const listed = listing.value;
  for (const p of listed)
    if (p.mergedAt === undefined || !Number.isFinite(Date.parse(p.mergedAt)))
      return unreadable(
        `merged pull request #${p.number} has no valid merge time`,
      );
  const merged = listed
    .filter((p) => Date.parse(p.mergedAt as string) >= Date.parse(since))
    .map((p) => ({
      number: p.number,
      url: p.url,
      title: p.title,
      head: p.headRefName,
      mergedAt: p.mergedAt as string,
      ...(p.createdAt === undefined ? {} : { createdAt: p.createdAt }),
      ...(p.updatedAt === undefined ? {} : { updatedAt: p.updatedAt }),
      ...(p.labels === undefined ? {} : { labels: p.labels }),
      ...(p.body === undefined ? {} : { body: p.body }),
    }))
    .sort((a, b) => a.number - b.number);
  return ok(merged);
}

/** One page of a pull request's review threads: whether each is resolved. */
const THREADS_QUERY = `query DispatchThreads($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved } }
    }
  }
}`;

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/**
 * How many of a pull request's review threads are unresolved. A pull
 * request with more threads than one page holds is unreadable, as any read
 * in part is: the count would be a guess.
 */
export async function unresolvedThreadCount(
  slug: string,
  pr: number,
): Promise<Outcome<number, "unreadable">> {
  const [owner, name] = slug.split("/");
  const answer = await ghJson(
    [
      "api",
      "graphql",
      "-f",
      `query=${THREADS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `pr=${pr}`,
    ],
    "the review threads answer",
  );
  if (!answer.ok) return answer;
  const threads = field(
    field(field(field(answer.value, "data"), "repository"), "pullRequest"),
    "reviewThreads",
  );
  const nodes = field(threads, "nodes");
  if (!Array.isArray(nodes))
    return unreadable(`PR #${pr}'s review threads did not read`);
  if (field(field(threads, "pageInfo"), "hasNextPage") === true)
    return unreadable(`PR #${pr} has more review threads than one read holds`);
  return ok(nodes.filter((n) => field(n, "isResolved") === false).length);
}

/** Whether a pull request merged (true) or was closed unmerged (false); `not-closed` while it is open. */
export async function mergedNotClosed(
  slug: string,
  pr: number,
): Promise<Outcome<boolean, "unreadable" | "not-closed">> {
  const out = await ghJson(
    ["pr", "view", String(pr), "--repo", slug, "--json", "state"],
    "the pull request view",
  );
  if (!out.ok) return out;
  const state = field(out.value, "state");
  if (state === "MERGED") return ok(true);
  if (state === "CLOSED") return ok(false);
  return failed("not-closed", `PR #${pr} reads ${String(state)}`);
}

/**
 * Change a pull request's labels in one call: `add` added, `remove`
 * removed, every other label left as it is; `refused` with the forge's
 * reason (a label that does not exist, no permission).
 */
export async function editLabels(
  slug: string,
  pr: number,
  add: readonly string[],
  remove: readonly string[],
): Promise<Outcome<void, "refused">> {
  const edited = await gh(
    [
      "pr",
      "edit",
      String(pr),
      "--repo",
      slug,
      ...add.flatMap((l) => ["--add-label", l]),
      ...remove.flatMap((l) => ["--remove-label", l]),
    ],
    "refused",
  );
  return edited.ok ? ok(undefined) : edited;
}

/** The names of every label the repository has. */
export async function repositoryLabels(
  slug: string,
): Promise<Outcome<string[], "unreadable">> {
  const out = await ghJson(
    [
      "label",
      "list",
      "--repo",
      slug,
      "--limit",
      String(PR_LIMIT),
      "--json",
      "name",
    ],
    "the label listing",
  );
  if (!out.ok) return out;
  const names = labelNames(out.value, slug);
  if (!names.ok) return names;
  if (names.value.length >= PR_LIMIT)
    return unreadable(
      `${slug} has ${PR_LIMIT} or more labels, more than one read holds`,
    );
  return names;
}

/** Create one label; `refused` with the forge's reason (no permission). */
export async function createLabel(
  slug: string,
  label: { name: string; color: string; description: string },
): Promise<Outcome<void, "refused">> {
  const created = await gh(
    [
      "label",
      "create",
      label.name,
      "--repo",
      slug,
      "--color",
      label.color,
      "--description",
      label.description,
    ],
    "refused",
  );
  return created.ok ? ok(undefined) : created;
}

/** A pull request's link when no read gave one: the forge is GitHub, read through `gh`. */
export function pullUrl(slug: string, pr: number): string {
  return `https://github.com/${slug}/pull/${pr}`;
}
