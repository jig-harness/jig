/** Updated issues wake served queues without reading each assignment's history. */
import { homedir } from "node:os";
import { isRecord } from "../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { ghCall, ghRepoEnv } from "../../skills/drive-pr/scripts/lib/proc.ts";
import type { ChangedPr } from "./change-probe.ts";

type Read = { changed: ChangedPr[]; calls: number };

/** Every page of GitHub's issues-since listing; pull requests share that endpoint and are omitted. */
export function readIssuePages(
  stdout: string,
  slug: string,
): Outcome<Read, "unreadable"> {
  let pages: unknown;
  try {
    pages = JSON.parse(stdout);
  } catch (error) {
    return failed(
      "unreadable",
      `the updated issues of ${slug} are not JSON: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  if (!Array.isArray(pages) || !pages.every(Array.isArray))
    return failed(
      "unreadable",
      `the updated issues of ${slug} did not list every page`,
    );
  const changed: ChangedPr[] = [];
  for (const page of pages)
    for (const node of page) {
      const read = readUpdatedIssue(node, slug);
      if (!read.ok) return read;
      if (read.value !== null) changed.push(read.value);
    }
  return ok({ changed, calls: pages.length });
}

/** One bounded, paged listing per repository; a partial read wakes nothing and retains the previous probe window. */
export async function issueUpdates(
  slugs: readonly string[],
  since: string,
): Promise<Outcome<Read, "unreadable">> {
  const changed: ChangedPr[] = [];
  let calls = 0;
  for (const slug of slugs) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(slug) || !Number.isFinite(Date.parse(since)))
      return failed(
        "unreadable",
        "the issue probe needs a repository slug and an ISO time",
      );
    const endpoint = `repos/${slug}/issues?state=all&since=${encodeURIComponent(since)}&per_page=100`;
    const result = await ghCall(["api", "--paginate", "--slurp", endpoint], {
      stderr: "pipe",
      env: ghRepoEnv(),
      cwd: homedir(),
    });
    if (result.spawnFailed || result.code !== 0)
      return failed(
        "unreadable",
        `the updated issues of ${slug} could not be read: ${result.stderr.trim()}`,
      );
    const read = readIssuePages(result.stdout, slug);
    if (!read.ok) return read;
    changed.push(...read.value.changed);
    calls += read.value.calls;
  }
  return ok({ changed, calls });
}

function readUpdatedIssue(
  node: unknown,
  slug: string,
): Outcome<ChangedPr | null, "unreadable"> {
  if (!isRecord(node))
    return failed(
      "unreadable",
      `the updated issues of ${slug} contain an unreadable item`,
    );
  if (node.pull_request !== undefined) return ok(null);
  if (
    !Number.isSafeInteger(node.number) ||
    Number(node.number) < 1 ||
    typeof node.updated_at !== "string" ||
    !Number.isFinite(Date.parse(node.updated_at))
  )
    return failed(
      "unreadable",
      `an updated issue of ${slug} lacks its number or update time`,
    );
  return ok({
    slug,
    number: Number(node.number),
    updatedAt: node.updated_at,
  });
}
