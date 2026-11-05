#!/usr/bin/env bun
import { siblingSkill } from "../../../shared/consumer.ts";
/**
 * Print the ordinal of the review round currently being worked on a PR — the
 * mechanical read behind the decline ladder's round bands
 * (references/triage-rubric.md § The decline ladder).
 *
 * Usage: current-round.ts [PR]
 *
 * The answer is the pull request's review round: the one head-keyed record
 * every loop working it counts into, kept in `/drive-pr`'s database
 * (`drive-pr/scripts/lib/state/review-rounds.ts`). `await-round.ts` counts a
 * round there for the `/resolve-review-comments` continuous path, a drive
 * counts its own rounds there, and the drive's ledger carries the same
 * number. It is read through `drive-state.ts rounds`, spawned by path rather
 * than imported, because `/drive-pr` depends on this skill and not the other
 * way round.
 *
 * The ordinal is PR-scoped, not session-scoped, and that is the intended
 * semantics: the cutoff prices a round, and a PR that has had six rounds has
 * had six, whichever loop counted them and whichever has since wound down. A
 * hand-driven loop's convergence settles its rounds for its reflection
 * prompt without lowering this number; only `drive-state.ts reset` clears it.
 *
 * Prints `0` when nothing has counted a round for the PR — a fresh pull
 * request, a one-shot manual pass (which runs no loop and so counts nothing,
 * `SKILL.md` lets it skip `await-round.ts` outright), or a standalone install
 * of this skill with no `/drive-pr` beside it, where nothing keeps the
 * count. The cutoff simply does not arm on 0, and a rubric rule keyed on this
 * must never fire from stale or recalled state — hence this script instead of
 * session memory.
 *
 * Anything other than a clean numeric answer from `drive-state.ts` — a
 * non-zero exit, a timeout, output that is not a canonical ordinal — reads
 * as 0 too, but is announced on stderr instead of passing silently as a fresh
 * pull request. The VALUE fails open on purpose: the cutoff only ever
 * declines findings, so arming it from state that could not be established
 * is the one direction that loses them. stdout stays the number and nothing
 * else, so callers parse it unchanged.
 *
 * Exit 0 with the count on stdout; 1 when the PR cannot be resolved; 2 on
 * usage. Never touches the network when the PR is explicit.
 *
 * On Windows, invoke through the runtime (`bun current-round.ts …`) — a
 * shebang only carries the POSIX direct-execution path.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fail, isDigits, isSafeDigits, runMain } from "../../../shared/cli.ts";
import { resolvePr, run } from "../../../shared/proc.ts";

/** `drive-state.ts rounds` is a pure read — no lock, no lease, no write. */
const DRIVE_STATE = join(
  siblingSkill("drive-pr", import.meta.dirname),
  "scripts",
  "drive-state.ts",
);

/**
 * Is this answer a round ordinal at all? Canonical positive integer, and
 * safely representable. A bare digit test is not enough: `'9'.repeat(400)`
 * passes it, `parseInt` returns `Infinity`, and the script would print the
 * literal `Infinity` — which a caller cannot parse, and which arms a
 * `round >= 4` cutoff off corrupt state, the inversion of the fail-open
 * contract. `004` and padded forms are refused for the same reason: the
 * producer never prints them. Built on the shared `isSafeDigits`
 * (`shared/cli.ts`), so the safety bound and the canonical-form check cannot
 * drift apart.
 */
export function isRoundOrdinal(raw: string): boolean {
  const n = raw.trim();
  return n[0] !== "0" && isSafeDigits(n);
}

/**
 * The pull request's review round and, when it could not be read, why.
 *
 * Absence is the ordinary answer and is silent, but it has to be established
 * BEFORE the spawn, not from its exit code: the executable is
 * `process.execPath`, which always exists, so a missing entrypoint is the
 * runtime's own ordinary failure (bun exits 1) and is indistinguishable from
 * a script that ran and failed. So: no sibling skill, no spawn, no
 * diagnostic.
 */
async function reviewRound(pr: string): Promise<[number, string]> {
  if (!existsSync(DRIVE_STATE)) return [0, ""];
  const r = await run([process.execPath, DRIVE_STATE, "rounds", pr], {
    timeoutSec: 30,
  });
  if (r.code !== 0) {
    const why = r.timedOut ? "timed out" : `exited ${r.code}`;
    return [0, `the review round count is unavailable (${why})`];
  }
  const out = r.stdout.trim();
  if (out === "0") return [0, ""];
  if (!isRoundOrdinal(out))
    return [
      0,
      `the review round count is not a canonical ordinal (${JSON.stringify(out)})`,
    ];
  return [Number.parseInt(out, 10), ""];
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
  const [round, why] = await reviewRound(pr);
  if (why !== "") {
    console.error(
      `current-round: ${why} — reading 0, so the round-indexed cutoff does not arm this pass`,
    );
  }
  console.log(String(round));
  return 0;
}

if (import.meta.main) runMain("current-round", main);
