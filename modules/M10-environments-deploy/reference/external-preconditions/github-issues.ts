/** GitHub issues implement the registry's tracker port; reads must be complete. */
import {
  type GhApi,
  ghApi,
} from "../../../../plugin/skills/changelog/scripts/github-rules.ts";
import { isRecord } from "../../../../lib/record.ts";
import { checkpoint } from "./deadline.ts";
import {
  PreconditionIssueError,
  type IssueContent,
  type TrackerIssue,
  type TrackerPort,
} from "./reconcile.ts";

function readIssue(value: unknown): TrackerIssue {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.number) ||
    Number(value.number) <= 0 ||
    typeof value.title !== "string" ||
    (value.body !== null && typeof value.body !== "string")
  )
    throw new PreconditionIssueError("GitHub returned a malformed issue");
  return {
    id: String(value.number),
    title: value.title,
    body: value.body ?? "",
  };
}

/** One listed issue by `creator`, or undefined for a pull request; repeats and other creators throw. */
function listedIssue(
  item: unknown,
  creator: string,
  seen: Set<string>,
): TrackerIssue | undefined {
  const issue = readIssue(item);
  if (seen.has(issue.id))
    throw new PreconditionIssueError(
      "GitHub issue listing repeated an issue across pages",
    );
  seen.add(issue.id);
  if (!isRecord(item) || !isRecord(item.user) || item.user.login !== creator)
    throw new PreconditionIssueError(
      "GitHub issue listing returned an issue by another creator",
    );
  return "pull_request" in item ? undefined : issue;
}

/**
 * `creator` is the login that reconciles (for a workflow token,
 * `github-actions[bot]`): only its issues are listed, so an issue anyone else
 * opens with the public marker is never adopted, updated or closed.
 * Inject `api` in tests; live operations use the shared bounded gh process.
 */
export function githubIssues(
  repository: string,
  creator: string,
  api: GhApi = ghApi(),
): TrackerPort {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split("/").some((part) => part === "." || part === "..")
  )
    throw new PreconditionIssueError("GitHub repository must be owner/name");
  if (!/^[A-Za-z0-9-]+(\[bot\])?$/.test(creator))
    throw new PreconditionIssueError("GitHub issue creator must be a login");
  const endpoint = `repos/${repository}/issues`;
  function request(args: string[]): unknown {
    const result = api(args);
    if (!result.ok)
      throw new PreconditionIssueError(
        `GitHub issue request failed: ${result.stderr}`,
      );
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new PreconditionIssueError(
        "GitHub issue response is not valid JSON",
      );
    }
  }
  function issueEndpoint(id: string): string {
    if (!/^[1-9][0-9]*$/.test(id))
      throw new PreconditionIssueError(
        "GitHub issue id must be a positive integer",
      );
    return `${endpoint}/${id}`;
  }
  function fields(content: IssueContent): string[] {
    return ["-f", `title=${content.title}`, "-f", `body=${content.body}`];
  }
  return {
    async listOpen(signal) {
      const issues: TrackerIssue[] = [];
      const seen = new Set<string>();
      // Explicit pages avoid silently consuming only gh's first response page.
      // A bound also makes a non-progressing API fail instead of looping forever.
      for (let page = 1; page <= 1000; page++) {
        await checkpoint(signal);
        const value = request([
          `${endpoint}?state=open&creator=${encodeURIComponent(creator)}&per_page=100&page=${page}`,
        ]);
        if (!Array.isArray(value) || value.length > 100)
          throw new PreconditionIssueError(
            "GitHub issue listing must be an array of at most 100 issues",
          );
        for (const item of value) {
          const issue = listedIssue(item, creator, seen);
          if (issue) issues.push(issue);
        }
        if (value.length < 100) return issues;
      }
      throw new PreconditionIssueError(
        "GitHub issue listing exceeded its page limit; no complete listing available",
      );
    },
    async create(content) {
      return readIssue(
        request([endpoint, "--method", "POST", ...fields(content)]),
      );
    },
    async update(id, content) {
      return readIssue(
        request([issueEndpoint(id), "--method", "PATCH", ...fields(content)]),
      );
    },
    async close(id) {
      readIssue(
        request([issueEndpoint(id), "--method", "PATCH", "-f", "state=closed"]),
      );
    },
  };
}
