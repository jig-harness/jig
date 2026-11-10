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
 * tick re-arms on. Every message carries the cause or the question, the
 * pull request's link and where its handoff is; the notify step adds the
 * workspaces the stage ran in, since the message goes to the repository's
 * one destination rather than to them.
 */
import { uniqueLogins } from "../../shared/forge-logins.ts";
import { createHash } from "node:crypto";
import { shellQuote } from "../../shared/cli.ts";
import type { DrivenPr, Notice, RepoReport, WaitingPark } from "./types.ts";

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

/** Text with the key line's opening broken, so quoted text never reads as a message of its own. */
function unTagged(text: string): string {
  return text.replaceAll(TAG, "[jig dispatch - ");
}

/** A message: its key, reserved priority lines, bounded detail, and its uncut tail. */
function notice(
  fullKey: string,
  lines: string[],
  tail: string[] = [],
  priority: string[] = [],
): Notice {
  const key = boundedKey(fullKey);
  const head = keyLine(key);
  const body = unTagged(lines.join("\n"));
  const start =
    priority.length === 0 ? "" : `\n${unTagged(priority.join("\n"))}`;
  const end = tail.length === 0 ? "" : `\n${unTagged(tail.join("\n"))}`;
  const room = MAX_TEXT - head.length - start.length - 1 - end.length;
  return {
    key,
    text: `${head}${start}\n${body.length > room ? `${body.slice(0, Math.max(0, room - 1))}…` : body}${end}`,
  };
}

function compact(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** Disputes stay ahead of large decisions, within a fixed part of the message budget. */
function disputeSummary(waiting: readonly WaitingPark[]): string[] {
  const disputed = waiting.filter((p) => (p.disputed ?? []).length > 0);
  if (disputed.length === 0) return [];
  const lines = ["Disputed answers: these people must settle the decisions."];
  let shown = 0;
  for (const park of disputed) {
    const answers = park.disputed ?? [];
    const people = answers
      .slice(0, 2)
      .map(
        (a) =>
          `@${compact(a.author, 40)}: ${a.choice === undefined ? `free answer: ${compact(a.body, 60)}` : `chose ${compact(a.choice.option, 60)}${a.choice.note === undefined ? "" : `; note: ${compact(a.choice.note, 40)}`}`}`,
      );
    const line = `${compact(park.key, 80)} — ${people.join("; ")}${answers.length > 2 ? `; ${answers.length - 2} more answers on the pull request` : ""}`;
    // Leave room for the count of omitted decisions and its link to the full record.
    if (lines.join("\n").length + line.length + 1 > 900) break;
    lines.push(line);
    shown += 1;
  }
  if (shown < disputed.length)
    lines.push(
      `${disputed.length - shown} more disputed decisions; read their answers on the pull request.`,
    );
  return lines;
}

/** The ledger generation a drive's evidence carries. */
function generation(pr: DrivenPr): string {
  return String(pr.evidence.generation ?? "unknown");
}

/** Reserve recipient names independently of decision text, with a link for overflow. */
function recipientLines(pr: DrivenPr): string[] {
  const people = uniqueLogins(
    (pr.waiting ?? []).flatMap((p) =>
      p.person === undefined ? [] : [p.person],
    ),
  );
  if (people.length === 0) return [];
  const shown: string[] = [];
  let length = 0;
  for (const person of people) {
    if (length + person.length + 3 > 1000) break;
    shown.push(`@${person}`);
    length += person.length + 3;
  }
  const omitted = people.length - shown.length;
  return [
    `Recipients: ${shown.join(", ")}${omitted ? `; ${omitted} more in the drive's ledger` : ""}`,
  ];
}

/** A drive parked with decisions unanswered: the framed decisions, and how to answer them, and the conflict with its base its re-drive left. */
export function parkNotice(slug: string, pr: DrivenPr): Notice {
  const waiting = pr.waiting ?? [];
  const keys = waiting.map((p) => `${p.kind} ${p.key}`).join(", ");
  const disputes = waiting
    .flatMap((p) =>
      (p.disputed ?? []).map(
        (a) =>
          `${p.key}:${a.author}:${a.at}:${a.url}:${a.bodyHash ?? createHash("sha256").update(a.body).digest("hex")}`,
      ),
    )
    .sort((a, b) => a.localeCompare(b));
  const disputeKey =
    disputes.length === 0
      ? ""
      : `, disputed ${createHash("sha256").update(disputes.join("\n")).digest("hex").slice(0, 16)}`;
  // A park is read beside its base only while its pull request conflicts.
  const conflict =
    pr.evidence.mergeable === "CONFLICTING"
      ? [
          `It also conflicts with its base, which the dispatcher's re-drive did not resolve: ${pr.why}. Merge its base in, or settle the conflict on the pull request if it needs a decision (see the drive's handoff).`,
          "",
        ]
      : [];
  return notice(
    `${slug} PR #${pr.number} parked, ledger generation ${generation(pr)}: ${keys}${disputeKey}${conflict.length === 0 ? "" : `, conflicting head ${pr.evidence.headSha ?? "unknown"}, base ${pr.evidence.baseSha ?? "unknown"}`}`,
    [
      `PR #${pr.number} (${pr.title}) is parked: ${waiting.length === 1 ? "one decision waits" : `${waiting.length} decisions wait`} for a person.`,
      "",
      ...conflict,
      ...waiting.flatMap((p) => [
        ...(p.person === undefined ? [] : [`Waiting on @${p.person}:`]),
        ...((p.disputed ?? []).length === 0
          ? []
          : [
              "Disputed: these people's latest answers disagree; they must settle the decision.",
              ...(p.disputed ?? []).map(
                (a) =>
                  `@${a.author}: ${a.choice === undefined ? `free answer: ${a.body.slice(0, 500)}${a.body.length > 500 ? "…" : ""}` : `chose ${a.choice.option}`}${a.choice?.note === undefined ? "" : `; note: ${a.choice.note}`} — ${a.url}`,
              ),
            ]),
        ...p.lines,
        "",
      ]),
    ],
    [
      ...recipientLines(pr),
      "Answer each on the pull request, in a comment with a line `answer <key>: …` (or on its thread). Once every one is answered, the next tick re-arms the drive. A decision above that is cut off is framed in full in the drive's ledger comment on the pull request.",
      pr.url,
    ],
    disputeSummary(waiting),
  );
}

/** A drive stopped on an exit only a person settles, or with no exit at all. */
export function stopNotice(slug: string, pr: DrivenPr): Notice {
  if (pr.class === "silent")
    return notice(
      `${slug} PR #${pr.number} silent, ledger generation ${generation(pr)}, started ${String(pr.evidence.started ?? "unknown")}`,
      [
        `PR #${pr.number} (${pr.title}): its drive heartbeat expired and its termination cannot be confirmed. ${pr.why}.`,
        "Inspect the driver and any surviving pass before re-arming it. Read the drive handoff in its workspace.",
        pr.url,
      ],
    );
  const exit = pr.evidence.exit;
  const stop =
    exit === null || exit === undefined ? "with no exit" : `${String(exit)}`;
  return notice(
    `${slug} PR #${pr.number} stopped ${stop}, ledger generation ${generation(pr)}`,
    [
      `PR #${pr.number} (${pr.title}): its drive stopped ${stop}, which only a person settles. ${pr.why}.`,
      `Read the drive's handoff, \`.context/pr-drive-${pr.number}.md\` in the workspace that drove it (named below while it is open), then run \`/jig:drive-pr ${pr.number}\` there to re-arm it, or stop it. Where dispatch labels are enabled, you can instead use \`jig send drive@${slug}#${pr.number} rearm\`.`,
      pr.url,
    ],
  );
}

/**
 * A pull request that entered Ready to merge, merge now or approve first:
 * the repository, its number and its lane, no text a record holds. Keyed by
 * the pull request and the head the drive verified, so it is sent once per
 * head: a move between the lanes, or a re-entry at the same head, sends
 * nothing more.
 */
export function readyNotice(
  slug: string,
  card: {
    number: number;
    url: string;
    head: string;
    lane: "merge-now" | "approve-first";
    requested: string[];
  },
): Notice {
  const line =
    card.lane === "merge-now"
      ? `Ready to merge in ${slug}: PR #${card.number}. Its merge command, pinned to the verified head, is in \`jig ask drive@${slug}#${card.number}\`.`
      : `Ready to merge in ${slug} once approved: PR #${card.number}. An approval is still required${card.requested.length === 0 ? ", and nobody is asked" : ""}; the repository's other protection rules are not read.`;
  return notice(
    `${slug} PR #${card.number} ready at ${card.head}`,
    [line],
    [card.url],
  );
}

/** A follow-up the tick started that failed, stopped on a question for a person (`question`), or whose record and outcome are gone. */
export function followupFailedNotice(
  slug: string,
  pr: { number: number; url: string },
  marker: number,
  why: string,
  question: string | null = null,
): Notice {
  return notice(`${slug} PR #${pr.number} follow-up failed, marker ${marker}`, [
    question === null
      ? `The follow-up of merged PR #${pr.number} failed: ${why}.`
      : `The follow-up of merged PR #${pr.number} stopped on a question for a person: ${question}`,
    "Delete its marker comment on the pull request: the marker holds the claim, so a run by hand stops behind it. Then run the follow-up by hand, or leave it for the next tick to start again. The tick never starts it again by itself.",
    pr.url,
  ]);
}

/** A follow-up claim that went stale after the tick released an earlier one on the pull request: a person settles it. */
export function staleClaimNotice(
  slug: string,
  pr: { number: number; url: string },
  claim: {
    marker: number;
    claimant: string;
    age: string;
    manual: boolean;
    earlier: { marker: number; claimant: string; releasedAt: string | null };
  },
): Notice {
  const { earlier } = claim;
  const when = earlier.releasedAt === null ? "" : ` at ${earlier.releasedAt}`;
  return notice(
    `${slug} PR #${pr.number} follow-up claim stale, marker ${claim.marker}`,
    [
      `The follow-up of merged PR #${pr.number} is held by a claim nobody is finishing: ${claim.claimant} claimed it ${claim.age} ago (marker comment ${claim.marker}), has not marked it done, and no session is joined to it.`,
      `The tick released an earlier stale claim on it once (marker comment ${earlier.marker}, ${earlier.claimant}'s)${when}, and does not release a second.`,
      claim.manual
        ? `Mark the marker done when that run succeeded (\`jig dispatch marker done ${pr.number} --comment ${claim.marker}\`), or delete it to have the follow-up start again.`
        : "Have the originating host record that run's result through jig dispatch result with its record and token, or delete the marker comment to have the follow-up start again.",
      pr.url,
    ],
  );
}

/** A pending launch record no tick will launch again (`stuck-launches.ts`): a person checks for a session it started, then clears it. */
export function stuckNotice(
  slug: string,
  stuck: {
    target: string;
    action: string;
    record: string;
    account: string;
    workspace: string | null;
    marker: number | null;
    url: string | null;
    why: string;
  },
): Notice {
  const where =
    stuck.workspace === null ? "" : ` in its workspace (${stuck.workspace})`;
  return notice(
    `${slug} ${stuck.target} launch record ${stuck.record} stuck pending`,
    [
      `${stuck.target}: the ${stuck.action} launch record ${stuck.record} is pending and no tick launches it again: ${stuck.why}. It holds its stage and a slot of account ${stuck.account} until a person clears it.`,
      `Look for a session it started${where}; once none runs for it, run \`jig dispatch clear ${stuck.record}\`.`,
      ...(stuck.marker === null
        ? []
        : [
            `Its follow-up marker (comment ${stuck.marker}) stays on the pull request, and once the record is cleared it reads as a failed follow-up: delete the marker to have the follow-up start again.`,
          ]),
      ...(stuck.url === null ? [] : [stuck.url]),
    ],
  );
}

/** A cause a pickup raises (a stalled pickup, a double claim, a session waiting), in the plan's own words. */
export function pickupNotice(
  slug: string,
  key: string,
  reason: string,
): Notice {
  return notice(`${slug} ${key}`, [`${slug}: ${reason}.`]);
}

/** The words every busy-holder key carries after its repository and target, so a suppression record can be told for one. */
export const HOLDER_KEY_MARK = " branch held by busy checkout ";

/**
 * A launch refused because a checkout the runtime does not list holds its
 * branch and is in use: where that checkout is, what keeps it busy, and how
 * a person frees the branch. Keyed by the target, the branch and the
 * checkout's path, so it is sent once per holder whatever its reasons.
 */
export function holderNotice(
  slug: string,
  busy: {
    target: string;
    stage: string;
    path: string;
    branch: string;
    reasons: string[];
    url: string | null;
  },
): Notice {
  return notice(
    `${slug} ${busy.target}${HOLDER_KEY_MARK}${busy.branch} at ${busy.path}`,
    [
      `${busy.target}: the ${busy.stage} cannot open a workspace on ${busy.branch}, because the checkout at ${busy.path}, which the workspace runtime does not list, has that branch checked out and is in use: ${busy.reasons.join("; ")}.`,
      `Once nothing keeps it busy, the next tick detaches it at its commit and opens the workspace. To free the branch yourself, finish or save the work there (commit and push it, or discard it) and end what runs in it, then run \`git -C ${shellQuote(busy.path)} switch --detach\`, or remove it with \`git worktree remove ${shellQuote(busy.path)}\`.`,
    ],
    busy.url === null ? [] : [busy.url],
  );
}

/** Absence of a cause proves nothing when its target was not observed in scope. */
export function unobservedTarget(report: RepoReport, target: string): boolean {
  return (
    report.unplaced.some((u) => u.target === target) ||
    (report.withheld ?? []).includes(target) ||
    // A converged pull request whose place the board read could not tell: its `ready` notice is not settled.
    (report.board?.pending ?? []).some((n) => target === `PR #${n}`) ||
    (report.inScope !== undefined &&
      /^PR #\d+$/.test(target) &&
      !report.inScope.some((n) => target === `PR #${n}`))
  );
}

/** A failure the ledger counted past `failures.notify_after` (`failure-notices.ts`): what failed, how often, since when, the last reason. */
export function failingNotice(
  slug: string,
  key: string,
  lines: string[],
): Notice {
  return notice(`${slug} ${key}`, lines);
}
