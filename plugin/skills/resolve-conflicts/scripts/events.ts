#!/usr/bin/env bun
/**
 * Record the conflicts of the operation that has just concluded: one
 * `merge_conflict` event per conflicted path, appended to
 * `$(git rev-parse --git-common-dir)/jig/conflict-events.jsonl`, which every
 * worktree of the clone shares and nothing commits. Run it after the commit
 * (merge, cherry-pick, revert) or after `git rebase --continue`; recording the
 * same operation again adds nothing, and `conflict-map.ts` records an
 * operation a later map would otherwise overwrite. It also records the
 * snapshots `conflict-map.ts` kept as pending because the record could not be
 * written then, before reading the current snapshot, so an unreadable one
 * does not hold them back; one that still cannot be recorded stays pending
 * and makes the exit 1.
 *
 * Usage: bun events.ts [--json]
 *
 * Exit codes: 0 recorded, already recorded, or nothing to record (no
 * snapshot, or an operation that did not conclude: aborted or skipped); 1 the
 * record could not be written or the current snapshot is unreadable (the
 * conclusion stands); 2 usage error or not
 * inside a git work tree; 3 the operation the snapshot describes is still in
 * progress (conclude it first).
 */
import { fail, runMain } from "../../../shared/cli.ts";
import { flushPending, recordConcluded } from "./lib/events.ts";
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
  const say = (message: string, detail: object = {}) =>
    console.log(json ? JSON.stringify({ message, ...detail }) : message);
  const pending = recordPending(root, say);
  let snapshot: ReturnType<typeof loadSnapshot>;
  try {
    snapshot = loadSnapshot(root);
  } catch (err) {
    return fail(
      1,
      `events: the conflict snapshot is unreadable: ${err instanceof Error ? err.message : err}. The conclusion stands; no events were recorded for its operation.`,
    );
  }
  if (snapshot === null) {
    say("no conflict snapshot: nothing to record");
    return pending;
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
    return pending;
  } catch (err) {
    return fail(
      1,
      `events: the live record could not be written: ${err instanceof Error ? err.message : err}. The conclusion stands.`,
    );
  }
}

/** Record the pending snapshots; 1 when one still cannot be recorded. */
function recordPending(
  root: string,
  say: (message: string, detail?: object) => void,
): number {
  let status = 0;
  for (const { file, result } of flushPending(root)) {
    if ("error" in result) {
      status = 1;
      console.error(
        `events: the pending snapshot ${file} is still not recorded: ${result.error}`,
      );
    } else if ("waiting" in result || result.commit === null)
      say(
        `pending snapshot ${file}: the commit its operation concluded with is not found above HEAD; kept pending`,
        result,
      );
    else
      say(
        `pending snapshot ${file}: recorded ${result.written} merge_conflict event${result.written === 1 ? "" : "s"} for ${result.commit.slice(0, 12)}`,
        result,
      );
  }
  return status;
}

if (import.meta.main) runMain("events", main);
