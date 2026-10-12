#!/usr/bin/env bun
import { siblingSkill } from "./lib/consumer.ts";
/**
 * Print the ordinal of the review round currently being worked on a PR — the
 * mechanical read behind the decline ladder's round bands
 * (references/triage-rubric.md § The decline ladder).
 *
 * Usage: current-round.ts [PR]
 *
 * The answer is the HIGHEST ordinal any review loop in this clone has counted
 * for the PR, because there is more than one loop and they count separately:
 *
 * - `await-round.ts`'s head-SHA-keyed counter in the git dir
 *   (`resolve-review-rounds-<pr>`), bumped once per distinct head when a round
 *   becomes ready and reset at convergence — the `/resolve-review-comments`
 *   continuous path;
 * - `drive-pr`'s own durable `rounds`, read through its documented
 *   `drive-state.ts rounds` CLI rather than its file layout — the `/drive-pr`
 *   path, which never invokes `await-round.ts` at all.
 *
 * Reading only the first left the cutoff inert under the primary unattended
 * driver — `/drive-pr` reported 0 at every round while its own state said
 * otherwise. `max` rather than a
 * precedence: both count the same thing (distinct reviewed heads), neither is
 * running when its counter is absent, and an absent counter must not pull the
 * answer down below a loop that did count.
 *
 * `max` is a LOWER BOUND on the PR's rounds, not the exact count, because the
 * two counters cover disjoint sets of heads. A PR that ran three
 * `await-round.ts` rounds, converged (which deletes that counter), and then
 * switched to `/drive-pr` reports 1–3 for the next three rounds rather than
 * 4–6, so the cutoff arms three rounds late. Stated rather than fixed: the
 * error is one-directional and always toward a LOWER ordinal, which only
 * delays a rule that exists to decline findings — the same fail-open polarity
 * as every other branch here. The remedy is a single head-keyed counter shared
 * by both skills, which is a cross-skill format change; it is not worth that
 * for a rule whose whole job is damping.
 *
 * Prints `0` when nothing has counted a round here — a fresh worktree, a
 * counter already reset at wind-down, or a one-shot manual pass, which runs
 * neither loop and so counts nothing (`SKILL.md` lets it skip `await-round.ts`
 * outright). The cutoff simply does not arm on 0, and a rubric rule keyed on
 * this must never fire from stale or recalled state — hence this script
 * instead of session memory.
 *
 * Reading both loops makes the answer PR-scoped, not session-scoped, and that
 * is the intended semantics rather than a leak. `await-round.ts` clears its
 * own counter at convergence; `drive-pr` keeps `rounds` durably and clears it
 * only on an explicit `drive-state.ts reset`. So a NEW session on a PR that a
 * drive already took to round 6 reads 6 and arms the cutoff immediately
 *. That is correct on the merits the rule is
 * built from: the cutoff prices a round, and a PR that has had six rounds has
 * had six regardless of which loop counted them or which one has since wound
 * down. The alternative — clearing drive-pr's count at its own convergence —
 * would corrupt the round budget and the reflect cadence that same field
 * carries, to make this rule forget something true.
 *
 * A counter that EXISTS but cannot be read, or that holds something which is
 * not a round ordinal, also reads 0 — but it is announced on stderr instead
 * of passing silently as a fresh session. The VALUE fails open on purpose:
 * the cutoff only ever declines findings, so arming it from state that could
 * not be established is the one direction that loses them, and absent-counter
 * is the dominant case. Silence was the actual defect, not the 0. stdout
 * stays the number and nothing else, so callers parse it unchanged.
 *
 * Exit 0 with the count on stdout; 1 when the PR or git dir cannot be
 * resolved; 2 on usage. Never touches the network when the PR is explicit.
 *
 * On Windows, invoke through the runtime (`bun current-round.ts …`) — a
 * shebang only carries the POSIX direct-execution path.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fail,
  isDigits,
  isEntryPoint,
  isSafeDigits,
  runMain,
} from "./lib/cli.ts";
import { git, resolvePr, run } from "./lib/proc.ts";

/** `drive-state.ts rounds` is a pure read — no lock, no lease, no write. */
const DRIVE_STATE = join(
  siblingSkill("drive-pr", import.meta.dirname),
  "scripts",
  "drive-state.ts",
);

/**
 * How many rounds `drive-pr`'s own driver has counted for this PR, or 0 when
 * that loop is not driving here.
 *
 * Absence is the ordinary answer and is silent, but it has to be established
 * BEFORE the spawn, not from its exit code: the executable is
 * `process.execPath`, which always exists, so a missing entrypoint is the
 * runtime's own ordinary failure (bun exits 1, measured) and is
 * indistinguishable from a script that ran and failed. An exit-code
 * heuristic therefore printed the anomaly line on every read for anyone who
 * installed this skill without its sibling.
 *
 * So: no sibling skill, no spawn, no diagnostic. Past that, anything other
 * than a clean numeric answer — a non-zero exit from a script that DID run,
 * a timeout, output that is not a count — is an anomaly, announced for the
 * same reason the counter file's is, and read as 0 for the same fail-open
 * reason.
 */
async function drivePrRounds(pr: string): Promise<[number, string]> {
  if (!existsSync(DRIVE_STATE)) return [0, ""];
  const r = await run([process.execPath, DRIVE_STATE, "rounds", pr], {
    timeoutSec: 30,
  });
  if (r.code !== 0) {
    const why = r.timedOut ? "timed out" : `exited ${r.code}`;
    return [0, `drive-pr round count unavailable (${why})`];
  }
  // The SAME predicate the counter file gets, not a looser digit test. This
  // input needs it at least as much: drive-state.ts's own `isCount` accepts
  // any non-negative integer, including one past MAX_SAFE_INTEGER, and prints
  // it as digits — and a 400-digit answer parses to Infinity, which `Math.max`
  // propagates and the script prints literally, arming a `round >= 4` consumer
  // off corrupt state. Tightening one source and leaving its sibling on
  // `isDigits` was an earlier fix applied to the instance instead of the
  // class.
  const out = r.stdout.trim();
  if (!isRoundOrdinal(out)) {
    if (out === "0") return [0, ""];
    return [
      0,
      `drive-pr round count is not a canonical ordinal (${JSON.stringify(out)})`,
    ];
  }
  return [Number.parseInt(out, 10), ""];
}

/**
 * Is this counter content a round ordinal at all? `await-round.ts` only ever
 * writes `${n}\n` for n ≥ 1 and removes the file at convergence, so anything
 * else in a file that EXISTS is anomalous — a partial write, or a foreign
 * writer — and `main` says so rather than letting it read as a fresh session.
 *
 * Canonical positive integer, and safely representable. A bare digit test is
 * not enough: `'9'.repeat(400)` passes it, `parseInt` returns `Infinity`, and
 * the script prints the literal `Infinity` — which is not a number a caller
 * can parse, and which arms a `round >= 4` cutoff off corrupt state, the
 * exact inversion of the fail-open contract.
 * `0`, `004` and whitespace-padded forms are refused for the same reason: the
 * producer never writes them, so their presence is evidence of a writer this
 * script cannot vouch for.
 *
 * Deliberately STRICTER than await-round.ts's own `readCount`, which keeps the
 * looser test. That one only feeds its own `+ 1`, where tolerating `004` costs
 * nothing and refusing it would reset a merely non-canonical counter to 1;
 * this one PUBLISHES the ordinal to a rule that declines findings, so it has
 * to answer for what it read.
 *
 * Built on the shared `isSafeDigits` (`lib/cli.ts`) rather than its own
 * `Number.isSafeInteger` check, so the safety bound and the canonical-form
 * (no leading zero, no `0` itself) check cannot drift apart the way this
 * file's own two counters once did, and so a THIRD script accepting a bare
 * ordinal has one shared primitive to reuse instead of reinventing it a third
 * time (`triage-ladder.ts --round` was the second).
 */
export function isRoundOrdinal(raw: string): boolean {
  const n = raw.trim();
  return n[0] !== "0" && isSafeDigits(n);
}

/**
 * The counter file's contents as a round ordinal: a canonical positive
 * ordinal parses, anything else — absent file (null), junk, empty, `0`,
 * unrepresentable — reads as 0.
 */
export function parseRoundCount(raw: string | null): number {
  if (raw === null || !isRoundOrdinal(raw)) return 0;
  return Number.parseInt(raw.trim(), 10);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length > 1 || argv[0]?.startsWith("--")) {
    fail(2, "usage: current-round.ts [PR]");
  }
  const pr = await resolvePr(argv[0] ?? "");
  if (pr === "" || !isDigits(pr)) {
    fail(1, "current-round: could not resolve a PR number");
  }
  const gitDir = await git(["rev-parse", "--git-dir"], { stderr: "ignore" });
  if (gitDir.code !== 0 || gitDir.stdout.trim() === "") {
    fail(1, "current-round: not inside a git repository");
  }
  const counter = join(gitDir.stdout.trim(), `resolve-review-rounds-${pr}`);
  let raw: string | null = null;
  let unreadable = "";
  try {
    raw = readFileSync(counter, "utf8");
  } catch (err) {
    // ENOENT is the dominant and wholly normal case — a fresh worktree, or a
    // counter already removed at wind-down. Every OTHER errno (a permissions
    // error, an I/O error, a directory sitting in its place) wears the same
    // return value while meaning something entirely different, and must not
    // pass as "fresh session" unremarked.
    const code = (err as NodeJS.ErrnoException)?.code ?? "";
    if (code !== "ENOENT") unreadable = code === "" ? String(err) : code;
    raw = null;
  }
  const indeterminate =
    unreadable !== ""
      ? `is unreadable (${unreadable})`
      : raw !== null && !isRoundOrdinal(raw)
        ? `holds no round ordinal (${JSON.stringify(raw.slice(0, 40))})`
        : "";
  if (indeterminate !== "") {
    console.error(
      `current-round: counter ${counter} ${indeterminate} — reading 0, so the round-indexed cutoff does not arm this pass`,
    );
  }
  const [driveRounds, driveWhy] = await drivePrRounds(pr);
  if (driveWhy !== "") {
    console.error(
      `current-round: ${driveWhy} — reading 0 for that loop, so the round-indexed cutoff may not arm this pass`,
    );
  }
  console.log(String(Math.max(parseRoundCount(raw), driveRounds)));
  return 0;
}

if (isEntryPoint(import.meta.url)) runMain("current-round", main);
