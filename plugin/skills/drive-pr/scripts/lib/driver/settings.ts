/** Read driver policy and derive exit codes from the terminal-state contract. */
import { readRemoteName } from "../../../../../shared/consumer.ts";

import { isDigits, fail, shellQuote, testPacing } from "../cli.ts";

import { driverOnlyExitCode } from "../status/terminal-states.ts";

import { maxRoundsSetting, DEFAULT_MAX_ROUNDS } from "../overlay.ts";

import { reflectionSwitch } from "../../../../reflect/scripts/lib/settings.ts";

// The words `mark-ready.ts` documents as its whole exit-0 STDOUT contract (its
// own top-of-file comment). Exit 0 with anything else is a malformed or
// truncated response, not a settled transition — validated at both call sites
// below rather than trusted: an unrecognized outcome must not be read as
// "nothing owed". `not-open` is deliberately absent, because it never arrives
// at exit 0; it is exit 5, which both call sites answer before ever looking at
// stdout.
export const MARK_READY_OUTCOMES = new Set([
  "marked",
  "already-ready",
  "already-marked",
  "claimed-by-other",
  "still-draft",
]);

/**
 * One ROUND_READY gate's observable outcome surface, serialized for equality:
 * the head the reviewer judged, the local head when the gate measured one, and
 * every work count drive-status.ts reported. Two consecutive gates reading the
 * SAME fingerprint means the pass that ran between them produced nothing this
 * loop can observe — no push, no reply, no resolution, no addressed finding —
 * which is the stall signature: a pass that exits 0 after standing down (for
 * example, against its own parent driver) looks exactly
 * like a productive round to every other counter this loop keeps.
 *
 * Null means "cannot attest sameness", never "same": an unreadable head or a
 * gate where neither the thread count nor the summary-finding count was
 * measured produces no fingerprint at all, so an unmeasurable round can only
 * ever RESET the stall streak — the failure direction is a drive that runs to
 * --max-rounds as before, not one stopped on a guess. Counts that CAN be null
 * per-field (countOrNull) still participate when at least one core count is a
 * number: null-vs-number is itself an observable change, and serializing the
 * field keeps it one.
 *
 * That rule binds the LOCAL head, which must be MEASURED — a real SHA from
 * `head.local`, whatever `head.localSource` says produced it. Without one, a
 * pass can commit (or commit and push, while the API head this gate read is
 * still stale) and every other field stays put, so the verdict would indict a
 * round that did work and the report would state, falsely, that nothing was
 * pushed. `--no-head-sync` is not an exemption from that — a caller declining
 * to COMPARE the local head is not a caller asserting no local head exists
 * (that holds both for a measurement that failed and for the deliberate
 * opt-out). `drive.ts` has deliberately no `--head` to fall back on (this
 * file's own top-of-file comment — it drives the tree it runs in); a drive
 * that genuinely cannot measure in its own tree instead gets `local: ''` /
 * `localSource: 'unavailable'` from drive-status.ts, which the empty-string
 * check above already refuses — losing only this earlier stop and falling
 * back to the `--max-rounds` bound, same as a caller that opts out entirely.
 *
 * And it binds work IDENTITIES, not cardinalities. Counts alone call a
 * SUBSTITUTION unchanged — a pass resolves thread A while the reviewer posts
 * thread B, so the count stays 1 across a round that did real work. The key
 * arrays are therefore required, not optional: a gate that measured counts
 * but published no keys cannot attest sameness, and says so with `null`
 * rather than falling back to the weaker evidence.
 */
export function roundFingerprint(
  status: Record<string, unknown>,
): string | null {
  const head = status.head as Record<string, unknown> | undefined;
  const work = status.work as Record<string, unknown> | undefined;
  const api = head?.api;
  if (typeof api !== "string" || api === "") return null;
  const local = head?.local;
  if (typeof local !== "string" || local === "") return null;
  const localSource =
    typeof head?.localSource === "string" ? head.localSource : "";
  // Only a provenance KNOWN to re-measure the driven worktree attests
  // anything. `git` is that set today; everything else — a caller-supplied
  // `--head` (`flag`), an opt-out (`disabled`), a failed read (`unavailable`),
  // or any source a later build introduces — is refused.
  //
  // Named-denylist first, and that was wrong in the one direction that costs a
  // productive drive: a future
  // `localSource: 'cache'` carrying a frozen SHA would read as a continuing
  // measurement and stop the loop at 14 after real pushes. Refusing an unknown
  // source only ever loses this early stop and falls back to the `--max-rounds`
  // bound, so the allowlist is the fail-closed direction. Adding a source that
  // genuinely re-measures means adding it here, deliberately.
  if (localSource !== "git") return null;
  const threadKeys = work?.unresolvedThreadKeys;
  const summaryKeys = work?.summaryUnaddressedKeys;
  if (!Array.isArray(threadKeys) || !Array.isArray(summaryKeys)) return null;
  const parkedKeys = work?.parkedKeys;
  // Required, not optional, same as threadKeys/summaryKeys above: parking is
  // progress that moves nothing else — no marker is posted, so a parked
  // summary finding leaves both summary counts standing — and one parked
  // item traded for another is the same substitution the thread and finding
  // keys exist to catch. Substituting `null` for a missing/malformed value
  // (rather than refusing the whole fingerprint) would make two passes that
  // park DIFFERENT findings serialize identically whenever the status report
  // omits this field, which is exactly the false-stall the identity check
  // exists to prevent.
  if (!Array.isArray(parkedKeys)) return null;
  return JSON.stringify([
    api,
    local,
    localSource,
    threadKeys,
    summaryKeys,
    parkedKeys,
    // The totals ride along as evidence for the printed report, and because a
    // total moving while the unaddressed set does not (a finding answered on
    // an unchanged head) is itself an observable change.
    work?.summaryFindings ?? null,
  ]);
}

/**
 * The context-economy dial's CANONICAL value: a whole percent as a string, or
 * the literal `never`. Throws `ExitError(2)` — via `fail`, so the operator sees
 * the same guidance either way — on anything else.
 *
 * Normalised to exactly those two shapes so the pass reads ONE value and never
 * a vocabulary. The named settings are aliases resolved here rather than a
 * parallel set of tiers: the semantics are literally "hand off at N%", and a
 * number says what a name only gestures at while leaving every point between
 * the tiers reachable.
 *
 * EXPORTED, and that is the load-bearing part rather than an incidental
 * refactor. The alias table is a pure total function of one string, so its
 * tests assert it in-process: spawning a whole `drive.ts` per value — locks,
 * gates, a stubbed forge, a pass — to read the resolved value back out of the
 * child's environment costs about 35.9s for five handoff values
 * <!-- measured -->, all of it paid for machinery the assertion does not
 * name. ONE spawn probe stays alongside to witness that this value actually
 * reaches the pass as $DRIVE_PR_HANDOFF_AT, the one thing only a spawned
 * drive can show. See the suite's § Spawn-boundary integration floor.
 */
export function resolveHandoffAt(raw: string): string {
  if (raw === "careful") return "50";
  if (raw === "eager") return "75";
  if (raw === "continuous" || raw === "never") return "never";
  if (!isDigits(raw)) {
    fail(
      2,
      "--handoff-at takes a whole percent (1-100), 'never', or one of the",
      `aliases careful (50) / eager (75) / continuous (never). Got '${raw}'.`,
    );
  }
  const v = Number.parseInt(raw, 10);
  if (v < 1 || v > 100) {
    fail(
      2,
      `--handoff-at must be between 1 and 100, or 'never'. Got '${raw}'.`,
    );
  }
  return raw;
}

/**
 * The no-op streak after one more gate: `streak + 1` when this gate's
 * fingerprint is a REPEAT of the previous one, 0 otherwise.
 *
 * An unmeasurable gate — `next === null` — resets rather than extends, and so
 * does an unmeasurable PREVIOUS one, since `null === null` must not read as
 * sameness. The detector may only ever stop on positive evidence that two gates
 * observed the same work; anything less falls through to the `--max-rounds`
 * bound exactly as before. That asymmetry is the whole safety argument for
 * stopping a drive early, which is why it is a named function rather than the
 * conditional it replaced: the failure direction is a drive that stops while
 * rounds are still doing work, and the ways to reach a reset (a moved head, a
 * changed work set, a gate that could not measure, a first round with nothing
 * to compare) are one claim, not incidental branches.
 *
 * Its probe used to be five separate `drive.ts` drives — each running two or
 * three rounds against a stubbed forge to manufacture one fingerprint sequence,
 * ~53s of a 733s suite between them — while the
 * OTHER half of each, that `roundFingerprint` moves or refuses on the input in
 * question, was already asserted directly in `roundFingerprint — what counts as
 * evidence of sameness`. What the drives uniquely witnessed was the composition
 * reaching a real exit code, and drives are kept for exactly that: one that
 * must stop (14), and several that must not — thread-identity substitution,
 * `--no-head-sync` forwarding, and a growing parked set are each a different
 * way to move the fingerprint.
 */
export function advanceStallStreak(
  prev: string | null,
  next: string | null,
  streak: number,
): number {
  return next !== null && next === prev ? streak + 1 : 0;
}

/**
 * What a completed pass's exit code means to the DRIVE — the only place that
 * mapping is written down.
 *
 * `5` alone propagates. The pre-pass liveness check cannot cover the minutes a
 * round spends triaging and running gates, so `guarded-push.ts` re-checks at
 * the instant of the push and exits 5 on a PR that merged in between;
 * flattening that to a generic pass failure tells the caller its pass is broken
 * about a PR that is simply finished, and 5 is a documented TERMINAL state.
 *
 * And ONLY 5. The pass is an arbitrary command whose exit space is its own, so
 * blanket propagation would let an agent exiting 3 for its own reasons report
 * SHA-verified convergence — every other non-zero code flattens to 1. That
 * `only` is the half a probe has to enumerate to check, which is why this is a
 * total function of the code rather than two conditionals inline: the old probe
 * spawned a whole `drive.ts` per code it wanted to try, so the enumeration was
 * bounded by what the suite could afford (three codes, ~10.8s
 * <!-- measured -->) rather than by what the claim covers. Here it is free, so
 * the table below it asserts the boundary itself: 0, 5, and a spread of others
 * including the drive-status codes an agent could plausibly leak.
 */
export function passExitDisposition(code: number): {
  kind: "ok" | "not-open" | "failed";
  exit: number;
} {
  if (code === 5) return { kind: "not-open", exit: 5 };
  if (code !== 0) return { kind: "failed", exit: 1 };
  return { kind: "ok", exit: 0 };
}

/**
 * The driver-only exit codes — every one below is read out of
 * `TERMINAL_STATES` via `driverOnlyExitCode`, not hand-typed, so an edit to
 * the table and an edit to this file cannot silently disagree the way
 * `__tests__/terminal-states-consistency.ts`'s own drift check on
 * `drive.ts` verifies. Before this, each of these was either a
 * bare numeric literal repeated at every `return` site
 * (`MAX_ROUNDS`/`SINGLE_INSTANCE_LOCK`/`WORKTREE_UNCLEAN`/`STALLED`) or —
 * for the ones that already had a named constant — a SEPARATE literal that
 * merely happened to equal `TERMINAL_STATES`'s own copy
 * (`PASS_DEADLINE`/`QUOTA_PARKED`); either shape is the "transcribed by
 * hand, verified once by inspection" gap `terminal-states.ts`'s own header
 * used to describe for this whole category.
 */
/** The pass hit its deadline. */
export const PASS_DEADLINE_EXIT = driverOnlyExitCode("PASS_DEADLINE");

/** The pass died on a usage wall nothing should sleep through. */
export const QUOTA_PARKED_EXIT = driverOnlyExitCode("QUOTA_PARKED");

/** Hit `--max-rounds` without converging. */
export const MAX_ROUNDS_EXIT = driverOnlyExitCode("MAX_ROUNDS");

/**
 * This driver's single-instance lock (worktree or per-PR) was already held
 * by another driver, or was recovered by another driver mid-run. Shares its
 * exit code with `drive-status.ts`'s own `SESSION_LEASE_HELD` by design — a
 * distinct cause, not a collision (see that state's own entry in
 * `terminal-states.ts`).
 */
export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode(
  "SINGLE_INSTANCE_LOCK",
);

/** The worktree could not be certified clean at the point of reporting convergence. */
export const WORKTREE_UNCLEAN_EXIT = driverOnlyExitCode("WORKTREE_UNCLEAN");

/** The stall-streak bound was hit — the loop stopped making progress. */
export const STALLED_EXIT = driverOnlyExitCode("STALLED");

/** A mailbox stop directive ended the drive at a safe round boundary. */
export const MAILBOX_STOPPED_EXIT = driverOnlyExitCode("MAILBOX_STOPPED");

/** A mailbox pause outlived its bounded wait. */
export const MAILBOX_PAUSE_TIMEOUT_EXIT = driverOnlyExitCode(
  "MAILBOX_PAUSE_TIMEOUT",
);

/**
 * The result of one `runRepairPass` call, kept apart from a raw process exit
 * code: the spawned command is caller-supplied and its exit space is its
 * own, so a real pass exiting with, say, 18 or 19 would otherwise collide
 * with this driver's own `MAILBOX_STOPPED_EXIT` /
 * `MAILBOX_PAUSE_TIMEOUT_EXIT` sentinels — the bare-`number` return this
 * replaced conflated the two code spaces into one. `dispatched` says which
 * space `code` (when present) belongs to:
 *
 *  - `dispatched: true` — the pass actually ran; `code` is ITS exit code,
 *    arbitrary, never to be compared against this file's own exit
 *    constants. `postPassMailboxExit` is this driver's own exit code from a
 *    mailbox checkpoint taken immediately AFTER the pass completed — `null`
 *    on 'clear' or 'resumed' (the pass's own `code` is what matters either
 *    way), non-null on stop/pause-timeout/unreadable, in which case the
 *    caller returns it directly, in preference to interpreting `code`, once
 *    it has committed whatever budget this confirmed dispatch earned.
 *  - `dispatched: false, resumed: true` — a live pause cleared at the
 *    pre-spawn checkpoint before anything spawned; there is no code to
 *    report, and the caller re-gates from the top exactly like every other
 *    'resumed' checkpoint in this file.
 *  - `dispatched: false, resumed: false` — nothing spawned, and `code` is
 *    THIS driver's own exit code (a mailbox stop/pause-timeout/unreadable,
 *    or a lock takeover) — safe to return directly from `main()`.
 */
export type RepairDispatch =
  | { dispatched: true; code: number; postPassMailboxExit: number | null }
  | { dispatched: false; resumed: true }
  | { dispatched: false; resumed: false; code: number };

/**
 * How long one pass may run before it is killed, in seconds; `0` disables.
 *
 * THE PASS WAS THE LAST UNDEADLINED THING IN THIS SKILL, and that was a
 * deliberate position rather than an oversight: § Deadlines bounds every
 * outbound call precisely because a review round "takes as long as it takes".
 * The position is right about the round and wrong about the failure it leaves
 * open. Everything else here can only stop the loop BETWEEN rounds —
 * `--max-rounds`, the stall streak, the status poll's `--timeout` — so a pass
 * that never returns is invisible to all of them. The driver keeps refreshing
 * its claim from a timer, `drives.ts` keeps reporting it LIVE, and it waits
 * forever. The measured shapes: a pass that died mid-`git merge` leaving the
 * driver polling for a head change that could never arrive, and the
 * spawn's own comment conceding that a descendant which wants to PROMPT is "a
 * hang no deadline in this skill covers".
 *
 * NINETY MINUTES, and generous on purpose. This is a backstop against a wedge,
 * not a budget: a legitimate round can merge a base, run the full cumulative
 * validation plan and wait on the machine-wide test mutex. A deadline tight
 * enough to shape behaviour would kill honest rounds, which is a worse failure
 * than the one it prevents — so the number is set where nothing healthy
 * reaches it. Widen it if a real round ever does; do not tighten it to make
 * the loop feel faster.
 */
export function passTimeoutSeconds(): number {
  const raw = process.env.DRIVE_PR_PASS_TIMEOUT;
  if (raw === undefined || raw === "") return 90 * 60;
  if (!isDigits(raw)) return 90 * 60;
  const seconds = Number.parseInt(raw, 10);
  // `run()` forwards this to `setTimeout`, which takes a 32-bit signed
  // MILLISECOND delay: anything over 2147483647ms overflows and fires
  // IMMEDIATELY, killing the pass at once instead of after the generous
  // window this knob promises — the deadline inverted, exactly like the
  // other timeout accessors in lib/proc.ts already guard against. `0` is
  // exempt: it means "disabled" here, never a delay handed to a timer.
  if (seconds !== 0 && seconds * 1000 > 2_147_483_647) return 90 * 60;
  return seconds;
}

// ── Repair rounds ────────────────────────────────────────────────

/**
 * The two stops this loop used to hand back to a human for work it can do
 * itself: a red final-CI verdict, and a conflict with no workable finding.
 *
 * Both were defended on the same reasoning — "this is not a review round, and
 * a triage pass has nothing to do with it" — which is true of TRIAGE and false
 * of the PASS. The pass is a general agent with `/jig:fix-ci` and
 * `/jig:resolve-conflicts` available to it, and `base-sync.ts`'s exit-9
 * row already documents the conflict procedure *for a pass to follow*. The
 * asymmetry that gave the game away: a conflict WITH findings already comes
 * back `ROUND_READY` and gets merged as part of that round, so the identical
 * work was already being done — just never when it was the only thing left.
 *
 * Measured before the change (98 drives in the nine days after `ci:hold`
 * landed): 57 converged, 19 stopped for `/fix-ci`, 9 stopped on a conflict.
 * Roughly 29% of drives ended on a stop whose fix was a command.
 *
 * BUDGETS ARE IN-MEMORY, and that is deliberate rather than a shortcut. The
 * alternative — a `DriveState` field — is not available at an acceptable
 * price: `isUsableState` refuses any file written before a field existed
 * (there is no optional-and-defaulted tier, by documented design), so adding
 * one stops every in-flight drive on the fleet at its next state read. The
 * precedent is `noopRounds`, whose own streak is in-memory for the same
 * reason and whose reset-on-restart semantics are already documented to
 * operators in the skill's `README.md`. A re-armed drive therefore gets a fresh
 * repair budget, exactly as it gets a fresh stall streak.
 *
 * `0` disables a repair kind, restoring the older stop verbatim.
 */
const CI_REPAIR_ROUNDS_DEFAULT = 2;

const CONFLICT_REPAIR_ROUNDS_DEFAULT = 1;

/**
 * How long the converged head's final-CI polls sleep between reads, and how
 * many "no fresh required-check witness yet" polls are tolerated before the
 * drive gives up with exit `4` — 180 × 10s = 30 minutes.
 *
 * The bound exists because that particular wait has a state it cannot escape:
 * see the branch that reads it. `0` restores the unbounded wait.
 *
 * The poll and the two waits below are test pacing seams (`testPacing`, in
 * milliseconds), not configuration.
 */
export const FINAL_CI_POLL_SECONDS =
  testPacing("DRIVE_PR_FINAL_CI_POLL_MS", 10_000, 10) / 1000;

const FINAL_CI_WITNESS_POLLS_DEFAULT = 180;

/**
 * How long a drive lets GitHub schedule the workflows that removing the CI
 * hold label triggers before it re-reads the evidence.
 */
export const UNLABEL_SETTLE_SECONDS =
  testPacing("DRIVE_PR_UNLABEL_SETTLE_MS", 5_000, 10) / 1000;

/**
 * How often a paused drive, and a drive waiting out a usage wall, re-reads
 * its mailbox for a resume or stop.
 */
export const MAILBOX_POLL_SECONDS =
  testPacing("DRIVE_PR_MAILBOX_POLL_MS", 2_000, 10) / 1000;

export function finalCiWitnessPolls(): number {
  return wholeEnv(
    process.env.DRIVE_PR_FINAL_CI_WITNESS_POLLS,
    FINAL_CI_WITNESS_POLLS_DEFAULT,
  );
}

export function ciRepairRounds(): number {
  return wholeEnv(
    process.env.DRIVE_PR_CI_REPAIR_ROUNDS,
    CI_REPAIR_ROUNDS_DEFAULT,
  );
}

/**
 * The remote a printed conflict fix fetches and merges from:
 * `repository.remote`, else `origin`. The placeholder `<remote>` when the
 * setting cannot be read: the line is advice, and the drive's own reads of
 * the setting are what report it.
 */
export function fixRemote(): string {
  const read = readRemoteName();
  return "remote" in read ? read.remote : "<remote>";
}

/**
 * The printed conflict fix for a pull request whose base is `base`: fetch
 * the remote, then merge its base. The remote and the base ref are each
 * shell-quoted, since the line is a command a person may paste and the base
 * name comes from the forge; the unreadable-setting placeholder stays bare,
 * outside the quoted base, so filling it in never unquotes the base.
 */
export function conflictFixCommands(
  base: string,
  remote: string = fixRemote(),
): string {
  const placeholder = remote === "<remote>";
  const fetched = placeholder ? remote : shellQuote(remote);
  const merged = placeholder
    ? `${remote}/${shellQuote(base)}`
    : shellQuote(`${remote}/${base}`);
  return `bun "<skill-dir>/../../shared/command.ts" -- git fetch ${fetched}; after success, bun "<skill-dir>/../../shared/command.ts" -- git merge ${merged}`;
}

export function conflictRepairRounds(): number {
  return wholeEnv(
    process.env.DRIVE_PR_CONFLICT_REPAIR_ROUNDS,
    CONFLICT_REPAIR_ROUNDS_DEFAULT,
  );
}

/**
 * An unusable value in the environment is inherited noise, not an
 * instruction — the same stance `passTimeoutSeconds()` takes, and for the
 * same reason: a drive an operator did not misconfigure must not stop because
 * something upstream exported a typo.
 */
function wholeEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!isDigits(raw)) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/**
 * What a repair pass is asked to do. Carried to the pass in its ENVIRONMENT,
 * never by rewriting the argv after `--`: that argv is opaque to this script
 * (`claude -p "/jig:drive-pr 4818"`, a Codex invocation, a shell wrapper), and a
 * driver that edited it would be guessing at another tool's command grammar.
 * Env is already this driver's channel to its pass — `DRIVE_PR_TARGET`,
 * `DRIVE_PR_SESSION`, `DRIVE_PR_REFLECT_DUE` all ride it — and works
 * identically for every agent.
 *
 * `SKILL.md` § "Repair rounds" is the pass-side half of this contract.
 */
export type RepairTask = "ci-repair" | "conflict-resolve";

/**
 * The round budget: `--max-rounds` when given, else the repository's
 * `drive.max_rounds`, else the built-in default. The setting is read only
 * when the flag is absent, so a malformed one cannot block an explicit run.
 */
export function resolveMaxRounds(flag: string | undefined): number {
  if (flag !== undefined) {
    if (!isDigits(flag)) fail(2, "--max-rounds takes a whole number");
    const n = Number.parseInt(flag, 10);
    if (!Number.isSafeInteger(n) || n < 1)
      fail(2, "--max-rounds must be a whole number of at least 1");
    return n;
  }
  try {
    return maxRoundsSetting() ?? DEFAULT_MAX_ROUNDS;
  } catch (e) {
    return fail(1, `drive.ts: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Whether the reflect duty is armed: the depth past the last recorded
 * reflection passes the threshold and reflection is on (the `reflection`
 * configuration section); with it off the lesson has no store to reach.
 * Unreadable settings are reported and read as off.
 */
export function reflectDutyArmed(depth: number, threshold: number): boolean {
  if (!(depth > threshold)) return false;
  const reflection = reflectionSwitch();
  if (reflection instanceof Error)
    console.error(
      `  reflection settings unreadable, so no /jig:reflect duty: ${reflection.message}`,
    );
  return reflection === true;
}
