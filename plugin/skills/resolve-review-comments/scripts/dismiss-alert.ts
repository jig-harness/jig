#!/usr/bin/env bun
/**
 * Dismiss the code scanning alert behind a code-scanning thread, with the
 * reason its outcome stands for (`lib/code-scanning.ts`). Prints the alert's
 * resulting state.
 *
 * Usage: bun dismiss-alert.ts <THREAD_NODE_ID> --outcome <rejected|wont-fix|deferred> [--used-in-tests] <<'EOF'
 *        why, in at most 280 characters
 *        EOF
 *   THREAD_NODE_ID = the `threadId` field from list-unresolved-threads.ts
 *   --outcome       the outcome already posted on the thread; `rejected`
 *                   dismisses as a false positive, `wont-fix` and `deferred`
 *                   as won't fix
 *   --used-in-tests with `rejected`: the finding is in code only tests run,
 *                   GitHub's `used in tests`
 *   The comment is read from stdin, never an argument, for the reason
 *   reply-to-thread.ts gives. GitHub stores it with the dismissal.
 *
 * The thread names the alert: its opening comment must be GitHub's code
 * scanning account's and carry one details link, to an alert of the pull
 * request's own repository, or the script refuses. The alert's state is read
 * from its instances at the pull request's current revision, so an alert
 * with no current instance there is refused too. Neither the thread nor the
 * alert is taken from the caller, so a reply cannot dismiss an alert some
 * other thread raised.
 *
 * Exit codes: 0 dismissed, or already dismissed; 1 a read or the dismissal
 * failed (GitHub answers 403 to a token that may not write security events),
 * or the alert's state on the pull request could not be established;
 * 2 usage, or not a code-scanning thread; 3 the alert is fixed or closed, so
 * the outcome is `accepted` or `moot`, not a dismissal; 5 the pull request is
 * no longer open.
 *
 * Precondition (skill invariant): the outcome reply is posted first, so the
 * dismissal is never the only trace of the decision.
 */

import { parseArgs as parseCli } from "node:util";
import { fail, readStdinAll, runMain } from "../../../shared/cli.ts";
import { decodeJson, isStringArray } from "../../../shared/guards.ts";
import {
  alertNumberOf,
  DISMISS_COMMENT_MAX,
  DISMISS_REASONS,
  isDismissOutcome,
  readAlert,
} from "./lib/code-scanning.ts";
import { ghOrExit } from "./lib/gh.ts";
import { assertThreadPrOpen } from "./lib/thread-liveness.ts";

const LABEL = "dismiss-alert";
const CLI = {
  options: {
    outcome: { type: "string" },
    "used-in-tests": { type: "boolean" },
  },
  allowPositionals: true,
  strict: true,
} as const;
const USAGE =
  "usage: dismiss-alert.ts <thread-node-id> --outcome <rejected|wont-fix|deferred> [--used-in-tests] < comment";

interface ThreadRead {
  owner: string;
  repo: string;
  pr: string;
  author: string;
  body: string;
}

/** The thread's repository, pull request and opening comment, as five strings. */
async function readThread(threadId: string): Promise<ThreadRead> {
  const raw = await ghOrExit(LABEL, [
    "api",
    "graphql",
    "-f",
    "query=query($id:ID!){ node(id:$id){ ... on PullRequestReviewThread { pullRequest { number repository { owner { login } name } } comments(first:1){ nodes{ author{ login } body } } } } }",
    "-f",
    `id=${threadId}`,
    "-q",
    '.data.node | [.pullRequest.repository.owner.login, .pullRequest.repository.name, (.pullRequest.number | tostring), .comments.nodes[0].author.login // "", .comments.nodes[0].body // ""] | @json',
  ]);
  let fields: string[] = [];
  try {
    fields = decodeJson(raw, isStringArray, `thread ${threadId}`);
  } catch {
    // Left empty: refused below.
  }
  const [owner = "", repo = "", pr = "", author = "", body = ""] = fields;
  if (owner === "" || repo === "" || !/^[0-9]+$/.test(pr)) {
    fail(1, `${LABEL}: ${threadId} is not a readable pull request thread`);
  }
  return { owner, repo, pr, author, body };
}

/** The thread id and outcome, or a usage refusal (exit 2). */
function parseArgs(args: string[]): { threadId: string; reason: string } {
  let parsed: ReturnType<typeof parseCli<typeof CLI>>;
  try {
    parsed = parseCli({ ...CLI, args });
  } catch {
    fail(2, USAGE);
  }
  const { outcome = "", "used-in-tests": usedInTests = false } = parsed.values;
  const [threadId = ""] = parsed.positionals;
  if (parsed.positionals.length !== 1 || !isDismissOutcome(outcome)) {
    fail(2, USAGE);
  }
  if (usedInTests && outcome !== "rejected") {
    fail(2, `${LABEL}: --used-in-tests goes with --outcome rejected`);
  }
  return {
    threadId,
    reason: usedInTests ? "used in tests" : DISMISS_REASONS[outcome],
  };
}

/** The dismissal comment from stdin, or a usage refusal (exit 2). */
async function readComment(): Promise<string> {
  const comment = (await readStdinAll()).trim();
  if (comment === "") {
    fail(2, `${LABEL}: the dismissal comment (stdin) is empty`);
  }
  if (comment.length > DISMISS_COMMENT_MAX) {
    fail(
      2,
      `${LABEL}: the dismissal comment is ${comment.length} characters; GitHub takes at most ${DISMISS_COMMENT_MAX}`,
    );
  }
  return comment;
}

/** The alert the thread raised, refused unless the thread is a code-scanning one. */
async function alertOf(threadId: string, thread: ThreadRead) {
  const number = alertNumberOf(
    thread.body,
    thread.author,
    thread.owner,
    thread.repo,
  );
  if (number === null) {
    fail(
      2,
      `${LABEL}: ${threadId} is not a code-scanning thread (its opening comment is not a code scanning alert of ${thread.owner}/${thread.repo})`,
    );
  }
  const alert = await readAlert(thread.owner, thread.repo, number, thread.pr);
  if (alert.unreadable !== undefined) {
    fail(
      1,
      `${LABEL}: code scanning alert ${number} could not be read (${alert.unreadable})`,
    );
  }
  if (alert.state === null) {
    fail(
      1,
      `${LABEL}: code scanning alert ${number}'s state on pull request #${thread.pr} is unknown: ${alert.stateUnknown ?? "no state"}`,
    );
  }
  return alert;
}

async function main(): Promise<number> {
  const { threadId, reason } = parseArgs(process.argv.slice(2));
  const comment = await readComment();
  const thread = await readThread(threadId);
  const alert = await alertOf(threadId, thread);
  if (alert.state === "dismissed") {
    process.stdout.write("dismissed\n");
    return 0;
  }
  if (alert.state !== "open") {
    fail(
      3,
      `${LABEL}: code scanning alert ${alert.number} is ${alert.state} on this pull request; a fixed alert's thread is accepted or moot, not dismissed`,
    );
  }

  await assertThreadPrOpen(LABEL, threadId);
  process.stdout.write(
    await ghOrExit(LABEL, [
      "api",
      "-X",
      "PATCH",
      `repos/${thread.owner}/${thread.repo}/code-scanning/alerts/${alert.number}`,
      "-f",
      "state=dismissed",
      "-f",
      `dismissed_reason=${reason}`,
      "-f",
      `dismissed_comment=${comment}`,
      "-q",
      ".state",
    ]),
  );
  return 0;
}

// Gated: the module's side effect is a mutation.
if (import.meta.main) runMain(LABEL, main);
