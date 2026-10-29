#!/usr/bin/env bun
/**
 * Answer a review thread with a PROVISIONAL decision, resolve it and record
 * it, as one invocation: what the `wide` autonomy level does with a thread
 * the review arbiter rules `escalate` with the class `escalated` (no class
 * the human-in-the-loop registry reserves, no recorded human decision
 * behind it). Under any other level the same thread is parked. The class is
 * the arbiter's ruling, not the caller's claim: the ruling recorded for the
 * thread (`drive-state.ts rule`) must be `escalate` with the class
 * `escalated` and no person's decision behind it.
 *
 * A provisional decision is a reply outcome only (`rejected`, `wont-fix` or
 * `deferred`), never a fix, so it never grows the diff. Its reply carries
 * `**provisional**` right after the outcome token, a line saying how to
 * reverse it, and `PROVISIONAL_MARKER` as its last line;
 * `reconcile-replied-threads.ts`, `triage-thread.ts` and the round gate all
 * skip a thread that stands on one, so a person's reversal is never undone
 * by the next round. A person reverses it by commenting on the thread as an
 * owner, member or collaborator: the next round records the reversal and
 * parks the thread under `human-thread`. An unresolve alone reverses nothing.
 *
 * Self-reconciling like `triage-thread.ts`: a provisional reply already on
 * the thread is not posted again, and a decision already recorded for the
 * thread is not recorded again, so a retry after a crash completes only the
 * missing steps: with the outcome the reply posted, and whatever the level
 * is by then. The decision is recorded before the thread is resolved. A
 * reply a person commented after, or a later outcome superseded, is never
 * completed: the retry is refused.
 *
 * Usage:
 *   provisional-reply.ts <THREAD_NODE_ID> [PR] --class escalated --what "<one line>" <<'EOF'
 *   **wont-fix** — the retry budget is the configured one; raising it is a policy call.
 *   EOF
 *
 * Exit codes: 0 replied (or found replied), resolved and recorded; 1 a step
 * failed (the message names it; re-run to complete it); 2 usage or a body
 * whose outcome is not a reply outcome; 3 refused: the autonomy level is
 * not `wide` for a new reply, the class is one a person must decide, or
 * the reply already posted no longer stands.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentAutonomy } from "../../../shared/autonomy.ts";
import { fail, readStdinAll, runMain } from "./lib/cli.ts";
import { threadComments } from "./lib/driver/rearm.ts";
import {
  isProvisionalReply,
  PROVISIONAL_MARKER,
  PROVISIONAL_MARKER_PRODUCER_ENV,
  PROVISIONAL_OUTCOMES,
  PROVISIONAL_TOKEN,
  qualifyingOutcome,
} from "./lib/outcome.ts";
import { helperTimeoutSeconds, resolvePr, run, tsArgv } from "./lib/proc.ts";
import { standsOnProvisionalReply } from "./lib/provisional.ts";
import { TRUSTED_ASSOCIATIONS } from "./summary-findings.ts";

const here = dirname(fileURLToPath(import.meta.url));
const driveState = join(here, "drive-state.ts");
const rrc = join(here, "..", "..", "resolve-review-comments", "scripts");

/** The one class a provisional decision may answer: the arbiter's `escalated`. */
export const PROVISIONAL_CLASS = "escalated";

const USAGE =
  'usage: provisional-reply.ts <thread-node-id> [PR] --class escalated --what "<one line>"  (the reply body on stdin)';

interface Args {
  thread: string;
  pr: string;
  parkClass: string;
  what: string;
}

/** The value after `flag`, taken out of `argv`; `''` when absent. */
function takeFlag(argv: string[], flag: string): string {
  const at = argv.indexOf(flag);
  return at < 0 ? "" : (argv.splice(at, 2)[1] ?? "");
}

function parseArgs(argv: string[]): Args {
  const parkClass = takeFlag(argv, "--class");
  const what = takeFlag(argv, "--what");
  const [thread = "", pr = "", ...extra] = argv;
  const bad =
    extra.length > 0 ||
    [thread, pr].some((x) => x.startsWith("--")) ||
    thread === "" ||
    parkClass === "" ||
    what.trim() === "";
  if (bad) fail(2, USAGE);
  if (/[\n\r]/.test(what)) fail(2, "provisional-reply: --what is one line");
  return { thread, pr, parkClass, what };
}

/**
 * The reply as posted: the provisional token after the outcome token, the
 * line saying how to reverse it, and the marker as the last line.
 */
export function provisionalBody(body: string, parkClass: string): string {
  const q = qualifyingOutcome(body);
  if (q === null || !PROVISIONAL_OUTCOMES.has(q.outcome))
    fail(
      2,
      "provisional-reply: the body must open with a reply outcome, **rejected**, **wont-fix** or **deferred**, and a reason: a provisional decision never makes a fix.",
    );
  if (q.outcome === "deferred" && !/https?:\/\/\S+/.test(body))
    fail(
      2,
      "provisional-reply: a **deferred** reply links where the finding is tracked, as any deferral does: the follow-up issue's url, or the pull request's `## Deferred` section (defer-in-pr.ts prints its link).",
    );
  const [first = "", ...rest] = body.trimEnd().split("\n");
  const token = `**${q.outcome}**`;
  const opened = `${token} ${PROVISIONAL_TOKEN}${first.slice(token.length)}`;
  return [
    opened,
    ...rest,
    "",
    `_Provisional: decided without a person, at the \`wide\` autonomy level (class \`${parkClass}\`), because the merge is still a person's. To reverse it, comment on this thread as an owner, member or collaborator: the drive then parks it for you and never decides it again. Unresolving the thread alone does not reverse it._`,
    "",
    PROVISIONAL_MARKER,
  ].join("\n");
}

function refuseClass(a: Args): void {
  if (a.parkClass !== PROVISIONAL_CLASS)
    fail(
      3,
      `provisional-reply: the class '${a.parkClass}' is a person's to decide, and only '${PROVISIONAL_CLASS}' may be decided provisionally: park the thread under it (drive-state.ts park --class ${a.parkClass}).`,
    );
}

function refuseLevel(): void {
  const level = currentAutonomy().level;
  if (level !== "wide")
    fail(
      3,
      `provisional-reply: the autonomy level is ${level}, and only wide decides an escalation provisionally: park the thread under the class '${PROVISIONAL_CLASS}' instead.`,
    );
}

/**
 * The trusted provisional reply already on the thread, with the outcome it
 * posted; `null` for none. One a person commented after, or a later outcome
 * superseded, no longer stands, and recovering it would resolve the
 * person's thread over them: refused.
 */
async function existingReply(
  thread: string,
): Promise<{ url: string; outcome: string } | null> {
  const comments = await threadComments(thread);
  if (comments === null)
    fail(1, `provisional-reply: could not read thread ${thread}`);
  const found = comments.findLast(
    (c) =>
      TRUSTED_ASSOCIATIONS.has(c.association) && isProvisionalReply(c.body),
  );
  if (found === undefined) return null;
  const listed = comments.map((c) => ({
    authorAssociation: c.association,
    body: c.body,
  }));
  if (!standsOnProvisionalReply(listed))
    fail(
      3,
      `provisional-reply: the provisional reply on ${thread} (${found.url}) no longer stands: a person commented after it, or a later outcome superseded it. The round parks it under human-thread; it is never decided provisionally again.`,
    );
  return {
    url: found.url,
    outcome: qualifyingOutcome(found.body)?.outcome ?? "",
  };
}

async function post(thread: string, body: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "provisional-reply-"));
  const file = join(dir, "reply.md");
  try {
    writeFileSync(file, body);
    const r = await run(
      tsArgv(join(rrc, "reply-to-thread.ts"), [thread, "--body-file", file]),
      {
        timeoutSec: helperTimeoutSeconds(),
        stderr: "inherit",
        env: { ...process.env, [PROVISIONAL_MARKER_PRODUCER_ENV]: "1" },
      },
    );
    const url = r.stdout.trim();
    if (r.code !== 0 || url === "")
      fail(1, `provisional-reply: posting the reply failed (exit ${r.code})`);
    return url;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface StateView {
  decisions?: Array<{ key?: string }>;
  rulings?: Array<{
    key: string;
    verdict: string;
    class?: string;
    humanDecision: boolean;
  }>;
}

async function readState(pr: string): Promise<StateView> {
  const r = await run(tsArgv(driveState, ["get", pr]), {
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (r.code !== 0) fail(1, "provisional-reply: cannot read the drive state");
  return JSON.parse(r.stdout) as StateView;
}

/** Refuse unless the arbiter's recorded ruling on the thread admits a provisional decision. */
function requireRuling(state: StateView, thread: string): void {
  const ruling = (state.rulings ?? []).find((r) => r.key === thread);
  if (
    ruling?.verdict !== "escalate" ||
    ruling.class !== PROVISIONAL_CLASS ||
    ruling.humanDecision
  )
    fail(
      3,
      ruling === undefined
        ? `provisional-reply: no arbiter ruling is recorded for ${thread}; record it first (drive-state.ts rule), and decide provisionally only an escalate with the class '${PROVISIONAL_CLASS}'.`
        : `provisional-reply: the arbiter ruled '${ruling.verdict}'${ruling.class === undefined ? "" : ` with the class '${ruling.class}'`} on ${thread}, which a provisional decision may not take: act on that ruling, or park it under its class.`,
    );
}

/** The reply on the thread: the one already posted, or a new post at `wide`. */
async function replied(
  a: Args,
  body: string,
): Promise<{ url: string; outcome: string; posted: boolean }> {
  // A reply already posted is completed whatever the level is now: it was
  // posted at `wide`, and leaving it unrecorded would hide it from the
  // boundary sweep and the report. Its outcome is the one posted, never this
  // invocation's, which a retry may have changed.
  const existing = await existingReply(a.thread);
  if (existing !== null) return { ...existing, posted: true };
  refuseLevel();
  const url = await post(a.thread, body);
  return {
    url,
    outcome: qualifyingOutcome(body)?.outcome ?? "",
    posted: false,
  };
}

/** Record the decision, once: before the resolve, so a resolved reply always has a record. */
async function recordOnce(
  state: StateView,
  pr: string,
  a: Args,
  reply: { url: string; outcome: string; posted: boolean },
): Promise<void> {
  if ((state.decisions ?? []).some((d) => d.key === a.thread)) return;
  const record = await run(tsArgv(driveState, ["record-decision", pr]), {
    timeoutSec: helperTimeoutSeconds(),
    stdin: JSON.stringify({
      class: "provisional-reply",
      what: a.what,
      record: reply.url,
      reverse: "comment on the thread as an owner, member or collaborator",
      key: a.thread,
      outcome: reply.outcome,
      posted: reply.posted,
    }),
    stderr: "inherit",
  });
  if (record.code !== 0)
    fail(
      1,
      `provisional-reply: replied (${reply.url}), but recording the decision failed; re-run to finish`,
    );
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  const body = provisionalBody(await readStdinAll(), a.parkClass);
  refuseClass(a);
  const pr = await resolvePr(a.pr);
  const state = await readState(pr);
  requireRuling(state, a.thread);
  const reply = await replied(a, body);
  const url = reply.url;
  await recordOnce(state, pr, a, reply);
  const resolved = await run(
    tsArgv(join(rrc, "resolve-thread.ts"), [a.thread]),
    {
      timeoutSec: helperTimeoutSeconds(),
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  if (resolved.code !== 0)
    fail(
      1,
      `provisional-reply: replied (${url}) and recorded, but resolving the thread failed; re-run to finish`,
    );
  console.log(url);
  return 0;
}

if (import.meta.main) runMain("provisional-reply", main);
