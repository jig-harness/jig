#!/usr/bin/env bun
import { siblingSkill } from "./lib/consumer.ts";
/**
 * Drive resolve-review-comments passes until the PR converges — from ANY agent
 * harness.
 *
 * The loop body has to be an agent (something must judge each finding
 * address/reject/defer), but the loop CONTROL does not. Keeping control here
 * instead of in a harness feature is what makes continuous mode work
 * identically for Claude Code and Codex: Claude has `/loop`, Codex has no
 * recurring-run primitive at all, and a bespoke poller in either one would be
 * a second implementation of the same stop condition.
 *
 * Usage:
 *   converge.ts [PR] [--bots-only] [--max-rounds N] [--job-pattern REGEX]
 *               [--timeout S] [--interval S] [--no-ci] [--dry-run]
 *               -- <command to run ONE pass> [args...]
 *
 *   The pass command is given as ARGV after `--`, and is executed directly —
 *   never through a shell. An opaque command string run through `sh -c` would
 *   have to be proven, by walking it character by character tracking quote
 *   state, to name the right PR in every `;`/`&&`/`||`/`|`-separated segment —
 *   because a pass that silently targets the current branch's PR edits and
 *   resolves threads on the wrong pull request. Taking argv removes the shell
 *   layer, so there are no segments to prove anything about and the guard below
 *   is an exact token test — and there is no `sh` to depend on, which is what
 *   lets this run on Windows. (Same reasoning, and same interface, as
 *   drive-pr's drive.ts.)
 *
 *     converge.ts 123 --bots-only -- codex exec "/resolve-review-comments --bots-only 123"
 *     converge.ts 123 --bots-only -- claude -p "/resolve-review-comments --bots-only 123"
 *
 *   The resolved PR number is also exported to the pass as $PR, and again as
 *   $RRC_TARGET_PR — plus $RRC_BOTS_ONLY under `--bots-only` — which
 *   list-unresolved-threads.ts enforces. Those two are the guarantee; the argv
 *   tests below are early typo-catchers, since neither question can be decided
 *   by inspecting an opaque prompt.
 *
 *   --max-rounds stop after N rounds (default 10). A finding the agent cannot
 *                fix would otherwise loop until the timeout, re-pushing
 *                forever.
 *   --dry-run    report what each round would do; never invoke the pass.
 *
 * Everything else is forwarded to await-round.ts, which owns the wait/stop
 * decision (including the merged-mid-loop abort). See that script's header.
 *
 * Claude Code users may instead skip this script entirely and wrap a single
 * pass in `/loop` — same contract, native pacing. That path gets no lease
 * release (§ `releaseSessionlessLease` below): it has no defined "done" moment
 * to hook, and a Claude Code session is identified anyway, so the record it
 * leaves behind is pid-backed and self-releasing.
 *
 * Exit codes:
 *   0  converged — a round found zero unresolved threads with checks settled
 *   1  a pass failed, or the PR state could not be read
 *   2  usage error
 *   4  timed out waiting for checks to settle
 *   5  the PR stopped being open mid-loop (merged or closed)
 *   6  hit --max-rounds without converging
 *   7  a reviewer check FAILED (propagated verbatim from await-round.ts)
 *   8  zero threads, but summary-only findings are outstanding on the head
 *      (propagated verbatim from await-round.ts)
 */

import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  envOrDefault,
  fail,
  isDigits,
  isSafeDigits,
  isEntryPoint,
  runMain,
  shellQuote,
} from "./lib/cli.ts";
import { resolvePr, run, tsArgv } from "./lib/proc.ts";

const here = dirname(fileURLToPath(import.meta.url));
const awaitRound = join(here, "await-round.ts");

/**
 * `/drive-pr`'s sessionless-lease release, addressed the way
 * `reply-to-thread.ts` addresses `assert-post-allowed.ts`: by path, spawned as a
 * CLI, never imported. The import direction is the reason — `/drive-pr` depends
 * on THIS skill, so importing its lease module here would close a cycle and make
 * a standalone `/resolve-review-comments` install unusable without a sibling it
 * is deliberately synced without.
 */
const DRIVE_PR_ROOT = siblingSkill("drive-pr", import.meta.dirname);
const RELEASE_SESSIONLESS_LEASE = join(
  DRIVE_PR_ROOT,
  "scripts",
  "release-sessionless-lease.ts",
);

/**
 * Hand this tree's tier-3 lease back, because this loop will spawn no further
 * pass.
 *
 * WHY HERE. A pass run under a runtime that identifies no session — a `codex
 * exec` pass, the documented invocation in this script's own header — cannot
 * take a pid-backed lease, so `/drive-pr`'s ladder gives it a `holder:
 * 'worktree'` PRESENCE record instead. That record's only liveness signal is
 * `lastSeen` freshness, so it kept refusing every OTHER working tree (exit 13)
 * for up to `$DRIVE_PR_LEASE_STALE_MIN` (default 360m) even after the resolver
 * finished cleanly — while an IDENTIFIED session got its release for free the
 * moment its pid died. This script is the fix because it is the only process in
 * that arrangement that knows when the work is over: the loop body must be an
 * agent, the loop CONTROL is here, and "no further pass will be spawned" is a
 * fact only this level holds.
 *
 * WHEN. Only on a run that ACTUALLY SPAWNED A PASS, and then only at the loop's
 * terminal exits. The gate is the `workedARound` flag below — never the identity
 * of the return statement reached, and never the pass's exit code. Both weaker
 * readings shipped here and both were wrong, each in the same direction:
 * releasing a record this invocation had never taken, which can only be a
 * SIBLING resolver's.
 *
 * EVERY `finish` call site in this function is reachable with no pass having
 * run. Not most of them, and not a list that needs maintaining — all of them,
 * which is the fact that makes a per-site rule the wrong shape: there is no
 * subset for it to be right about. Worked routes, each measured against this
 * code rather than imagined:
 *
 *   - `converge.ts <PR> --dry-run` against an ALREADY-CONVERGED PR. A dry run
 *     needs no pass command, so it walks past the usage check, and the
 *     `case 3` return fires on the FIRST await-round probe — above the
 *     `if (dryRun)` early return, which never runs. A command whose entire
 *     contract is "inspect, never act" deleted both records.
 *   - A forwarded-flag typo (`--timeout x`): the value is passed to
 *     `await-round.ts` unvalidated, that script exits 2 on it, and 2 lands in
 *     the `default:` branch on iteration 0.
 *   - An ordinary run against an already-converged PR: `case 3` on iteration 0,
 *     no pass. The most frequent of these.
 *   - A pass command that FAILS TO SPAWN — a typo'd path, or `codex`/`claude`
 *     not on `PATH`, which is what the first run on a fresh machine does.
 *     `run()` never rejects; it reports 127, the same code a real child may
 *     exit with. So this one reaches an EXISTING return site with the flag in
 *     the wrong state rather than adding a site, which is exactly why the gate
 *     reads `spawnFailed` and not `code`.
 *   - `--max-rounds 0`: the loop body never executes and control falls to the
 *     `finish(6)` at the bottom. Listed because no enumeration of "the doors"
 *     written while fixing the others had it — the universal above is what
 *     covers it, and the reason to state a universal instead of a list.
 *
 * The victim is always a SIBLING process in this same tree — the records are
 * actor-scoped, so nothing else can be reached — but the damage is cross-tree:
 * strip a live sessionless resolver's record and another worktree is admitted
 * (13 → 0), which is the duplicate-`**accepted**`-reply corruption the lease
 * fences exist to prevent. This is NOT the documented "two sessionless
 * resolvers in one tree" residual below; that one is about a resolver
 * FINISHING, while these fire when this invocation started nothing at all.
 *
 * Gating on the flag closes the whole class at once, and it costs nothing real:
 * the case the release exists for — a resolver that worked rounds and then
 * converged — always sets it. A run that converges at round 0 finds only records
 * some EARLIER run left, and that run released its own at its own exit.
 *
 * WHAT THE FLAG DOES NOT PROVE, since the honest bound is worth stating: that a
 * claim was actually taken. A pass that spawned and died before reaching its
 * first mutating `drive-state.ts` call took none, and nothing observable here
 * separates that from one that took several. "A pass ran" is the closest
 * available proxy, and it errs toward releasing in a case bounded by the
 * sessionless-siblings residual below.
 *
 * BEST EFFORT, ALWAYS. Every failure — `/drive-pr` not installed, an
 * incomplete install, a non-zero exit, a timeout — is
 * swallowed, and the caller's own exit code is never touched. This is cleanup,
 * not a gate: the record simply expires by staleness, exactly as it did before
 * this existed. That is the OPPOSITE ruling from `reply-to-thread.ts`'s fence,
 * which must refuse on any unreadable answer, and the difference is what the
 * failure permits: that one guards an irreversible POST, this one authorises
 * nothing at all.
 *
 * ONE RESIDUAL on "the pass is over by the time this runs": that holds for the
 * pass PROCESS, which `run()` awaits, not for a detached descendant it may have
 * backgrounded — a shape measured elsewhere in this repo. Such a descendant
 * outlives the `await` and can still be driving when the release fires. It is
 * the same exposure as the sessionless-siblings residual below and is bounded
 * the same way: the record never excluded a caller in its own tree, and the
 * descendant's next mutating `drive-state.ts` command re-claims it.
 *
 * AND ONE ON ACTOR ANCHORING, stated rather than closed. `/drive-pr`'s
 * `drive.ts` exports `$DRIVE_PR_WORKTREE` into every pass it spawns, which
 * `actor.ts` reads, so a pass that `cd`s elsewhere between tool calls still
 * resolves the tree the driver is driving. This script exports no such anchor,
 * so a wandering pass could claim its record under one actor while the release
 * resolves another — and the release then finds nothing and does nothing.
 *
 * NOT fixed here, deliberately. The failure is the safe direction (a no-op,
 * which is what best-effort already promises everywhere else in this comment),
 * while the fix is not confined to the release: exporting the anchor changes
 * which actor the PASS claims under, i.e. lease admission and hold provenance
 * for every converge-driven round, in a model `actor.ts` states must not be
 * settable except by a driver that owns the tree. It would also put a
 * `DRIVE_PR_*` export in the skill that ships STANDALONE without `/drive-pr`,
 * widening a coupling `../../drive-pr/references/post-fence.md` deliberately
 * limits to a spawn. A wandering pass already mis-attributes drive state
 * generally (`actor.ts` documents that); this adds one more consequence to it
 * rather than a new hazard, and closing it belongs with that pre-existing
 * problem, not with a lease release.
 */
async function releaseSessionlessLease(pr: string): Promise<void> {
  try {
    // `lstat`, matching `reply-to-thread.ts`'s probe for its sibling script,
    // though the stakes invert: there, only a positively-confirmed ENOENT may
    // skip a fence, so `existsSync` conflating absence with an indeterminate
    // failure was a fail-open. Here EVERY unreadable answer skips anyway, so
    // this is instrument consistency rather than a load-bearing distinction —
    // and the file itself is probed, not the skill root, because an incomplete
    // `/drive-pr` has nothing to release with either.
    lstatSync(RELEASE_SESSIONLESS_LEASE);
  } catch {
    return;
  }
  try {
    const r = await run(
      tsArgv(RELEASE_SESSIONLESS_LEASE, [
        "--pr",
        pr,
        "--what",
        "converge.ts (loop exit)",
      ]),
      // Bounded well below the state mutex's own ceiling
      // (`LOCK_ACQUIRE_MAX_SEC`, 300s). A wait that long means something in this
      // tree is actively mutating drive state, in which case declining to
      // release is the right answer rather than a lost one.
      { timeoutSec: 60, stderr: "inherit" },
    );
    if (r.code !== 0) {
      console.error(
        `converge: could not release this tree's drive lease for PR #${pr} (exit ${r.code}); it clears on its own once stale.`,
      );
    }
  } catch (e) {
    // Belt-and-braces only, and labelled so it is not mistaken for the
    // spawn-failure handler: `run()` does not reject — a failed spawn arrives
    // as `r.code === 127` with `r.spawnFailed`, handled above. Nothing here is
    // known to throw; this exists so a future change that introduces a throw
    // cannot turn cleanup into a failure of the caller.
    console.error(
      `converge: could not release this tree's drive lease for PR #${pr} (${e instanceof Error ? e.message : String(e)}); it clears on its own once stale.`,
    );
  }
}

async function main(): Promise<number> {
  let pr = "";
  let maxRounds = "10";
  let dryRun = false;
  let botsOnly = false;
  const forward: string[] = [];
  const agent: string[] = [];
  let sawDdash = false;

  // Validated here because await-round.ts compares it numerically downstream,
  // and the skill advertises it as tunable — a typo is a plausible user
  // action, and it should fail as the usage error it is before any round runs.
  const reflectRaw = envOrDefault("REFLECT_THRESHOLD", "0");
  if (!isDigits(reflectRaw)) {
    fail(2, `REFLECT_THRESHOLD must be a whole number (got '${reflectRaw}')`);
  }

  const argv = process.argv.slice(2);
  const take = (flag: string, i: number): string => {
    if (i + 1 >= argv.length) fail(2, `${flag} requires a value`);
    return argv[i + 1] ?? "";
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (sawDdash) {
      agent.push(a);
      continue;
    }
    switch (a) {
      case "--":
        sawDdash = true;
        break;
      case "--max-rounds":
        maxRounds = take(a, i++);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--bots-only":
        botsOnly = true;
        forward.push(a);
        break;
      case "--no-ci":
        forward.push(a);
        break;
      case "--job-pattern":
      case "--timeout":
      case "--interval":
        forward.push(a, take(a, i++));
        break;
      default:
        if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
        pr = a;
    }
  }

  if (!dryRun && agent.length === 0) {
    fail(
      2,
      "usage: converge.ts [PR] [--bots-only] -- <command to run one pass> [args...]",
    );
  }

  if (!isSafeDigits(maxRounds))
    fail(2, "--max-rounds takes a whole number within the safe integer range");
  const maxRoundsN = Number.parseInt(maxRounds, 10);

  const explicitPr = pr;
  pr = await resolvePr(pr);
  if (pr === "") fail(1, "converge: could not resolve a PR number");
  // Digits before the guard below interpolates it into a RegExp — a
  // metacharacter would throw a SyntaxError instead of a usage error.
  if (!isDigits(pr)) fail(2, `converge: PR must be a number (got '${pr}')`);
  // Exported so a pass command may reference the same PR this script is
  // waiting on without repeating the number.
  process.env.PR = pr;

  // The authoritative, out-of-band statement of which PR this run is about,
  // and whether the pass is scoped to bot threads. Both argv tests below
  // INSPECT an opaque pass command, and inspection cannot decide either
  // question: `codex exec "/resolve-review-comments 999" --label 123`
  // satisfies the delimited-token test for 123 while targeting 999, and
  // `claude -p "... do not use --bots-only"` satisfies the scope test while
  // asking for the opposite. Every pass
  // reaches list-unresolved-threads.ts — it is the only way to obtain a
  // threadId, which reply-to-thread.ts and resolve-thread.ts both require —
  // so that script is the chokepoint where these stop being inferences from
  // prompt text and become assertions. Same mechanism, and same reasoning, as
  // drive-pr's $DRIVE_PR_TARGET.
  process.env.RRC_TARGET_PR = pr;
  if (botsOnly) process.env.RRC_BOTS_ONLY = "1";

  // Guard the mis-targeting the header describes. Only when the caller NAMED
  // a PR explicitly — with no argument both this script and the pass resolve
  // the same branch PR, so there is nothing to disagree about. A bare
  // substring test would let PR 12 satisfy a pass targeting 123, so match the
  // number as a delimited token. This stays as a cheap early typo-catcher —
  // it fails before a round is spent, with a message naming the command — but
  // the guarantee is $RRC_TARGET_PR above.
  if (explicitPr !== "" && agent.length > 0) {
    const token = new RegExp(`(?:^|[^0-9])${explicitPr}(?:[^0-9]|$)`);
    if (!agent.some((word) => token.test(word))) {
      fail(
        2,
        `refusing to run: PR #${explicitPr} was given, but the pass command names no PR:`,
        `  ${agent.map(shellQuote).join(" ")}`,
        "The pass would target the current branch’s PR instead — editing and",
        "resolving threads on a different pull request. Name it explicitly, e.g.",
        `  converge.ts ${explicitPr} -- codex exec "/resolve-review-comments ${explicitPr}"`,
      );
    }
  }

  // --bots-only scopes what await-round.ts COUNTS; if the pass itself is not
  // also scoped it will resolve human threads the count never included, and
  // the loop then converges on a different set than the one it was watching.
  // Also a typo-catcher only: `--bots-only` appearing anywhere in an opaque
  // prompt satisfies this, including in a sentence asking for the opposite.
  // $RRC_BOTS_ONLY above is what actually scopes the pass.
  if (botsOnly && agent.length > 0) {
    if (!agent.some((word) => word.includes("--bots-only"))) {
      fail(
        2,
        "refusing to run: --bots-only was given, but the pass command does not pass it.",
        "The pass would act on human threads the convergence count excludes.",
      );
    }
  }

  // Round counting and the wind-down /reflect prompt live in await-round.ts,
  // not here: that script is the one both harness paths call, so a counter
  // kept here would never fire for a Claude /loop session that drives passes
  // directly.

  // A dry run inspects; it does not work a round. Counting it would inflate
  // the session total behind the reflect prompt.
  const probeFlags = dryRun ? ["--no-count"] : [];

  // Did this invocation actually spawn a pass? The ONE gate on the release —
  // see `releaseSessionlessLease` for why every `finish` call site below is
  // reachable with this still false, and why gating on which return was
  // reached (this fix's own first shape) therefore closed nothing. Every loop
  // exit routes through `finish`, including `--dry-run`, so the flag is the
  // sole guarantee and a probe can therefore falsify it; call-site placement
  // guarantees nothing on its own and must not be relied on as a second,
  // unstated rule.
  let workedARound = false;
  const finish = async (code: number): Promise<number> => {
    if (workedARound) await releaseSessionlessLease(pr);
    return code;
  };

  let round = 0;
  while (round < maxRoundsN) {
    const status = await run(
      tsArgv(awaitRound, [pr, ...forward, ...probeFlags]),
      { stdout: "inherit", stderr: "inherit" },
    );

    switch (status.code) {
      case 0:
        break; // round ready — fall through and work it
      case 3:
        console.error(`converged after ${round} round(s) in this run`);
        return await finish(0);
      default:
        // 1/4/5/7/8 propagate verbatim — and each one means this loop is done
        // issuing passes just as certainly as convergence does, so each
        // releases too, IF this run worked one. Reached on iteration 0 by a
        // forwarded-flag usage error (await-round.ts exits 2 on a bad
        // `--timeout`), which is exactly why `finish` gates rather than fires.
        return await finish(status.code);
    }

    round += 1;
    console.error(`--- round ${round}/${maxRoundsN} on PR #${pr} ---`);

    if (dryRun) {
      console.error(`(dry-run) would run: ${agent.map(shellQuote).join(" ")}`);
      // Through `finish` like every other loop exit, deliberately: a dry run
      // inspects and never spawns a pass, so `workedARound` is false and the
      // gate refuses it. Routing it around `finish` instead would make its
      // safety a property of where the `return` sits — which is precisely the
      // reasoning that missed the converged-PR dry run above.
      return await finish(0);
    }

    const pass = await run(agent, {
      stdinInherit: true,
      stdout: "inherit",
      stderr: "inherit",
    });
    // A pass that RAN may now hold a tier-3 claim of its own, whatever its exit
    // code — the claim is taken during it, so failing afterwards does not undo
    // one. A pass that never SPAWNED holds nothing, and the two are not
    // distinguishable from `code`: `run()` reports a failed spawn as 127
    // (the shell's code for a command that could not be found), and a real
    // child may exit 127 too. `spawnFailed` is the field that
    // separates them (see `RunResult`), and reading it here is what keeps a
    // `codex`/`claude` binary missing from `PATH` — the first run on a fresh
    // machine — from releasing a record this invocation never took.
    //
    // Monotone: once a round has genuinely run, a later failed spawn must not
    // retract the claim that one may exist.
    if (!pass.spawnFailed) workedARound = true;
    if (pass.code !== 0) {
      console.error(
        pass.spawnFailed
          ? `pass command could not be spawned on round ${round} (nothing ran); not resolving further`
          : `pass failed on round ${round}; not resolving further`,
      );
      return await finish(1);
    }
  }

  console.error(
    `hit --max-rounds (${maxRoundsN}) without converging on PR #${pr}`,
  );
  return await finish(6);
}

if (isEntryPoint(import.meta.url)) runMain("converge", main);
