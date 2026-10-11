#!/usr/bin/env bun
/**
 * Fetch every comment on an issue through the consumer's tracker.
 *
 * Type: Discovery
 * Input: an issue key (e.g. ENG-123)
 * Output: JSON array of `{ body, createdAt }`, oldest first, which feeds
 *   straight into `select_scout_finding.ts --current-hash <hash>` on stdin.
 *
 * Usage:
 *     bun list_comments.ts <issue-key>
 *
 * Exit codes: 0 fetched (an empty array is a legitimate result), 2 usage,
 * 1 the tracker unavailable or its answer unusable. A partial comment list is
 * never printed: the scout-finding reuse check would read it as the whole
 * history.
 *
 * Runs under Bun and under Node ≥ 22.18 (type stripping).
 */

import { isEntryPoint, parseArgs } from "./lib/cli.ts";
import { openTracker } from "./lib/tracker/index.ts";
import type { IssueComment, Tracker } from "./lib/tracker/port.ts";

/** Every comment, or `null` (with the reason on stderr) when it cannot be read in full. */
export async function listComments(
  issueId: string,
  tracker: Tracker = openTracker(),
): Promise<IssueComment[] | null> {
  try {
    return (await tracker.listComments(issueId)).map((c) => ({
      body: c.body,
      createdAt: c.createdAt,
    }));
  } catch (err) {
    console.error(
      `could not read the comments of ${issueId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), {
    flags: [],
    values: [],
    usage: "usage: list_comments.ts <issue-key>",
  });
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }
  let tracker: Tracker;
  try {
    tracker = openTracker();
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const comments = await listComments(parsed.args.positional, tracker);
  if (comments === null) return 1;
  console.log(JSON.stringify(comments));
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
