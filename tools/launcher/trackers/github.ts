/** GitHub Issues launcher tracker, using the logged-in GitHub command line. */
import { isRecord } from "../../../lib/record.ts";
import type { ContextCache } from "../cache.ts";
import { LauncherConfigError } from "../config.ts";
import type { AssignResult, Tracker, TrackerOptions } from "../tracker.ts";

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9_.-]+$/;
const ISSUE_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\/?$/;

export interface GithubDeps {
  run?(args: string[], signal: AbortSignal): Promise<unknown>;
}

/** Validate each repository's tracker settings before a read or workspace opens. */
function repositories(repos: TrackerOptions["repos"]): Map<string, string> {
  const result = new Map<string, string>();
  for (const [label, settings] of Object.entries(repos ?? {})) {
    const raw = settings.github;
    if (raw === undefined) continue;
    const where = `repos.${label}.github`;
    const key = repositorySetting(raw, where).toLowerCase();
    if (result.has(key))
      throw new LauncherConfigError(
        `${where}.repository is configured more than once`,
      );
    result.set(key, label);
  }
  return result;
}

function repositorySetting(raw: unknown, where: string): string {
  if (!isRecord(raw))
    throw new LauncherConfigError(`${where} must be a mapping with repository`);
  const unknown = Object.keys(raw).find((key) => key !== "repository");
  if (unknown !== undefined)
    throw new LauncherConfigError(
      `${where}: unknown key ${unknown} (known: repository)`,
    );
  const repository = raw.repository;
  if (
    typeof repository !== "string" ||
    !REPOSITORY.test(repository) ||
    [".", ".."].includes(repository.split("/")[1] ?? "")
  )
    throw new LauncherConfigError(
      `${where}.repository must be owner/repository`,
    );
  return repository;
}

/** Every command has the caller's cancellation and a deadline, including its output read. */
async function gh(
  args: string[],
  signal: AbortSignal,
  env: TrackerOptions["env"],
): Promise<unknown> {
  signal.throwIfAborted();
  const child = Bun.spawn(["gh", "api", "--hostname", "github.com", ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    readCapped(child.stdout, () => child.kill()),
    readCapped(child.stderr, () => child.kill()),
  ]);
  signal.throwIfAborted();
  if (code !== 0)
    throw new GithubTrackerError(`gh api exited ${code}: ${stderr.trim()}`);
  return JSON.parse(stdout);
}

/** Bound the bytes buffered from a command before parsing them. */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  stop: () => void,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > 5_000_000) {
      stop();
      throw new GithubTrackerError("GitHub response exceeded byte cap");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A tracker read or write failed and its caller can continue the launch. */
class GithubTrackerError extends Error {
  override name = "GithubTrackerError";
  readonly code = "github-tracker";
}

type Run = NonNullable<GithubDeps["run"]>;
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function issueText(
  issue: unknown,
  key: string,
): { title: string; body: string; assignees: unknown } {
  if (
    !isRecord(issue) ||
    issue.number !== Number(key.slice(1)) ||
    issue.pull_request !== undefined ||
    typeof issue.title !== "string" ||
    (issue.body !== null && typeof issue.body !== "string")
  )
    throw new GithubTrackerError(
      "GitHub did not return the requested issue and its text",
    );
  return {
    title: issue.title,
    body: issue.body ?? "",
    assignees: issue.assignees,
  };
}

function comment(raw: unknown): NonNullable<ContextCache["comments"]>[number] {
  if (
    !isRecord(raw) ||
    typeof raw.body !== "string" ||
    typeof raw.created_at !== "string"
  )
    throw new GithubTrackerError("malformed comment");
  const id = isRecord(raw.user) ? raw.user.id : null;
  return {
    body: raw.body,
    created_at: raw.created_at,
    author_id:
      typeof id === "number" || typeof id === "string" ? String(id) : null,
  };
}

async function cacheComments(
  run: Run,
  endpoint: string,
  signal: AbortSignal,
  cache: ContextCache,
  warnings: string[],
): Promise<void> {
  try {
    const pages = await run(
      [`${endpoint}/comments`, "--paginate", "--slurp"],
      signal,
    );
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
      throw new GithubTrackerError("malformed comment pages");
    const comments = pages.flat().map(comment);
    cache.comments = comments;
    cache.comments_cached = true;
  } catch (error) {
    warnings.push(
      `Comments for ${cache.identifier} were not read in full (${describe(error)}); the pickup will fetch them`,
    );
  }
}

const REPOSITORY_URL = /\/repos\/([^/]+\/[^/]+)$/;

/** `#n` for an issue in the workspace repository, `owner/repo#n` for another. */
function relatedKey(issue: unknown, repository: string): string {
  const number = isRecord(issue) ? issue.number : undefined;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    throw new GithubTrackerError("malformed related issue");
  const url = isRecord(issue) ? issue.repository_url : undefined;
  const owner = typeof url === "string" ? REPOSITORY_URL.exec(url)?.[1] : null;
  if (owner === undefined || owner === null)
    throw new GithubTrackerError("related issue names no repository");
  return owner.toLowerCase() === repository.toLowerCase()
    ? `#${number}`
    : `${owner}#${number}`;
}

/** Read both supported GitHub issue-dependency directions when available. */
async function cacheRelationships(
  run: Run,
  endpoint: string,
  repository: string,
  signal: AbortSignal,
  cache: ContextCache,
  warnings: string[],
): Promise<void> {
  const linked = new Set<string>();
  for (const suffix of ["dependencies/blocked_by", "dependencies/blocking"]) {
    try {
      const response = await run(
        [`${endpoint}/${suffix}`, "--paginate", "--slurp"],
        signal,
      );
      if (
        !Array.isArray(response) ||
        response.some((page) => !Array.isArray(page))
      )
        throw new GithubTrackerError("malformed relationship pages");
      for (const issue of response.flat()) {
        try {
          linked.add(relatedKey(issue, repository));
        } catch (error) {
          warnings.push(
            `A ${suffix} entry for ${cache.identifier} was skipped (${describe(error)})`,
          );
        }
      }
    } catch (error) {
      warnings.push(
        `Relationships ${suffix} for ${cache.identifier} were not read in full (${describe(error)}); that direction's linked issue context is unavailable`,
      );
    }
  }
  cache.linked_issue_ids = [...linked];
}

function assignedTo(assignees: unknown, login: string): boolean {
  return (
    Array.isArray(assignees) &&
    assignees.some((a) => isRecord(a) && a.login === login)
  );
}

async function assign(
  run: Run,
  endpoint: string,
  assignees: unknown,
  signal: AbortSignal,
): Promise<AssignResult> {
  try {
    const user = await run(["user"], signal);
    if (!isRecord(user) || typeof user.login !== "string" || !user.login)
      throw new GithubTrackerError(
        "GitHub did not return the authenticated user",
      );
    if (!assignedTo(assignees, user.login)) {
      const updated = await run(
        [
          `${endpoint}/assignees`,
          "--method",
          "POST",
          "-f",
          `assignees[]=${user.login}`,
        ],
        signal,
      );
      if (!isRecord(updated) || !assignedTo(updated.assignees, user.login))
        throw new GithubTrackerError(
          "GitHub did not confirm assignment to the authenticated user",
        );
    }
    return { assigned: true };
  } catch (error) {
    return { assigned: false, reason: describe(error) };
  }
}

export function githubTracker(
  options: TrackerOptions,
  deps: GithubDeps = {},
): Tracker {
  const repos = repositories(options.repos);
  const run = deps.run ?? ((args, signal) => gh(args, signal, options.env));
  function resolve(input: string): {
    key: string;
    repository: string;
    label: string;
  } {
    const url = ISSUE_URL.exec(input);
    const number = url?.[2] ?? /^#?([1-9][0-9]*)$/.exec(input)?.[1];
    if (number === undefined)
      throw new LauncherConfigError(
        "GitHub issue must be a positive number, #number or GitHub issue web address",
      );
    const repository =
      url?.[1]?.toLowerCase() ??
      (repos.size === 1 ? [...repos.keys()][0] : undefined);
    if (repository === undefined)
      throw new LauncherConfigError(
        "Use the issue's web address when more than one GitHub repository is configured",
      );
    const label = repos.get(repository);
    if (label === undefined)
      throw new LauncherConfigError(
        `GitHub repository ${repository} is not configured in repos`,
      );
    return { key: `#${number}`, repository, label };
  }
  return {
    name: "github",
    launchEnvironment: {},
    normalizeIssue: (input) => resolve(input).key,
    cacheNamespace: (input) => `github/${resolve(input).repository}`,
    async read(request) {
      const { repository, label, key } = resolve(
        request.originalIssue ?? request.issue,
      );
      const endpoint = `repos/${repository}/issues/${key.slice(1)}`;
      try {
        const issue = await run([endpoint], request.signal);
        const text = issueText(issue, key);
        const cache: ContextCache = {
          identifier: key,
          title: text.title,
          description: text.body,
          branch_name: "",
          cached_at: request.nowSeconds,
          linked_issue_ids: [],
        };
        const warnings: string[] = [];
        await cacheComments(run, endpoint, request.signal, cache, warnings);
        await cacheRelationships(
          run,
          endpoint,
          repository,
          request.signal,
          cache,
          warnings,
        );
        return {
          cache,
          repoLabel: label,
          warnings,
          assignToOpener: (signal) =>
            assign(run, endpoint, text.assignees, signal),
        };
      } catch (error) {
        const reason = `Could not fetch ${key} (${error instanceof Error ? error.message : String(error)})`;
        return {
          cache: null,
          repoLabel: label,
          warnings: [reason],
          async assignToOpener() {
            return { assigned: false, reason };
          },
        };
      }
    },
  };
}
