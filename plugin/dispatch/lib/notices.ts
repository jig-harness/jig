/**
 * The messages a tick sends a person, one per cause. Each message opens
 * with its key line, `[jig dispatch: <key>]`, where the key names the facts
 * its suppression record is keyed by (the repository, the pull request or
 * item, and the ledger generation, exit, park, marker or record that make
 * the cause): a read of the target's comment then shows whether the
 * message arrived, and a cause whose facts change is a new message.
 *
 * A park's message is the drive's own framed decision for every parked
 * item still unanswered, and how to answer it: a comment on the pull
 * request with a line `answer <key>: …`, which the drive reads and the next
 * tick re-arms on.
 */
import { createHash } from "node:crypto";
import type { DrivenPr, Notice } from "./types.ts";

const TAG = "[jig dispatch: ";

/** The most characters one message holds; its key line always stays. */
const MAX_TEXT = 4000;

/** The line that names a message's key. */
function keyLine(key: string): string {
  return `${TAG}${key}]`;
}

/** Whether a workspace's comment carries the message whose key is `key`. */
export function carries(comment: string, key: string): boolean {
  return comment.includes(keyLine(key));
}

/** Whether a workspace's comment holds any message of the dispatcher's. */
export function holdsNotice(comment: string): boolean {
  return comment.includes(TAG);
}

/** The longest key a message carries whole; a longer one is cut and ends in a digest of all of it, so two keys stay two. */
const MAX_KEY = 200;

/** The key as the message names it: whole when short, else its start and a digest of the whole. */
function boundedKey(key: string): string {
  if (key.length <= MAX_KEY) return key;
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `${key.slice(0, MAX_KEY - digest.length - 2)}… ${digest}`;
}

/** A message: its key line, then its lines, cut to `MAX_TEXT`; the `tail` lines are never cut. */
function notice(fullKey: string, lines: string[], tail: string[] = []): Notice {
  const key = boundedKey(fullKey);
  const head = keyLine(key);
  const body = lines.join("\n");
  const end = tail.length === 0 ? "" : `\n${tail.join("\n")}`;
  const room = MAX_TEXT - head.length - 1 - end.length;
  return {
    key,
    text: `${head}\n${body.length > room ? `${body.slice(0, Math.max(0, room - 1))}…` : body}${end}`,
  };
}

/** The ledger generation a drive's evidence carries. */
function generation(pr: DrivenPr): string {
  return String(pr.evidence.generation ?? "unknown");
}

/** A drive parked with decisions unanswered: the framed decisions, and how to answer them. */
export function parkNotice(slug: string, pr: DrivenPr): Notice {
  const waiting = pr.waiting ?? [];
  const keys = waiting.map((p) => `${p.kind} ${p.key}`).join(", ");
  return notice(
    `${slug} PR #${pr.number} parked, ledger generation ${generation(pr)}: ${keys}`,
    [
      `PR #${pr.number} (${pr.title}) is parked: ${waiting.length === 1 ? "one decision waits" : `${waiting.length} decisions wait`} for a person.`,
      "",
      ...waiting.flatMap((p) => [...p.lines, ""]),
    ],
    [
      "Answer each on the pull request, in a comment with a line `answer <key>: …` (or on its thread). Once every one is answered, the next tick re-arms the drive. A decision above that is cut off is framed in full in the drive's ledger comment on the pull request.",
      pr.url,
    ],
  );
}

/** A drive stopped on an exit only a person settles, or with no exit at all. */
export function stopNotice(slug: string, pr: DrivenPr): Notice {
  const exit = pr.evidence.exit;
  const stop =
    exit === null || exit === undefined ? "with no exit" : `${String(exit)}`;
  return notice(
    `${slug} PR #${pr.number} stopped ${stop}, ledger generation ${generation(pr)}`,
    [
      `PR #${pr.number} (${pr.title}): its drive stopped ${stop}, which only a person settles. ${pr.why}.`,
      "Read the drive's handoff (`.context/pr-drive-<PR>.md` in the workspace that drove it), then re-arm it or stop it.",
      pr.url,
    ],
  );
}

/** A follow-up the tick started that failed, or whose record and outcome are gone. */
export function followupFailedNotice(
  slug: string,
  pr: { number: number; url: string },
  marker: number,
  why: string,
): Notice {
  return notice(`${slug} PR #${pr.number} follow-up failed, marker ${marker}`, [
    `The follow-up of merged PR #${pr.number} failed: ${why}.`,
    "Delete its marker comment on the pull request: the marker holds the claim, so a run by hand stops behind it. Then run the follow-up by hand, or leave it for the next tick to start again. The tick never starts it again by itself.",
    pr.url,
  ]);
}

/** A cause a pickup raises (a stalled pickup, a double claim, a session waiting), in the plan's own words. */
export function pickupNotice(
  slug: string,
  key: string,
  reason: string,
): Notice {
  return notice(`${slug} ${key}`, [`${slug}: ${reason}.`]);
}
