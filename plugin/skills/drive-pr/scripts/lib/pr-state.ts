/**
 * A PR's lifecycle state (`OPEN` / `CLOSED` / `MERGED`) for the state-ONLY
 * liveness reads.
 *
 * `gh pr view --json state` is a GraphQL call, and GraphQL is the bucket a
 * handful of parallel drives exhaust. A read that wants nothing but the state
 * goes over `readPrLiveness`'s conditional REST instead, where an unchanged PR
 * answers `304` and costs nothing.
 *
 * Only the reads that want NOTHING ELSE belong here. `stillOnHead` and the
 * opening snapshot compare `state` against `headRefOid`/`baseRefOid`/
 * `mergeable` from the SAME response, and REST and GraphQL disagree on
 * `baseRefOid` and mergeability — those stay GraphQL, so a comparison never
 * spans two sources.
 *
 * A URL or branch argument has no REST path (`readPrLiveness` needs a PR
 * number), so it is served by `gh pr view`, which resolves those itself. That
 * is a second CALLER SHAPE, not a preserved old contract.
 *
 * FAIL CLOSED, in `readPrLiveness`'s vocabulary: an unreadable, unparseable or
 * unrecognised answer is `{ ok: false }`, never a guessed state — the callers
 * already treat "cannot read" as INDETERMINATE and retry.
 */

import { readPrLiveness } from "./gh-conditional.ts";
import { ghCall } from "./proc.ts";

export type PrState = "OPEN" | "CLOSED" | "MERGED";

export type PrStateRead =
  | { ok: true; state: PrState }
  | { ok: false; reason: string };

function isPrState(s: string): s is PrState {
  return s === "OPEN" || s === "CLOSED" || s === "MERGED";
}

/**
 * `opts.timeoutSec` is the caller's whole budget for this read (drive-status's
 * remaining `--timeout`); it bounds the REST path's scope resolution and API
 * call together, and the `gh pr view` fallback's single call (which is not
 * started at all once the budget is spent). `opts.caller`
 * labels the REST request (see `CallContext.caller`); the fallback has no use
 * for it.
 */
export async function readPrState(
  pr: string,
  opts: { timeoutSec?: number; caller?: string } = {},
): Promise<PrStateRead> {
  if (/^\d+$/.test(pr)) {
    const r = await readPrLiveness(pr, {
      timeoutSec: opts.timeoutSec,
      caller: opts.caller,
    });
    return r.ok ? { ok: true, state: r.state } : r;
  }
  // A spent budget starts no call: `ghCall` clamps a tightening timeout to a
  // one-second floor, so passing 0 through would still run `gh` for a second.
  if (opts.timeoutSec !== undefined && opts.timeoutSec <= 0) {
    return { ok: false, reason: `gh pr view ${pr}: caller budget exhausted` };
  }
  const r = await ghCall(
    ["pr", "view", pr, "--json", "state", "-q", ".state"],
    {
      stderr: "ignore",
      timeoutSec: opts.timeoutSec,
    },
  );
  const state = r.code === 0 ? r.stdout.trim() : "";
  if (isPrState(state)) return { ok: true, state };
  return {
    ok: false,
    reason:
      state === ""
        ? `gh pr view ${pr} --json state failed (exit ${r.code})`
        : `gh pr view ${pr} reported the unrecognised state '${state}'`,
  };
}
