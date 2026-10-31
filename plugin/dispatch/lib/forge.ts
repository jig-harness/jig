/**
 * The forge reads a tick makes for one repository, through the signed-in
 * `gh` command-line client and under its deadline: which repository a
 * checkout is, the repository's `.config/jig.yaml` on its default branch, its
 * open pull requests and the pull requests merged since a date. Each read
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
  mergedAt?: string;
}

async function listPrs(slug: string, extra: string[]): Promise<ListedPr[]> {
  const fields = ["number", "url", "title", "headRefName"];
  if (extra.includes("merged")) fields.push("mergedAt");
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
  return out.map((p, i) => {
    if (
      !isRecord(p) ||
      typeof p.number !== "number" ||
      typeof p.headRefName !== "string"
    )
      throw new ForgeReadError(
        `pull request ${i} of the listing is unreadable`,
      );
    return {
      number: p.number,
      url: typeof p.url === "string" ? p.url : "",
      title: typeof p.title === "string" ? p.title : "",
      headRefName: p.headRefName,
      ...(typeof p.mergedAt === "string" ? { mergedAt: p.mergedAt } : {}),
    };
  });
}

/** Every open pull request of the repository. */
export async function openPullRequests(slug: string): Promise<ListedPr[]> {
  return listPrs(slug, ["open"]);
}

/** Every pull request merged at or after `since` (ISO 8601). */
export async function mergedSince(
  slug: string,
  since: string,
): Promise<MergedPr[]> {
  const day = since.slice(0, 10);
  const listed = await listPrs(slug, ["merged", "--search", `merged:>=${day}`]);
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
    }))
    .sort((a, b) => a.number - b.number);
}
