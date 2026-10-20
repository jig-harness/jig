#!/usr/bin/env bun
/**
 * Record the conflicts of the operation that has just concluded: one
 * `merge_conflict` event per conflicted path, appended to
 * `$(git rev-parse --git-common-dir)/jig/conflict-events.jsonl`, which every
 * worktree of the clone shares and nothing commits. Run it after the commit
 * (merge, cherry-pick, revert) or after `git rebase --continue`; recording the
 * same operation again adds nothing, and `conflict-map.ts` records an
 * operation a later map would otherwise overwrite.
 *
 * Usage: bun events.ts [--json]
 *
 * Exit codes: 0 recorded, already recorded, or nothing to record (no
 * snapshot, or an operation that did not conclude: aborted or skipped); 1 the
 * record could not be written (the conclusion stands); 2 usage error or not
 * inside a git work tree; 3 the operation the snapshot describes is still in
 * progress (conclude it first).
 */
import { fail, runMain } from "../../../shared/cli.ts";
import { recordConcluded } from "./lib/events.ts";
import { topLevel } from "./lib/git.ts";
import { NoOperation, detectOperation } from "./lib/operation.ts";
import { loadSnapshot, sameOperation } from "./lib/snapshot.ts";

const USAGE = "usage: events.ts [--json]";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--json")) fail(2, USAGE);
  const json = args.length > 0;
  const root = topLevel();
  if (root === null) fail(2, "events: not inside a git work tree.");
  let snapshot: ReturnType<typeof loadSnapshot>;
  try {
    snapshot = loadSnapshot(root);
  } catch (err) {
    return fail(
      1,
      `events: the conflict snapshot is unreadable: ${err instanceof Error ? err.message : err}. The conclusion stands; no events were recorded.`,
    );
  }
  const say = (message: string, detail: object = {}) =>
    console.log(json ? JSON.stringify({ message, ...detail }) : message);
  if (snapshot === null) {
    say("no conflict snapshot: nothing to record");
    return 0;
  }
  try {
    if (sameOperation(snapshot, detectOperation(root)))
      fail(3, "events: the operation is still in progress; conclude it first.");
  } catch (err) {
    if (!(err instanceof NoOperation)) throw err;
  }
  try {
    const done = recordConcluded(root, snapshot);
    if (done.commit === null)
      say(
        "the snapshot's operation did not conclude (aborted, skipped or not yet committed): nothing recorded",
        done,
      );
    else
      say(
        `recorded ${done.written} merge_conflict event${done.written === 1 ? "" : "s"} for ${done.commit.slice(0, 12)}${done.skipped > 0 ? ` (${done.skipped} already recorded)` : ""} in ${done.file}`,
        done,
      );
    return 0;
  } catch (err) {
    return fail(
      1,
      `events: the live record could not be written: ${err instanceof Error ? err.message : err}. The conclusion stands.`,
    );
  }
}

if (import.meta.main) runMain("events", main);
