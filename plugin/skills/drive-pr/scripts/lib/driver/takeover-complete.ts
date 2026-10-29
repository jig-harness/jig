/**
 * Finishing an admitted `--take-over` once this driver holds the locks
 * (`takeover.ts` decides it and stops the holder), and picking the drive up
 * from its durable state.
 *
 * The takeover runs `reconcile-replied-threads.ts` before the first triage,
 * carries the held batch over, and records itself in the drive state. A hold
 * stamped with its pushed fix is left to the round's ordinary resolve. A hold
 * of the previous driver with no such stamp is not verified as pushed, and is
 * reopened into the state the replied-thread sweep gives a reply it finds: a
 * thread is re-held unconfirmed (round -1) on the same reply, which
 * `claim-held` refuses until a pass confirms the fix with `drive-state.ts
 * hold` or supersedes the reply; a finding, whose answer is not posted yet, is
 * released and comes back unaddressed. Each reopen is read back from the held
 * batch: only one that took is recorded as reopened, and one that did not is
 * recorded and said apart. A failed reconciliation is said in the notice and
 * the record; the first gate's own sweep runs it again.
 */
import { helperTimeoutSeconds, run, tsArgv } from "./../proc.ts";

import { accountHash, resolveAccountIdentity } from "./../identity.ts";

import type { DriveState, HeldItem } from "./../state/schema.ts";

import { driveState, reconcileRepliedThreads } from "./paths.ts";

import { admitAnsweredParks, parseJson } from "./rearm.ts";

import { settleTakeover, type TakeoverPlan } from "./takeover.ts";

import { mirrorNow } from "./ledger.ts";

async function driveStateRun(
  args: string[],
  stdin?: string,
): Promise<{ code: number; stdout: string }> {
  return run(tsArgv(driveState, args), {
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
    ...(stdin === undefined ? {} : { stdin }),
  });
}

/** The held entry for `key`: `null` when absent, `"unreadable"` on failure. */
async function heldEntry(
  pr: string,
  key: string,
): Promise<HeldItem | null | "unreadable"> {
  const res = await driveStateRun(["held", pr]);
  const parsed =
    res.code === 0 ? parseJson(res.stdout, "drive-state.ts held") : null;
  if (!Array.isArray(parsed)) return "unreadable";
  return (parsed as HeldItem[]).find((h) => h?.key === key) ?? null;
}

/** One reopen's outcome: `line` is what the first pass is told. */
interface Reopen {
  key: string;
  ok: boolean;
  line: string;
}

/**
 * Reopen one hold not stamped as pushed, and confirm from the held batch that
 * it took. A thread with its reply's url is released only while it is still
 * that hold, then re-held unconfirmed on the same reply; anything else is
 * released.
 */
async function reopenHold(pr: string, item: HeldItem): Promise<Reopen> {
  const head = `- [${item.kind}] ${item.key} (was ${item.outcome}, round ${item.round})`;
  const done = (ok: boolean, what: string): Reopen => ({
    key: item.key,
    ok,
    line: `${head}: ${ok ? "" : "NOT reopened — "}${what}`,
  });
  const url = item.kind === "thread" ? item.commentUrl : undefined;
  const release = await driveStateRun([
    "release-held",
    pr,
    "--key",
    item.key,
    "--if-present",
    ...(url === undefined ? [] : ["--if-comment-url", url]),
  ]);
  if (release.code !== 0)
    return done(
      false,
      `release-held exited ${release.code}; it is held as it was`,
    );
  const left = await heldEntry(pr, item.key);
  if (left === "unreadable")
    return done(false, "the held batch could not be read back");
  const [ok, what] =
    url === undefined
      ? releasedVerdict(item, left)
      : await reheldVerdict(pr, item, url, left);
  return done(ok, what);
}

/** Whether a hold with no reply url was released, as the held batch shows. */
function releasedVerdict(
  item: HeldItem,
  left: HeldItem | null,
): [boolean, string] {
  if (left !== null) return [false, "it is still held after the release"];
  return [
    true,
    item.kind === "finding"
      ? "released; it comes back unaddressed — triage it afresh"
      : "released; the gate's sweep re-holds it unconfirmed from its last qualifying reply",
  ];
}

/** Re-hold a released thread unconfirmed on its reply, and say what took. */
async function reheldVerdict(
  pr: string,
  item: HeldItem,
  url: string,
  left: HeldItem | null,
): Promise<[boolean, string]> {
  if (left !== null && left.commentUrl !== url)
    return [
      false,
      `it is now held for another reply (${left.commentUrl ?? "no url"}); left as it is`,
    ];
  if (left !== null && left.round !== -1)
    return [false, "the release did not take; it is held as it was"];
  if (left === null && !(await reholdUnconfirmed(pr, item, url)))
    return [
      false,
      "it was released, but re-holding it unconfirmed did not take; the gate's sweep re-holds it from its reply",
    ];
  return [
    true,
    `re-held unconfirmed on ${url}; once the fix is in the tree, confirm it with \`drive-state.ts hold ${pr} --key ${item.key} --kind thread --outcome ${item.outcome} --comment-url ${url}\``,
  ];
}

/** Re-hold a released thread unconfirmed on `url`, as the sweep would. */
async function reholdUnconfirmed(
  pr: string,
  item: HeldItem,
  url: string,
): Promise<boolean> {
  const held = await driveStateRun([
    "hold",
    pr,
    "--key",
    item.key,
    "--kind",
    "thread",
    "--outcome",
    item.outcome,
    "--unconfirmed",
    "--comment-url",
    url,
  ]);
  const now = await heldEntry(pr, item.key);
  return (
    held.code === 0 &&
    now !== "unreadable" &&
    now?.commentUrl === url &&
    now.round === -1
  );
}

/**
 * Finish an admitted takeover: reconcile, carry the held batch over, record.
 * Returns the notice the first passes read in `$DRIVE_PR_PASS_NOTICE`.
 */
export async function completeTakeover(
  pr: string,
  plan: TakeoverPlan,
  agent: string[],
  botsOnly: boolean,
): Promise<string> {
  const reconcile = await run(
    tsArgv(reconcileRepliedThreads, [pr, ...(botsOnly ? ["--bots-only"] : [])]),
    { stdout: "pipe", stderr: "inherit", timeoutSec: helperTimeoutSeconds() },
  );
  const reconciled = reconcile.code === 0;
  console.error(
    `takeover: ran reconcile-replied-threads.ts before the first triage (exit ${reconcile.code}${reconciled ? "" : "; the first gate's own sweep runs it again"}).`,
  );
  const unverified = plan.held.filter(
    (h) =>
      h.verifiedSha === undefined &&
      (plan.fromActor === null || h.actor === plan.fromActor),
  );
  const results: Reopen[] = [];
  for (const item of unverified) results.push(await reopenHold(pr, item));
  const reopened = results.filter((r) => r.ok);
  const notReopened = results.filter((r) => !r.ok);
  const toAccount = accountHash(resolveAccountIdentity(agent));
  const record = await driveStateRun(
    ["takeover", pr],
    JSON.stringify({
      fromActor: plan.fromActor,
      fromAccount: plan.fromAccount,
      toAccount,
      verdict: plan.verdict,
      reopened: reopened.map((r) => r.key),
      ...(notReopened.length > 0
        ? { reopenFailed: notReopened.map((r) => r.key) }
        : {}),
      reconciled,
    }),
  );
  settleTakeover();
  console.error(
    record.code === 0
      ? `takeover: recorded in the drive state (from ${plan.fromActor ?? "an unnamed tree"}, account ${plan.fromAccount ?? "unknown"}, to account ${toAccount ?? "unknown"}, verdict ${plan.verdict}, ${reopened.length} hold(s) reopened, ${notReopened.length} not).`
      : `takeover: could not record the takeover (drive-state.ts exited ${record.code}); driving on.`,
  );
  const from = {
    WEDGED: "a wedged driver",
    DEAD: "a dead driver",
    STALE:
      "another clone's driver whose ledger heartbeat was past the lease window",
  }[plan.verdict];
  const notice = [
    `TAKEN OVER: this drive was taken over from ${from} and resumes at its durable round.`,
  ];
  if (!reconciled)
    notice.push(
      `reconcile-replied-threads.ts FAILED before this pass (exit ${reconcile.code}); the gate's sweep runs it again, so read each thread's last reply before triaging it.`,
    );
  if (reopened.length > 0)
    notice.push(
      "These holds' promised fixes are not verified as pushed, and they are reopened. A re-held thread stays unconfirmed (claim-held refuses it) until you read its anchored code: make the promised fix if it is missing, then confirm it with the command shown; or, if the finding no longer stands, supersede the reply with a fresh outcome. A released finding is triaged afresh:",
      ...reopened.map((r) => r.line),
    );
  if (notReopened.length > 0)
    notice.push(
      "These holds' promised fixes are not verified as pushed, but they could NOT be reopened; check each in the held batch (drive-state.ts held) before triaging it:",
      ...notReopened.map((r) => r.line),
    );
  if (results.length === 0)
    notice.push("No held item was left without a verified push.");
  return notice.join("\n");
}

/**
 * Pick the drive up once this driver holds the locks: finish an admitted
 * takeover and unpark items a person has answered. Returns the notice the
 * first passes carry (`''` for none).
 */
export async function pickUpDrive(
  pr: string,
  plan: TakeoverPlan | null,
  state: DriveState,
  opts: { agent: string[]; botsOnly: boolean; dryRun: boolean },
): Promise<string> {
  const takeover =
    plan === null
      ? ""
      : await completeTakeover(pr, plan, opts.agent, opts.botsOnly);
  // A takeover is written to the drive ledger at once, not at the next boundary.
  if (plan !== null) await mirrorNow(pr);
  const notices = [takeover, await admitAnsweredParks(state, opts.dryRun)];
  return notices.filter((part) => part !== "").join("\n\n");
}
