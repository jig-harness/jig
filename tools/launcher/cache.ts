/**
 * The launcher context cache: the file the issue-pickup skill reads to start
 * with the whole issue in hand.
 *
 * Why a cache file: a launcher hands the agent its first prompt through a URL
 * or a terminal, both of which cap length, so the issue body, comments and
 * links travel in a file instead and the prompt names it. The shape is the
 * skill's, not a tracker's: every tracker fills the same fields.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./files.ts";

/** The launcher context file: what the issue-pickup skill reads. */
export interface ContextCache {
  identifier: string;
  title: string;
  description: string;
  branch_name: string;
  /** Seconds since the epoch; the skill trusts the file for 30 minutes. */
  cached_at: number;
  comments?: Array<{
    body: string;
    author_id: string | null;
    created_at?: string;
  }>;
  /** Set with `comments`: the skill counts the comments as read only then. */
  comments_cached?: true;
  sub_issue_ids?: string[];
  linked_issue_ids: string[];
}

/** What the tracker handed the launcher itself, without an API read. */
export interface FallbackEnvironment {
  /** The issue description. */
  prompt?: string | undefined;
  /** The suggested branch name. */
  branch?: string | undefined;
}

/** A cache from the launcher's own environment, for when the tracker cannot be read. */
export function fallbackCache(
  issueId: string,
  env: FallbackEnvironment,
  nowSeconds: number,
): ContextCache {
  return {
    identifier: issueId,
    title: "",
    description: env.prompt ?? "",
    branch_name: env.branch ?? "",
    cached_at: nowSeconds,
    linked_issue_ids: [],
  };
}

/**
 * An issue key as trackers write them (`ENG-123`). It names a file, so anything
 * that could leave the cache directory (a separator, `..`) is refused.
 */
const ISSUE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isIssueKey(issueId: string): boolean {
  return ISSUE_KEY.test(issueId);
}

export function assertIssueKey(issueId: string): void {
  if (!isIssueKey(issueId))
    throw new Error(
      `"${issueId}" is not an issue key (letters, digits, "-" and "_" only)`,
    );
}

/** Directory the launchers write and the issue-pickup skill reads. */
export function cacheDir(home: string): string {
  // The name is historical: it predates the second launcher and is shared by
  // every launcher so the skill needs no per-launcher branch.
  return join(home, ".cache", "conductor-linear");
}

export function cachePath(home: string, issueId: string): string {
  assertIssueKey(issueId);
  return join(cacheDir(home), `${issueId}.json`);
}

/**
 * Write the cache privately, because it holds issue bodies and comments: the
 * new file is mode 600 before any content is written, and replaces the old one
 * whole, so neither a reader nor a crash ever sees a partial file.
 */
export function writeCache(
  home: string,
  issueId: string,
  cache: ContextCache,
): string {
  const path = cachePath(home, issueId);
  mkdirSync(cacheDir(home), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, JSON.stringify(cache), 0o600);
  return path;
}
