/**
 * The forge reads a tick makes for one repository, through the signed-in
 * `gh` command-line client and under its deadline: which repository a
 * checkout is, the repository's `.config/jig.yaml` on its default branch, its
 * open pull requests (each with its head commit and its mergeability with
 * its base, read with it) and the pull requests merged since a date, and, for
 * Control, a pull request's unresolved review threads and whether a closed
 * one merged. Where the repository turns dispatch labels on, each listing
 * and view carries the pull requests' labels too, and a pull request's
 * labels are changed with one `gh pr edit` call; with them off, no label
 * is read or written. Each read
 * returns what it was asked for or throws with the reason, so a population
 * read in part is never planned from.
 */
import { isRecord } from "../../shared/guards.ts";
import { ghCall, ghRepoEnv } from "../../skills/drive-pr/scripts/lib/proc.ts";
import { OVERLAY_RELPATH } from "../../shared/config-layers.ts";
import type { MergedPr, RepoTarget } from "./types.ts";

/** The most pull requests one listing reads; a full page means a partial read. */
const PR_LIMIT = 1000;

class ForgeReadError extends Error {}

async function gh(args: string[], cwd?: string): Promise<string> {
  const r = await ghCall(args, {
    stderr: "pipe",
    env: ghRepoEnv(),
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (r.code === 0) return r.stdout;
  const tail = r.stderr.trim().split("\n").at(-1) ?? "";
  throw new ForgeReadError(
    `gh ${args.slice(0, 2).join(" ")} exited ${r.code}${tail === "" ? "" : `: ${tail}`}`,
  );
}

function parsed(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ForgeReadError(`${what} is not JSON`);
  }
}

/** The forge repository a checkout belongs to, and its default branch. */
export async function repoTarget(path: string): Promise<RepoTarget> {
  const out = parsed(
    await gh(
      ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
      path,
    ),
    "the repository view",
  );
  const slug = isRecord(out) ? out.nameWithOwner : undefined;
  const branch =
    isRecord(out) && isRecord(out.defaultBranchRef)
      ? out.defaultBranchRef.name
      : undefined;
  if (typeof slug !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(slug))
    throw new ForgeReadError("the repository view names no owner/name");
  if (typeof branch !== "string" || branch === "")
    throw new ForgeReadError(`${slug} reports no default branch`);
  return { path, slug, defaultBranch: branch };
}

/**
 * The repository's configuration file as its default branch holds it on
 * the forge, never a checkout's copy; `null` when the branch has none.
 */
export async function defaultBranchConfig(
  repo: RepoTarget,
): Promise<string | null> {
  const r = await ghCall(
    [
      "api",
      `repos/${repo.slug}/contents/${OVERLAY_RELPATH}?ref=${encodeURIComponent(repo.defaultBranch)}`,
    ],
    { stderr: "pipe", env: ghRepoEnv() },
  );
  if (r.code !== 0) {
    if (/HTTP 404/.test(r.stderr)) return null;
    const tail = r.stderr.trim().split("\n").at(-1) ?? "";
    throw new ForgeReadError(
      `${OVERLAY_RELPATH} on ${repo.slug}@${repo.defaultBranch} could not be read (gh exited ${r.code}${tail === "" ? "" : `: ${tail}`})`,
    );
  }
  const file = parsed(r.stdout, "the contents answer");
  if (
    !isRecord(file) ||
    file.encoding !== "base64" ||
    typeof file.content !== "string"
  )
    throw new ForgeReadError(
      `${OVERLAY_RELPATH} on ${repo.slug}@${repo.defaultBranch} came back without base64 content`,
    );
  return Buffer.from(file.content, "base64").toString("utf8");
}

interface ListedPr {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  createdAt?: string;
  mergedAt?: string;
  /** An open pull request's head commit, as the forge reports it. */
  headRefOid?: string;
  /** An open pull request's mergeability with its base: `MERGEABLE`, `CONFLICTING`, or `UNKNOWN` while the forge computes it. */
  mergeable?: string;
  /** Its labels' names, when the read asked for them. */
  labels?: string[];
}

/** Whether a read carries the pull requests' labels: only where the repository turns dispatch labels on. */
interface LabelRead {
  labels: boolean;
}

const NO_LABELS: LabelRead = { labels: false };

/** The fields every listing reads. */
const LISTED = ["number", "url", "title", "headRefName", "createdAt"];

/** What an open pull request adds: its head commit and its mergeability. */
const OPEN_FIELDS = ["headRefOid", "mergeable"];

/** A pull request's label names, or why they do not read. */
function labelNames(value: unknown, what: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((l) => !isRecord(l) || typeof l.name !== "string")
  )
    throw new ForgeReadError(`${what}'s labels are unreadable`);
  return value.map((l) => (l as { name: string }).name);
}

/** One pull request of a listing or a view, or why it does not read. */
function listedPr(p: unknown, what: string, read = NO_LABELS): ListedPr {
  if (
    !isRecord(p) ||
    typeof p.number !== "number" ||
    typeof p.headRefName !== "string"
  )
    throw new ForgeReadError(`${what} is unreadable`);
  const text = (key: string) =>
    typeof p[key] === "string" ? { [key]: p[key] as string } : {};
  return {
    number: p.number,
    url: typeof p.url === "string" ? p.url : "",
    title: typeof p.title === "string" ? p.title : "",
    headRefName: p.headRefName,
    ...text("createdAt"),
    ...text("mergedAt"),
    ...text("headRefOid"),
    ...text("mergeable"),
    ...(read.labels ? { labels: labelNames(p.labels, what) } : {}),
  };
}

async function listPrs(
  slug: string,
  extra: string[],
  read: LabelRead,
): Promise<ListedPr[]> {
  const fields = [...LISTED];
  if (extra.includes("merged")) fields.push("mergedAt");
  if (extra.includes("open")) fields.push(...OPEN_FIELDS);
  if (read.labels) fields.push("labels");
  const out = parsed(
    await gh([
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
    ]),
    "the pull request listing",
  );
  if (!Array.isArray(out))
    throw new ForgeReadError("the pull request listing is not a list");
  if (out.length >= PR_LIMIT)
    throw new ForgeReadError(
      `${slug} lists ${PR_LIMIT} or more pull requests, more than one read holds`,
    );
  return out.map((p, i) =>
    listedPr(p, `pull request ${i} of the listing`, read),
  );
}

/**
 * Every open pull request of the repository in one listing, each with its
 * head commit and mergeability, and its labels when `read` asks for them.
 */
export async function openPullRequests(
  slug: string,
  read = NO_LABELS,
): Promise<ListedPr[]> {
  return listPrs(slug, ["open"], read);
}

/**
 * One open pull request read again, as the listing reads it, for the fresh
 * read before a launch; throws when it is no longer open or does not read.
 */
export async function openPullRequest(
  slug: string,
  pr: number,
  read = NO_LABELS,
): Promise<ListedPr> {
  const out = parsed(
    await gh([
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
        ...(read.labels ? ["labels"] : []),
      ].join(","),
    ]),
    "the pull request view",
  );
  const state = field(out, "state");
  if (state !== "OPEN")
    throw new ForgeReadError(`PR #${pr} reads ${String(state)}`);
  return listedPr(out, `PR #${pr}'s view`, read);
}

/** Every pull request merged at or after `since` (ISO 8601). */
export async function mergedSince(
  slug: string,
  since: string,
  read = NO_LABELS,
): Promise<MergedPr[]> {
  const day = since.slice(0, 10);
  const listed = await listPrs(
    slug,
    ["merged", "--search", `merged:>=${day}`],
    read,
  );
  for (const p of listed)
    if (p.mergedAt === undefined || !Number.isFinite(Date.parse(p.mergedAt)))
      throw new ForgeReadError(
        `merged pull request #${p.number} has no valid merge time`,
      );
  return listed
    .filter((p) => Date.parse(p.mergedAt as string) >= Date.parse(since))
    .map((p) => ({
      number: p.number,
      url: p.url,
      title: p.title,
      head: p.headRefName,
      mergedAt: p.mergedAt as string,
      ...(p.createdAt === undefined ? {} : { createdAt: p.createdAt }),
      ...(p.labels === undefined ? {} : { labels: p.labels }),
    }))
    .sort((a, b) => a.number - b.number);
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
 * request with more threads than one page holds throws, as any read in
 * part does: the count would be a guess.
 */
export async function unresolvedThreadCount(
  slug: string,
  pr: number,
): Promise<number> {
  const [owner, name] = slug.split("/");
  const out = parsed(
    await gh([
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
    ]),
    "the review threads answer",
  );
  const threads = field(
    field(field(field(out, "data"), "repository"), "pullRequest"),
    "reviewThreads",
  );
  const nodes = field(threads, "nodes");
  if (!Array.isArray(nodes))
    throw new ForgeReadError(`PR #${pr}'s review threads did not read`);
  if (field(field(threads, "pageInfo"), "hasNextPage") === true)
    throw new ForgeReadError(
      `PR #${pr} has more review threads than one read holds`,
    );
  return nodes.filter((n) => field(n, "isResolved") === false).length;
}

/** Whether a pull request merged (true) or was closed unmerged (false); throws while it is open or unreadable. */
export async function mergedNotClosed(
  slug: string,
  pr: number,
): Promise<boolean> {
  const out = parsed(
    await gh(["pr", "view", String(pr), "--repo", slug, "--json", "state"]),
    "the pull request view",
  );
  const state = field(out, "state");
  if (state === "MERGED") return true;
  if (state === "CLOSED") return false;
  throw new ForgeReadError(`PR #${pr} reads ${String(state)}`);
}

/**
 * Change a pull request's labels in one call: `add` added, `remove`
 * removed, every other label left as it is. Throws with the forge's reason
 * (a label that does not exist, no permission).
 */
export async function editLabels(
  slug: string,
  pr: number,
  add: readonly string[],
  remove: readonly string[],
): Promise<void> {
  await gh([
    "pr",
    "edit",
    String(pr),
    "--repo",
    slug,
    ...add.flatMap((l) => ["--add-label", l]),
    ...remove.flatMap((l) => ["--remove-label", l]),
  ]);
}

/** The names of every label the repository has. */
export async function repositoryLabels(slug: string): Promise<string[]> {
  const out = parsed(
    await gh([
      "label",
      "list",
      "--repo",
      slug,
      "--limit",
      String(PR_LIMIT),
      "--json",
      "name",
    ]),
    "the label listing",
  );
  const names = labelNames(out, slug);
  if (names.length >= PR_LIMIT)
    throw new ForgeReadError(
      `${slug} has ${PR_LIMIT} or more labels, more than one read holds`,
    );
  return names;
}

/** Create one label; throws with the forge's reason (no permission). */
export async function createLabel(
  slug: string,
  label: { name: string; color: string; description: string },
): Promise<void> {
  await gh([
    "label",
    "create",
    label.name,
    "--repo",
    slug,
    "--color",
    label.color,
    "--description",
    label.description,
  ]);
}
