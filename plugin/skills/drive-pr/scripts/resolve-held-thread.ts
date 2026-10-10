#!/usr/bin/env bun
/**
 * Resolve a HELD thread — one replied to with `accepted`/`moot` and recorded
 * via `drive-state.ts hold`, now waiting on the push its reply promised
 * (SKILL.md § 6). `resolve-thread.ts`'s mutation is unconditional: given a
 * thread id, it resolves it, with no notion of WHICH push justifies that
 *.
 *
 * `kind: finding` has a live-head/clean-HEAD check of its own
 * (`answer-summary-finding.ts --pushed-sha`), but that is a weaker property
 * than it looks — any current pushed HEAD satisfies it, including a concurrent
 * driver's. Both kinds now get the same per-hold provenance check inside
 * `claim-held`; `kind: thread` had no equivalent at all before this
 * wrapper — a later round could resolve a thread held several rounds ago even
 * though the push it is resolving against never carried the promised fix (a
 * crash, an unrelated intervening push, or simply a stale held entry picked
 * back up). SKILL.md § 6 calls this instead of `resolve-thread.ts` directly for
 * anything in the held batch.
 *
 * "The current push carries the promised fix" is TWO checks, not one, and
 * both are enforced atomically by `drive-state.ts claim-held` (review round
 * 2):
 *
 *   1. The ROUND `hold` recorded (SKILL.md § 3, at reply time) must still be
 *      the CURRENT round. `hold` always stamps `round: .rounds` — the round of
 *      the head under review when the reply was posted. `bump-round` advances
 *      `.rounds` at a gate call that hits `ROUND_READY` (drive-status.ts's own
 *      exit 0) — normally only the NEXT round's step 1 gate, for a genuinely
 *      new API head.
 *
 *   2. The HELD ITEM's OWN `verifiedSha` — written by exactly ONE call site,
 *      `drive-state.ts stamp-held`, called from SKILL.md § 6 immediately
 *      after a real `guarded-push.ts`, and stamped only onto the holds the
 *      CALLING working tree created — must equal `--pushed-sha`.
 *
 * Round equality ALONE is not enough: it advances only when a COUNTING
 * drive-status.ts gate runs, and SKILL.md § 6's own post-push status wait
 * passes `--no-count` for exactly this reason (the held threads it is polling
 * for are, by definition, still open on GitHub at that point, so a counting
 * call there would bump `.rounds` for the head just pushed INSIDE the very
 * step that calls this script, stamping every held item stale before its own
 * resolve ever runs). But that also means an UNRELATED push that lands
 * without ever going through a counting gate leaves `.rounds` unchanged too —
 * round equality alone reads that as a match, even though it was never the
 * push this hold was waiting on. The stamp closes that: it cannot name a SHA
 * that never went through the validate → push → stamp-held sequence, so a
 * push that bypassed the skill's own flow leaves it stale and the comparison
 * fails.
 *
 * And the stamp is PER HOLD rather than PR-global, which is what makes it
 * survive a second driver. This state file is shared by every
 * driver working the PR, so a single `state.verifiedSha` was moved by
 * whichever of them pushed last and then vouched for all of them: driver A
 * holds a thread and stalls before pushing its fix, driver B pushes unrelated
 * work and calls `stamp-held` (no counting gate, so `.rounds` does not move
 * either), A's tree later syncs to B's head and retries — and every check
 * here passed against a push that never contained A's fix. `stamp-held`
 * stamps only the holds created by the tree that calls it, so B's push can
 * never answer A's promise. It can still be ANY driver that finishes a hold
 * once the fix is genuinely on the PR — the check is on the hold's stamp, not
 * on who is claiming — so a driver dying mid-round strands nothing.
 *
 * The round+stamp check and the removal from `held` happen in ONE lock
 * hold inside `claim-held` — not as a read here followed by a later mutation
 * — so two concurrent resolves on the SAME key can never both pass: whichever
 * claims first empties the slot, and the second sees "no held item" rather
 * than proceeding to resolve against state that has since changed underneath
 * it.
 *
 * The `--pushed-sha` checks below mirror `answer-summary-finding.ts`'s
 * exactly: the SHA must be the PR's live head AND this worktree's clean HEAD.
 * That proves the SHA is genuinely pushed and fully committed; `claim-held`'s
 * checks are what prove it is the push THIS thread's reply was waiting on — a
 * current, clean, pushed HEAD exists on every round, held or not, so the SHA
 * checks alone cannot tell today's push from an unrelated later one. They run
 * BEFORE `claim-held` deliberately: `claim-held` is destructive (it removes
 * the held item the instant its predicate matches), so nothing this script
 * does before it may fail — every check ahead of it is read-only or
 * gh/git-only, and a failure there leaves the held item exactly where it was.
 *
 * From the claim onward the item IS gone from `held`, so review round 2/3
 * added two more layers: an api-head RECHECK immediately before the mutation
 * (narrowing, not closing, the window a push could land in — nothing local
 * can serialise against GitHub itself), and `drive-state.ts restore-held`
 * (never plain `hold`, and never swallowed) to put the item back — at its
 * EXACT original round, since a concurrent driver's `bump-round` may have
 * moved `.rounds` on while the network call was in flight — if the recheck or
 * the mutation itself fails. A restore that cannot persist is reported as
 * fatal, not silently absorbed; SKILL.md § 3's ordinary reconciliation (the
 * GitHub reply already exists; a killed pass or a failed restore just leaves
 * the thread unresolved for the next round to find) is what actually recovers
 * from there.
 *
 * Usage:
 *   resolve-held-thread.ts --key THREAD_NODE_ID --pushed-sha SHA [PR]
 *
 *   --key          REQUIRED. A `kind: thread` entry's key in
 *                  `drive-state.ts held [PR]`.
 *   --pushed-sha   REQUIRED. `$(git rev-parse HEAD)`, called only after
 *                  guarded-push.ts has landed it (SKILL.md § 6).
 */

interface LiveComment {
  url: string;
  authorAssociation: string | null;
  body: string | null;
  author: { login: string } | null;
}

/**
 * A comment landing AFTER the held reply is compatible with that
 * reply only when it is a reviewer bot's own automated confirmation. The
 * strict "the held reply is the latest comment" check exists to catch a
 * human changing the outcome; reviewer bots post a confirming follow-up
 * within seconds of an outcome reply, and `finish-round.ts` reaches this
 * script only after a push and a reviewer wait, so every hold used to lose
 * that race (4–5 cycles, ~20 minutes, on PR #4618).
 *
 * The identity+shape predicate itself now lives in
 * `./lib/bot-confirmation.ts` — shared with `finish-round.ts`'s own
 * pre-push untriaged-thread guard (review finding, PR #5000): that
 * guard used to judge strictly against the literal latest comment, so it
 * refused the round on the very confirmation this function exists to
 * tolerate, whenever CodeRabbit's confirmation landed before the push
 * rather than during this script's own post-push wait. One predicate for
 * both callers is what keeps them from drifting apart on the identical
 * question again.
 */
function isTrustedBotConfirmation(c: LiveComment): boolean {
  return isTrustedBotConfirmationShared(
    { authorLogin: c.author?.login ?? null, body: c.body },
    qualifyingOutcome,
  );
}

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTrustedBotConfirmation as isTrustedBotConfirmationShared } from "./lib/bot-confirmation.ts";
import { fail, isDigits, runMain, short } from "./lib/cli.ts";
import { qualifyingOutcome } from "./lib/outcome.ts";
import {
  ghCall,
  git,
  readTimeoutEnv,
  resolvePr,
  run,
  tsArgv,
} from "./lib/proc.ts";
import { TRUSTED_ASSOCIATIONS } from "./summary-findings.ts";

const here = dirname(fileURLToPath(import.meta.url));
const driveState = join(here, "drive-state.ts");
const resolveThread = join(
  here,
  "..",
  "..",
  "resolve-review-comments",
  "scripts",
  "resolve-thread.ts",
);

function prefixLines(prefix: string, text: string): string {
  return text
    .split("\n")
    .filter((l, i, all) => !(l === "" && i === all.length - 1))
    .map((l) => `${prefix}${l}`)
    .join("\n");
}

async function main(): Promise<number> {
  // Bound every network call — mode 13 in references/terminal-states.md.
  // Validated, not trusted verbatim (review round 2): an override of `0` — or
  // any non-positive value — would silently reintroduce the exact unbounded
  // hang this deadline exists to prevent, and a non-numeric override is
  // refused for the same reason a malformed drive-state file is refused
  // rather than coerced: guessing a fallback here would hide a
  // misconfiguration behind a script that otherwise looks like it is bounding
  // calls it is not.
  for (const name of ["GH_CALL_TIMEOUT", "DRIVE_PR_HELPER_TIMEOUT"]) {
    const read = readTimeoutEnv(name, 0);
    if (!read.ok) {
      fail(
        2,
        `resolve-held-thread.ts: $${name} must be a positive whole number of seconds (got '${read.raw}').`,
      );
    }
  }
  const helperTimeout = readTimeoutEnv("DRIVE_PR_HELPER_TIMEOUT", 120);
  const helperTimeoutSec = helperTimeout.ok ? helperTimeout.seconds : 120;

  let key = "";
  let pushedSha = "";
  let pr = "";
  const argv = process.argv.slice(2);
  const take = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined) fail(2, `${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    switch (a) {
      case "--key":
        key = take(a, i++);
        break;
      case "--pushed-sha":
        pushedSha = take(a, i++);
        break;
      default:
        if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
        pr = a;
    }
  }

  if (key === "") {
    fail(
      2,
      "resolve-held-thread.ts: --key is required (a thread node id from 'drive-state.ts held-keys')",
    );
  }
  if (pushedSha === "") {
    fail(
      2,
      "resolve-held-thread.ts: --pushed-sha is required.",
      "",
      "A held thread's accepted/moot reply promises a fix that has not landed yet at",
      "hold time, so resolving it needs proof the fix is now on the PR — the same",
      "ordering answer-summary-finding.ts enforces for a held finding. Push first,",
      "then pass the SHA you pushed:",
      '  --pushed-sha "$(git rev-parse HEAD)"',
    );
  }

  pr = await resolvePr(pr);
  if (!isDigits(pr)) {
    fail(2, "resolve-held-thread.ts: could not resolve a PR number");
  }

  // A cheap, read-only, fail-fast precheck — NOT the load-bearing check. A
  // typo'd --key or a finding's fingerprint passed by mistake should fail
  // with a clear message before this script ever touches git or the network,
  // rather than surfacing as an unrelated SHA mismatch. It can go stale
  // between here and `claim-held` below (a concurrent resolve, a release) —
  // that race is real but harmless: `claim-held`'s own atomic check is what
  // actually decides whether this resolve proceeds, and it re-derives the
  // same answer from a fresh, locked read.
  const heldRes = await run(tsArgv(driveState, ["held", pr]), {
    stderr: "inherit",
  });
  if (heldRes.code !== 0) return heldRes.code;
  let held: Array<{
    key: string;
    kind: string;
    outcome: string;
    round: number;
    commentUrl?: string;
    actor: string;
  }> = [];
  try {
    // Array-checked, not just syntax-checked: `JSON.parse` returning an object,
    // a string or null would sail through the catch and make `held.find` below
    // throw a TypeError, surfacing as an opaque runMain message instead of the
    // diagnostic this precheck exists to give (coderabbitai, PR #4034 round 2).
    // ELEMENT-level, not just container-level. `[null]` passes
    // `Array.isArray` and then throws a TypeError at `held.find(h => h.key)` —
    // the same opaque failure the container check was added to prevent, one
    // level in (coderabbitai, PR #4034 round 4). Valid JSON is not a valid
    // state record, so every field this function reads is checked.
    const parsed: unknown = JSON.parse(heldRes.stdout);
    held = Array.isArray(parsed)
      ? (parsed.filter(
          (h): h is (typeof held)[number] =>
            typeof h === "object" &&
            h !== null &&
            typeof (h as { key?: unknown }).key === "string" &&
            typeof (h as { kind?: unknown }).kind === "string" &&
            typeof (h as { outcome?: unknown }).outcome === "string" &&
            typeof (h as { round?: unknown }).round === "number" &&
            // `actor` too, for the same "every field this function reads" rule
            // — the fallback below copies it into a `restore-held --actor`,
            // which refuses an empty one. Without this check an actorless entry
            // reaches that fallback and turns a restorable item into the
            // "LOST from local drive-pr state" report; with it, the item simply
            // is not found and the caller gets the clear precheck message
            // instead. `isUsableState` already requires the field, so this only
            // ever fires on a `held` payload that did not come from the store.
            typeof (h as { actor?: unknown }).actor === "string",
        ) as typeof held)
      : [];
  } catch {
    held = [];
  }
  const item = held.find((h) => h.key === key);
  if (!item) {
    // Exit 4, matching `claim-held`'s own exit for the identical condition
    // below — this precheck and that call read the same fact (is `key` in
    // `held` right now), so a caller must see one exit code for it regardless
    // of which of the two catches it. Callers driving a batch (finish-round.ts)
    // treat 4 as a stale snapshot — re-read rather than a permanent refusal —
    // which matters here specifically because a genuinely vanished key (this
    // thread's own resolve landed via a concurrent driver since the caller's
    // batch read) is indistinguishable, from this precheck's point of view,
    // from a typo (chatgpt-codex-connector, a reference-implementation pull request).
    fail(
      4,
      `resolve-held-thread.ts: no held item with key '${key}' for PR #${pr}.`,
      `Check 'drive-state.ts held-keys ${pr}' for a typo. If this thread was`,
      "never held (a rejected/wont-fix/deferred outcome, say), resolve it",
      "directly with resolve-thread.ts instead — this wrapper is only for",
      "the held batch.",
    );
  }
  if (item.kind !== "thread") {
    fail(
      2,
      `resolve-held-thread.ts: '${key}' is a held '${item.kind}', not a 'thread'.`,
      "Use answer-summary-finding.ts --pushed-sha for a held finding.",
    );
  }

  // Mirrors answer-summary-finding.ts's --pushed-sha ordering exactly: the
  // API check proves the SHA is the PR's head; the local-HEAD and clean-tree
  // checks prove it is THIS commit, fully committed, not merely a SHA read
  // off the PR page. All read-only (or gh/git-only) — nothing here can leave
  // `held` in an inconsistent state on failure.
  const apiRes = await ghCall(
    ["pr", "view", pr, "--json", "headRefOid", "-q", ".headRefOid"],
    { stderr: "pipe" },
  );
  if (apiRes.code !== 0 || apiRes.stdout.trim() === "") {
    console.error(
      `resolve-held-thread.ts: cannot read PR #${pr}'s head — refusing to resolve '${key}' on an unknown state`,
    );
    if (apiRes.stderr !== "")
      console.error(prefixLines("  gh: ", apiRes.stderr));
    return 1;
  }
  const apiHead = apiRes.stdout.trim();
  if (apiHead !== pushedSha) {
    fail(
      2,
      `resolve-held-thread.ts: --pushed-sha ${pushedSha} is not PR #${pr}'s head (${apiHead}).`,
      "The push has not landed yet, or the API lags a few seconds — wait for",
      "drive-status.ts to stop reporting HEAD_LAG, then retry.",
    );
  }

  const localRes = await git(["rev-parse", "HEAD"], { stderr: "ignore" });
  if (localRes.code !== 0) {
    fail(
      1,
      `resolve-held-thread.ts: cannot read local HEAD — refusing to resolve '${key}' without confirming the fix is committed here.`,
    );
  }
  const localHead = localRes.stdout.trim();
  if (localHead !== pushedSha) {
    fail(
      2,
      `resolve-held-thread.ts: --pushed-sha ${pushedSha} is not this worktree's HEAD (${localHead}).`,
      "Resolve for the commit you actually pushed, not a SHA read off the PR.",
    );
  }

  const dirtyRes = await git(["status", "--porcelain"], { stderr: "ignore" });
  if (dirtyRes.code !== 0) {
    fail(
      1,
      `resolve-held-thread.ts: cannot read the working tree — refusing to resolve '${key}' without confirming the fix is fully committed.`,
    );
  }
  if (dirtyRes.stdout !== "") {
    console.error(
      `resolve-held-thread.ts: the working tree is dirty, so the fix is not fully committed:`,
    );
    process.stderr.write(dirtyRes.stdout);
    return 2;
  }

  // The load-bearing check, and the only step that mutates `held` on success.
  // See the header comment for why round equality AND `.verifiedSha` together
  // are what "this push carries the promised fix" reduces to, and why folding
  // the check and the removal into one lock hold is what makes two concurrent
  // resolves on this key mutually exclusive.
  const claimRes = await run(
    tsArgv(driveState, [
      "claim-held",
      pr,
      "--key",
      key,
      "--kind",
      "thread",
      "--pushed-sha",
      pushedSha,
    ]),
    { stderr: "inherit" },
  );
  if (claimRes.code !== 0) return claimRes.code;
  let claimed: {
    outcome: string;
    round: number;
    commentUrl: string;
    actor: string;
    verifiedSha: string;
  };
  try {
    // Shape-checked for the same reason as the held payload above: `null` and
    // `{}` are valid JSON, and either would make the restore path below carry
    // an undefined round — restoring the item at `NaN` and permanently
    // failing every later resolve of it (coderabbitai, PR #4034 round 4). An
    // unusable payload takes the same route as an unparseable one.
    const p: unknown = JSON.parse(claimRes.stdout);
    if (
      typeof p !== "object" ||
      p === null ||
      typeof (p as { outcome?: unknown }).outcome !== "string" ||
      typeof (p as { round?: unknown }).round !== "number" ||
      // `commentUrl` is checked with the same weight as the other two: it is
      // now a REQUIRED argument of `restore-held`, so an item claimed without
      // one cannot be put back at all. Falling through to the precheck copy
      // below is the same recovery an unparseable payload gets. `actor` and
      // `verifiedSha` are REQUIRED arguments too, for the same reason
      // — and `verifiedSha` is provably present on anything a claim
      // succeeded on, since matching it against `--pushed-sha` is what the
      // claim does.
      typeof (p as { commentUrl?: unknown }).commentUrl !== "string" ||
      typeof (p as { actor?: unknown }).actor !== "string" ||
      typeof (p as { verifiedSha?: unknown }).verifiedSha !== "string"
    ) {
      throw new Error("claim-held printed an unusable payload");
    }
    claimed = p as {
      outcome: string;
      round: number;
      commentUrl: string;
      actor: string;
      verifiedSha: string;
    };
  } catch {
    // A claim that printed something unreadable still removed the item; treat
    // it like a mutation-path failure and restore below via the recheck path.
    // The precheck copy carries the same fields — `pushedSha` for the stamp
    // because the claim only ever succeeds when the two are equal, so it is
    // the value the removed item provably carried.
    //
    // That copy was read BEFORE the claim, so on this branch alone the `actor`
    // could in principle be a superseded one (a concurrent driver re-held the
    // key in the window). Reaching it needs `claim-held` to have printed an
    // unusable payload for a claim that nonetheless succeeded — the abnormal
    // case this fallback exists for at all — and the alternative is not
    // restoring the item, which loses it outright. A possibly-stale attribution
    // that a later round reconciles beats a hold that is simply gone.
    claimed = {
      outcome: item.outcome,
      round: item.round,
      commentUrl: item.commentUrl ?? "",
      actor: item.actor,
      verifiedSha: pushedSha,
    };
  }

  // From here, the item is GONE from `held`. Every failure path below must
  // put it back via `restore-held`, passing the claimed round — the item's
  // OWN original round, not whatever `.rounds` reads at restore time — never
  // `drive-state.ts hold` (which stamps "now"): `claim-held` released its
  // lock before any of this ran, so a concurrent driver's `bump-round` could
  // already have moved `.rounds` forward by the time a restore happens, and
  // stamping "now" would silently launder that — the restored item would
  // compare equal to a round it was never actually re-confirmed against.
  // `restore-held` also has no swallowed-failure escape hatch (review round
  // 2/3): a failure to persist the restore is fatal here too — see the
  // fallback message below.
  async function restoreOrDie(why: string): Promise<void> {
    const r = await run(
      tsArgv(driveState, [
        "restore-held",
        pr,
        "--key",
        key,
        "--kind",
        "thread",
        "--outcome",
        claimed.outcome,
        "--round",
        String(claimed.round),
        // Carried for the same reason the round is: a restored entry missing
        // its `commentUrl` reads as provenance-free to the next standalone
        // reconciliation, which then treats ANY qualifying comment — including
        // the exact same one this hold already represents — as a supersession
        // and downgrades a hold that was never actually invalidated
        // (docomply-review round 11, a reference-implementation pull request).
        "--comment-url",
        claimed.commentUrl,
        // Carried for the same reason, and with a sharper edge: the
        // actor keeps the restored hold owned by the driver that made its
        // promise rather than by whichever one restored it, and the stamp is
        // what makes the retry this restore exists to enable actually possible
        // — `stamp-held` has already run for this push and will not run
        // again, so an entry restored without it could never be claimed.
        "--actor",
        claimed.actor,
        "--verified-sha",
        claimed.verifiedSha,
      ]),
      { stdout: "ignore", stderr: "pipe" },
    );
    if (r.code === 0) {
      console.error(
        `resolve-held-thread.ts: ${why} for '${key}' — restored it to the held batch (round ${claimed.round}) for a retry.`,
      );
      return;
    }
    if (r.stderr.includes("already present in held")) {
      // A concurrent driver re-held this key while the mutation was in
      // flight. The item is in `held`; nothing was lost and nothing needs
      // doing.
      console.error(
        `resolve-held-thread.ts: ${why} for '${key}' — another driver already re-held it, so no restore was needed.`,
      );
      return;
    }
    if (r.stderr !== "")
      console.error(prefixLines("  restore-held: ", r.stderr));
    console.error(
      `resolve-held-thread.ts: ${why} for '${key}', AND restoring it to the held batch`,
    );
    console.error(`FAILED — '${key}' is now LOST from local drive-pr state.`);
    console.error("");
    console.error(
      "This is not silently swallowed: the GitHub reply already committed to",
    );
    console.error(
      `'${claimed.outcome}' still stands (reply-to-thread.ts posted it back in step 3), so the`,
    );
    console.error(
      "next round's thread enumeration will find it unresolved with that reply",
    );
    console.error(
      "already on it and re-hold it via SKILL.md § 3's reconciliation path — the",
    );
    console.error(
      "same recovery a killed process relies on. No action is needed here beyond",
    );
    console.error("noticing why this pass failed.");
  }

  // Comment-staleness recheck (an earlier change finding, chatgpt-codex-
  // connector): `finish-round.ts`'s own pre-push guard confirms a held
  // thread's `commentUrl` matches its latest comment, but that check runs
  // BEFORE `guarded-push.ts` — which SKILL.md documents as potentially
  // taking tens of minutes through the pre-push hook. A reviewer or human
  // reply landing on the thread during that window (or during the
  // AWAITING_REVIEWER wait afterward) would otherwise reach this point
  // unnoticed: `claim-held` only checks PUSH provenance (round + verified
  // SHA), never the thread's own comment history, and `resolve-thread.ts`'s
  // mutation is unconditional. Re-fetch the thread's live comments — the
  // same single-thread-by-node-id GraphQL query `triage-thread.ts`'s own
  // `fetchThread` uses, kept inline here rather than extracted into a shared
  // module for this round's minimal-diff constraint — and refuse to resolve
  // when the truncation flag is set (the visible tail is not confirmed to be
  // the real latest, same posture as `finish-round.ts`'s `currentReplyOutcome`)
  // or anything but a trusted reviewer bot's own confirmation has
  // landed after the reply this hold promised.
  //
  // Deliberately BEFORE the head recheck below, not after (round 25 review
  // finding, P1, chatgpt-codex-connector): this query can itself consume up
  // to the full helper timeout, and an earlier revision ran the head recheck
  // FIRST — so a push landing during THIS call's own latency would sail past
  // an already-stale "head confirmed current" result, widening exactly the
  // TOCTOU window the head recheck exists to narrow. Running the slower,
  // less time-sensitive check first and the head recheck LAST — immediately
  // before the mutation — keeps the head recheck's own guarantee as tight as
  // it can be: only the mutation call's own latency stands between it and
  // the irreversible act.
  // Best-effort cleanup, not a correctness gate (review round 6): between
  // `claim-held` removing this key and the thread reading resolved, a
  // CONCURRENT driver's own pass can legitimately re-enumerate this
  // still-open GitHub thread, see no held record for it, and — following
  // SKILL.md § 3's documented "the reply already exists, re-hold it"
  // reconciliation exactly as intended for a genuinely different scenario —
  // recreate a `held` entry for a key that is, from this process's point of
  // view, already resolved. Nothing else will ever clean that entry up: it
  // isn't wrong yet, but a LATER pass reading it would either refuse it on a
  // round mismatch before reaching real work, or attempt to resolve an
  // already-closed thread against some future push. If the key has
  // reappeared, drop it now, while we know for certain the underlying thread
  // is resolved.
  //
  // Deleted by key, not matched against round/outcome (review round 9 tried
  // matching, guarding against dropping a concurrent driver's "newer"
  // re-hold of this key — reverted in round 10, see drive-state.ts's
  // release-held comment: the only way a re-hold of THIS key can exist here
  // is from a driver whose own step-2 enumeration (scoped to `isResolved ==
  // false`) saw the thread open, which — for a thread that reads resolved —
  // is only possible from a scan taken BEFORE that resolve landed. So any
  // record found for this key at this point is provably stale regardless of
  // its round/outcome, and matching against it is what leaves a stale record
  // behind forever instead of cleaning it up.
  //
  // That argument assumes resolution is MONOTONIC — once resolved, always
  // resolved — and GitHub does not actually guarantee that: any user with
  // write access can UNRESOLVE a thread (the "unresolve conversation"
  // action), the same mutation `resolve-thread.ts` uses in reverse (review
  // finding, docomply-review, a reference-implementation pull request round 1). A thread this function's
  // own CALLER read as resolved can therefore be reopened, and re-held by a concurrent
  // driver's own step 2/3, in the window between that read and this
  // function actually running — this is a whole earlier `staleCheck`
  // GraphQL round trip PLUS two more subprocess spawns (`held-keys`,
  // `release-held`) at the SLOWEST call site (line ~683, immediately after
  // `staleCheck` itself), or the `resolveThread` mutation's own round trip
  // at the other (line ~804). Deleting unconditionally on the strength of a
  // read that is no longer current would wipe that concurrent driver's own
  // legitimate hold, silently — not a leftover, a live pending disposition.
  //
  // So: re-verify `isResolved` ONE more time, as close to the mutation as
  // this function can get it — the same "keeps the guarantee as tight as it
  // can be" tightening the TOCTOU comment above already applies to the head
  // recheck. This does not make the delete atomic with GitHub's own
  // resolution state (nothing here can — `held-keys` already reads outside
  // the state lock, per the ORIGINAL best-effort framing below), it only
  // narrows the window from "the whole caller-to-here gap" to "this one
  // query's own latency". Best-effort in the same sense as before: a
  // network failure here is read as NOT-confirmed (fail closed toward
  // leaving the entry alone, never toward deleting on a stale belief) and
  // leaves at worst a harmless stale entry for a later round's own triage to
  // notice, exactly the residual the ORIGINAL comment already accepted.
  async function dropReheldKey(): Promise<void> {
    const heldKeys = await run(tsArgv(driveState, ["held-keys", pr]), {
      stderr: "ignore",
    });
    if (
      heldKeys.code !== 0 ||
      !heldKeys.stdout.split("\n").some((k) => k === key)
    ) {
      return;
    }
    const recheck = await ghCall(
      [
        "api",
        "graphql",
        "-f",
        `query=query($id:ID!){ node(id:$id){ ... on PullRequestReviewThread{ isResolved } } }`,
        "-f",
        `id=${key}`,
      ],
      { timeoutSec: helperTimeoutSec, stderr: "ignore" },
    );
    if (recheck.code !== 0) return;
    let recheckParsed: unknown;
    try {
      recheckParsed = JSON.parse(recheck.stdout);
    } catch {
      return;
    }
    const stillResolved = (
      recheckParsed as { data?: { node?: { isResolved?: unknown } } }
    )?.data?.node?.isResolved;
    if (stillResolved !== true) return;
    await run(tsArgv(driveState, ["release-held", pr, "--key", key]), {
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  const staleCheck = await ghCall(
    [
      "api",
      "graphql",
      "-f",
      `query=
query($id:ID!){
  node(id:$id){
    ... on PullRequestReviewThread{
      isResolved
      comments(first:100){ pageInfo{ hasNextPage } nodes{ url authorAssociation body author{ login } } }
    }
  }
}`,
      "-f",
      `id=${key}`,
    ],
    { timeoutSec: helperTimeoutSec, stderr: "pipe" },
  );
  if (staleCheck.code !== 0) {
    await restoreOrDie(
      `cannot re-read thread '${key}''s live comments immediately before resolving`,
    );
    if (staleCheck.stderr !== "")
      console.error(prefixLines("  gh: ", staleCheck.stderr));
    return 1;
  }
  let staleCheckParsed: unknown;
  try {
    staleCheckParsed = JSON.parse(staleCheck.stdout);
  } catch {
    await restoreOrDie(
      `thread '${key}''s live-comments read printed a payload this script cannot read`,
    );
    return 1;
  }
  const threadNode = (
    staleCheckParsed as {
      data?: {
        node?: {
          isResolved?: unknown;
          comments?: { pageInfo?: { hasNextPage?: unknown }; nodes?: unknown };
        };
      };
    }
  )?.data?.node;
  const commentsField = threadNode?.comments;
  const nodesRaw = commentsField?.nodes;
  if (
    typeof threadNode !== "object" ||
    threadNode === null ||
    typeof threadNode.isResolved !== "boolean" ||
    typeof commentsField?.pageInfo?.hasNextPage !== "boolean" ||
    !Array.isArray(nodesRaw)
  ) {
    await restoreOrDie(
      `thread '${key}''s live-comments read returned an unusable shape`,
    );
    return 1;
  }
  // Already resolved on GitHub — a reviewer bot resolved it itself
  // after confirming the reply (every CodeRabbit follow-up sampled on PR
  // #4618 did), or a human did. The hold's goal is met: `claim-held` already
  // drained it, so there is nothing to mutate and nothing to restore. Ahead
  // of every comment check below, because those guard a mutation this path
  // never makes — and a bot's follow-up on a resolved thread is exactly what
  // would otherwise fail them.
  if (threadNode.isResolved) {
    console.error(
      `resolve-held-thread.ts: thread '${key}' is already resolved on GitHub — hold drained without a mutation.`,
    );
    await dropReheldKey();
    process.stdout.write("true\n");
    return 0;
  }
  if (commentsField.pageInfo.hasNextPage) {
    await restoreOrDie(
      `thread '${key}' is now comment-truncated — cannot confirm the held reply is still current`,
    );
    return 2;
  }
  // Every node's `url` is validated, none are dropped (an earlier change
  // finding, round 6): `list-unresolved-threads.ts` treats comment fields as
  // optional GraphQL input, so a malformed or missing `url` on some node
  // OTHER than the true latest is a real possibility, not a hypothetical.
  // Filtering such a node out — rather than refusing outright — would shift
  // "the latest comment" to an OLDER comment's url, which can coincidentally
  // still equal the hold's own `commentUrl` and let a thread whose real
  // latest comment is unreadable resolve anyway. Per `.claude/rules/document-
  // scanning-gates.md` rule 1, an undecodable entry must produce a finding
  // (here: refuse and restore), never silently shrink the population it is
  // measured against.
  const hasMalformedNode = nodesRaw.some((n) => {
    if (typeof n !== "object" || n === null) return true;
    const c = n as {
      url?: unknown;
      authorAssociation?: unknown;
      body?: unknown;
      author?: unknown;
    };
    // `author` is null for a deleted account — legal, read as untrusted.
    const a = c.author as { login?: unknown } | null;
    return (
      typeof c.url !== "string" ||
      !(
        typeof c.authorAssociation === "string" || c.authorAssociation === null
      ) ||
      !(typeof c.body === "string" || c.body === null) ||
      !(a === null || (typeof a === "object" && typeof a.login === "string"))
    );
  });
  if (hasMalformedNode) {
    await restoreOrDie(
      `thread '${key}''s live-comments read contains a comment this script cannot read — cannot confirm the held reply is still current`,
    );
    return 1;
  }
  const nodes = nodesRaw as LiveComment[];
  // The hold's own reply, and everything after it. Anything after it must be
  // a trusted reviewer bot's automated confirmation — a human's
  // comment, or any body this script does not recognize, still refuses.
  const heldIdx = nodes.findIndex((n) => n.url === claimed.commentUrl);
  const later = heldIdx === -1 ? [] : nodes.slice(heldIdx + 1);
  if (heldIdx === -1 || !later.every(isTrustedBotConfirmation)) {
    await restoreOrDie(
      `thread '${key}''s latest comment moved past the hold's own reply — a newer comment landed since it was held`,
    );
    return 2;
  }
  const heldReply = nodes[heldIdx];
  // The URL alone is not enough: a
  // GitHub comment keeps its permalink when EDITED, so a trusted
  // `**accepted**`/`**moot**` reply whose outcome token was later removed or
  // changed still matches on url while no longer promising what the hold
  // recorded. Re-derive the outcome from the SAME live body this URL check
  // just confirmed is current, and require it to still equal what was held.
  const heldOutcome =
    heldReply !== undefined &&
    heldReply.authorAssociation !== null &&
    TRUSTED_ASSOCIATIONS.has(heldReply.authorAssociation)
      ? qualifyingOutcome(heldReply.body ?? "")
      : null;
  if (heldOutcome === null || heldOutcome.outcome !== claimed.outcome) {
    await restoreOrDie(
      `thread '${key}''s held reply no longer carries the outcome '${claimed.outcome}' it was held for — it was edited or is no longer from a trusted author since it was held`,
    );
    return 2;
  }

  // TOCTOU tightening (review round 2; reordered to run LAST in round 25 —
  // see the comment-staleness check's own header above for why): the api-
  // head check that originally ran here used to run BEFORE claim-held and
  // the comment-staleness network call above — both take real time, during
  // which another push could land. Re-reading it here, immediately before
  // the mutation, narrows that window to "the mutation call itself" — it
  // cannot close it entirely, because nothing running locally can serialise
  // against a push landing on GitHub's server; a push in the instant between
  // THIS check and the mutation call is a risk no client-side check
  // eliminates. What this catches is a push that already landed by the time
  // we ask again.
  const recheckRes = await ghCall(
    ["pr", "view", pr, "--json", "headRefOid", "-q", ".headRefOid"],
    { stderr: "pipe" },
  );
  if (recheckRes.code !== 0 || recheckRes.stdout.trim() === "") {
    await restoreOrDie(
      `cannot re-read PR #${pr}'s head immediately before resolving`,
    );
    if (recheckRes.stderr !== "")
      console.error(prefixLines("  gh: ", recheckRes.stderr));
    return 1;
  }
  const recheckHead = recheckRes.stdout.trim();
  if (recheckHead !== pushedSha) {
    await restoreOrDie(
      `PR #${pr}'s head moved to ${short(recheckHead)} after the claim, before the resolve`,
    );
    return 2;
  }

  const mutation = await run(tsArgv(resolveThread, [key]), {
    timeoutSec: helperTimeoutSec,
    stderr: "inherit",
  });
  if (mutation.code !== 0) {
    await restoreOrDie("resolveReviewThread failed or timed out");
    return mutation.code;
  }

  await dropReheldKey();

  process.stdout.write(mutation.stdout);
  return 0;
}

runMain("resolve-held-thread.ts", main);
