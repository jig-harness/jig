#!/usr/bin/env bun
/**
 * Decide what a parent (epic) issue's Linear status should become, given its
 * sub-issues' current states — the Step 5a "parent-status decision" SKILL.md
 * previously spelled out as inline pseudocode instead of a tested callsite
 * (PR #4999 fixed the pseudocode's factual errors but explicitly
 * left this move out of scope).
 *
 * Type: Decision
 * Input: JSON on stdin — see `ReconcileInput` below. The caller (SKILL.md
 *   Step 5a) is responsible for fetching and, for the MCP transport, fully
 *   paginating the child list before invoking this script; a script cannot
 *   itself issue `mcp__linear__*` tool calls. Fetching or pagination that
 *   did not complete must be reported via `found`/`truncated`, never by
 *   silently handing over a partial `children` array.
 * Output: JSON `ReconcileDecision` on stdout.
 *
 * Usage:
 *     echo "$RECONCILE_INPUT_JSON" | bun reconcile_parent_status.ts
 *
 * Exit codes: 0 decided, 2 usage, 1 unreadable/invalid stdin.
 *
 * Runs under Bun and under Node ≥ 22.18 (type stripping): only `node:` APIs,
 * erasable-syntax-only TypeScript — the same contract as the other do-issue
 * scripts.
 */

import { classifyChildState, KNOWN_STATE_TYPES } from "./get_issue.ts";
import { isEntryPoint, parseArgs } from "./lib/cli.ts";

/** A label as either transport supplies it: a flat string (MCP, get_issue.ts) or `{ name }`. */
export type LabelLike = string | { name?: string };

export interface ReconcileChildInput {
  state?: { name?: string; type?: string };
  labels?: LabelLike[];
}

export interface ReconcileInput {
  /**
   * False when the child listing/fetch itself failed — e.g. `get_issue.ts`
   * returned `found: false`. Defaults to true. A failed fetch is not "no
   * children"; treating it as vacuously complete would silently advance a
   * parent whose sub-issues were never actually re-read.
   */
  found?: boolean;
  /**
   * True when pagination could not confirm it reached every child — e.g. a
   * `mcp__linear__list_issues` page fetch threw partway through the
   * `hasNextPage` loop, or a page came back with an unreadable `pageInfo`.
   * Defaults to false. A truncated listing must not be reconciled against as
   * if it were the complete set.
   */
  truncated?: boolean;
  /** The PARENT issue's own labels (checked for `manual-ops`). */
  parentLabels: LabelLike[];
  /** Every sub-issue, already paginated to completion by the caller. */
  children: ReconcileChildInput[];
}

export type ReconcileVerdict =
  | "listing_failed"
  | "keep_in_progress"
  | "extract_and_close_eligible"
  | "set_status";

export type ParentState = "Done" | "Ops Pending" | "In Progress" | "In Review";

export interface ReconcileDecision {
  verdict: ReconcileVerdict;
  parentState: ParentState | null;
  reason: string;
}

/**
 * A tail an epic was never scoped to finish — its presence on every
 * remaining incomplete child is what makes the epic extract-and-close
 * eligible instead of stuck "In Progress" forever. Mirrors SKILL.md's
 * `EXTRACTABLE_TAILS` (Step 5a) — kept here as the one place that list is
 * evaluated now that the surrounding decision has a callsite.
 */
export const EXTRACTABLE_TAILS = [
  "hitl:legal",
  "manual-ops",
  "hitl:tactical",
  "pr-followup",
] as const;

/**
 * The "started"-type sub-issue states that still count as "merged and
 * parked" for the parent-status guard, checked by exact NAME rather than
 * `classifyChildState`'s `type`-based bucket. "In Review" and "Ops Pending"
 * share `type: "started"` with "In Progress" (all three are started-category states), so the
 * `type` field alone cannot tell a parked child from a genuinely active one
 * — only the name can. "In Progress" is deliberately absent: a child still
 * there must keep the parent "In Progress" too (route to Step 4b), never let
 * it cap out at a later state.
 *
 * This is deliberately NOT the full merged-or-parked set — Done/Canceled/
 * Duplicate are covered by `classifyChildState`'s bucket instead (see
 * `allMergedOrParked` below), which also correctly recognizes an
 * unrecognized-but-Done-like name (e.g. a "Closed" state via the name-match
 * fallback). Folding those into a raw-name list here would let a
 * type-contradicting name — `{ name: 'Done', type: 'started' }` — slip
 * through as parked purely because "Done" is spelled correctly, even though
 * its own `type` says the work is still active.
 */
export const PARKED_ACTIVE_STATE_NAMES = ["In Review", "Ops Pending"] as const;

/** Least → most advanced, for capping the parent at its least-advanced open sub-issue. */
export const STATE_LADDER = [
  "In Progress",
  "In Review",
  "Ops Pending",
] as const;

/**
 * Whether a child's exact `state.name` may be trusted for the
 * `PARKED_ACTIVE_STATE_NAMES` fallback — mirrors `classifyChildState`'s own
 * precedence: a recognized `type` is authoritative over the name, and only
 * an absent/unrecognized type defers to it. Without this, a corrupted or
 * mismatched record like `{ name: 'In Review', type: 'unstarted' }` — Todo,
 * per `KNOWN_STATE_TYPES` — let the name override a type that explicitly
 * says the work hasn't started, and the same for a recognized `backlog`/
 * `triage` type paired with an "Ops Pending" name.
 */
function nameTrustworthyForParkedCheck(
  state: { name?: string; type?: string } | undefined,
): boolean {
  const type = (state?.type ?? "").toLowerCase();
  return !KNOWN_STATE_TYPES.has(type) || type === "started";
}

function labelName(l: LabelLike | undefined): string {
  if (l === undefined) return "";
  return typeof l === "string" ? l : (l.name ?? "");
}

export function reconcileParentStatus(
  input: ReconcileInput,
): ReconcileDecision {
  const found = input.found ?? true;
  if (!found) {
    return {
      verdict: "listing_failed",
      parentState: null,
      reason:
        "Sub-issue listing failed — the Linear refresh did not succeed. Report the error and do not reconcile parent status.",
    };
  }
  const truncated = input.truncated ?? false;
  if (truncated) {
    return {
      verdict: "listing_failed",
      parentState: null,
      reason:
        "Sub-issue listing is incomplete — pagination did not confirm every child was fetched. Report the error and do not reconcile parent status.",
    };
  }

  const children = input.children;
  const parentHasManualOps = input.parentLabels
    .map(labelName)
    .includes("manual-ops");

  // An empty `children` array (no sub-issues) needs no special case — every
  // predicate below is vacuously true over `[]`, so a childless parent reads
  // as "all done".
  const buckets = children.map((c) => classifyChildState(c.state));
  const allDone = buckets.every((b) => b !== "incomplete");

  const incompleteChildren = children.filter(
    (_, i) => buckets[i] === "incomplete",
  );

  // A missing `labels` field on a still-open child used to fail the whole
  // listing closed here, on the premise that both transports always request
  // labels and return a real array on success. That premise is false for
  // the CLI transport: `linear issue view --json`'s own `children`
  // connection carries only `identifier`/`title`/`state` for every child,
  // never `labels` — measured against real linear-cli 2.6.0 output (a live
  // multi-child epic on the majordomo agent host; also pinned by
  // `scripts.test.ts`'s "reads linear-cli 2.6.0 connection envelopes"
  // fixture, whose children never carry a `labels` key at all). So the gate
  // that used to sit here made every still-open child fetched via CLI read
  // as an unreadable listing, unconditionally — not the rare partial fetch
  // it was written to catch (docomply-review round 8, a reference-implementation pull request).
  //
  // Defaulting an unreadable-or-missing child's labels to "no tail" instead
  // is the safe direction: it is consumed ONLY by `allIncompleteAreExtractable`
  // below, so the one thing it can do wrong is fail to recognize a
  // genuinely tail-labeled child as extractable — which just keeps the
  // parent "In Progress" (Step 4b, same as any other still-open child). It
  // can never promote the parent to `Done` or wrongly extract-and-close:
  // every OTHER verdict (`set_status`, the least-advanced-state cap) is
  // decided from child STATE alone, never from labels. `(c.labels ?? [])`
  // below already carries that default.
  const allIncompleteAreExtractable =
    incompleteChildren.length > 0 &&
    incompleteChildren.every((c) =>
      (c.labels ?? []).some((l) =>
        (EXTRACTABLE_TAILS as readonly string[]).includes(labelName(l)),
      ),
    );

  // Checked BEFORE the merged-or-parked guard below: every incomplete child
  // being a tail means `allMergedOrParked` is false (a tail's own state is
  // never in MERGED_OR_PARKED), so falling through would route straight back
  // to "keep_in_progress" — the very Step 4b loop this rule exists to break.
  if (allIncompleteAreExtractable) {
    return {
      verdict: "extract_and_close_eligible",
      parentState: null,
      // sweep-epic.ts's own close guard refuses `--close` outright on an
      // epic carrying `manual-ops` (do-issue § Step 5a caps such an epic at
      // "Ops Pending", never "Done") — the reason must say so up front,
      // since the plain reading of this verdict ("run sweep-epic.ts") would
      // otherwise dispatch a call that guard rejects.
      reason: parentHasManualOps
        ? 'Every remaining incomplete sub-issue carries an extractable tail label (hitl:legal / manual-ops / hitl:tactical / pr-followup) — but the PARENT itself carries manual-ops, so sweep-epic.ts refuses `--close` on it. Verify an ACCEPT/ACCEPT-WITH-FOLLOWUPS verdict from /epic-acceptance-review, or a recorded human waiver, then run sweep-epic.ts --no-close to move the tails and leave the epic open (capped at "Ops Pending") until its own operator checklist clears.'
        : "Every remaining incomplete sub-issue carries an extractable tail label (hitl:legal / manual-ops / hitl:tactical / pr-followup) — verify an ACCEPT/ACCEPT-WITH-FOLLOWUPS verdict from /epic-acceptance-review, or a recorded human waiver, then run sweep-epic.ts instead of setting a status here.",
    };
  }

  // A child already bucketed completed/abandoned by `classifyChildState` is
  // trivially merged-or-parked — this is what lets Canceled/Duplicate (and
  // any unrecognized-but-Done-like name via the fallback matcher) count here
  // without a raw-name list, and it must be checked FIRST: checking the name
  // list on its own (the prior bug) let a type-contradicting name like
  // `{ name: 'Done', type: 'started' }` read as parked even though its own
  // `type` says the work is still active, which then starved the ladder
  // lookup below of any valid entry. Only a child still bucketed
  // "incomplete" falls back to the exact-name check, gated by
  // `nameTrustworthyForParkedCheck` so a recognized non-"started" type (e.g.
  // `{ name: 'In Review', type: 'unstarted' }`, or an "Ops Pending" name
  // with a `backlog`/`triage` type) can't have its name override a type that
  // explicitly says the work hasn't started — that is the one case
  // `classifyChildState`'s `type`-based bucket cannot resolve on its own
  // (see `PARKED_ACTIVE_STATE_NAMES`).
  const allMergedOrParked = children.every(
    (c, i) =>
      buckets[i] !== "incomplete" ||
      (nameTrustworthyForParkedCheck(c.state) &&
        (PARKED_ACTIVE_STATE_NAMES as readonly string[]).includes(
          c.state?.name ?? "",
        )),
  );

  if (!allMergedOrParked) {
    return {
      verdict: "keep_in_progress",
      parentState: null,
      reason:
        'At least one sub-issue is still in progress/todo/blocked — keep the parent "In Progress" and continue with Step 4b.',
    };
  }

  if (allDone) {
    return {
      verdict: "set_status",
      parentState: parentHasManualOps ? "Ops Pending" : "Done",
      reason: parentHasManualOps
        ? 'All sub-issues are Done (or Canceled/Duplicate); the parent carries manual-ops, so it is capped at "Ops Pending" until the operator checklist is acknowledged.'
        : "All sub-issues are Done (or Canceled/Duplicate).",
    };
  }

  // Reached only when every child is merged-or-parked AND not all are
  // Done/Canceled/Duplicate — so at least one child has bucket "incomplete"
  // (else `allDone` above would have returned), and `allMergedOrParked`
  // above only accepts an "incomplete"-bucket child whose exact name is "In
  // Review" or "Ops Pending" — both members of STATE_LADDER. The filtered
  // array below can therefore never be empty here.
  //
  // Filtered to bucket-"incomplete" children BEFORE the name lookup, not
  // just after — a completed-but-name-contradicting child (e.g.
  // `{ name: 'In Progress', type: 'completed' }`) or an abandoned one (e.g.
  // `{ name: 'In Review', type: 'canceled' }`) still has a name that matches
  // a STATE_LADDER rung, and mapping over every child let it inject a bogus
  // ladder entry for a child that isn't actually still active. Its own
  // `type` already says it's done/abandoned — its name must not out-vote
  // that in a computation meant to reflect only the sub-issues genuinely
  // still open.
  const ladderIndexes = children
    .filter((_, i) => buckets[i] === "incomplete")
    .map((c) =>
      (STATE_LADDER as readonly string[]).indexOf(c.state?.name ?? ""),
    )
    .filter((i) => i >= 0);
  const parentState = STATE_LADDER[Math.min(...ladderIndexes)] as ParentState;

  return {
    verdict: "set_status",
    parentState,
    reason: `All sub-issues are merged-and-parked but not all Done — capping the parent at the least-advanced sub-issue state ("${parentState}").`,
  };
}

/** Runtime guard for the parsed stdin payload — see the `main()` call site. */
export function isReconcileInputShape(value: unknown): value is ReconcileInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  // Both transports always supply `name` when using the object form (see
  // `LabelLike`'s own doc comment) — a nameless `{}` is unreadable, not a
  // legitimately absent label, so it must fail this shape check rather than
  // silently surviving into `labelName()`'s `?? ''` fallback. Letting it
  // through previously meant a genuinely malformed `manual-ops`/tail label
  // read as an empty string — indistinguishable from "not manual-ops" — and
  // bypassed the parent-completion cap it exists to enforce instead of
  // refusing the whole input as invalid.
  const isLabelLike = (l: unknown): l is LabelLike =>
    typeof l === "string" ||
    (typeof l === "object" &&
      l !== null &&
      !Array.isArray(l) &&
      typeof (l as Record<string, unknown>).name === "string");
  const isLabelArray = (x: unknown): x is LabelLike[] =>
    Array.isArray(x) && x.every(isLabelLike);
  const isState = (x: unknown): boolean => {
    if (x === undefined) return true;
    if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
    const s = x as Record<string, unknown>;
    return (
      (s.name === undefined || typeof s.name === "string") &&
      (s.type === undefined || typeof s.type === "string")
    );
  };
  // `isState` only checks that PRESENT fields are well-typed — it says
  // nothing about whether the state carries any actual information.
  // `undefined`, `{}`, and `{ name: '', type: '' }` all pass it, and
  // `classifyChildState` defaults every one of them to "incomplete" (neither
  // a known type nor a name pattern matches an absent/empty value). Paired
  // with a tail label, that let a child we have ZERO readable state for
  // drive an `extract_and_close_eligible` verdict — first via a missing
  // `state` key, then via a present-but-empty one. Both are the same
  // underlying gap: nothing here actually asserts the state is READABLE, not
  // just well-shaped when present.
  //
  // A non-empty `type` alone isn't enough either: `{ name: '', type:
  // 'unknown' }` has a non-empty `type` string, but `'unknown'` is never a
  // real Linear state type (it isn't in `KNOWN_STATE_TYPES` — it's
  // `get_issue.ts`'s OWN sentinel for "the type itself was unreadable"), so
  // this predicate still passed a state neither field actually confirms
  // (docomply-review round 18, a reference-implementation pull request). Require the type to be one
  // `classifyChildState` actually recognizes, or the name to be non-blank.
  //
  // That name-non-blank branch has its own gap, though: `get_issue.ts`'s
  // OTHER sentinel — `{ name: 'Unknown', type: 'unknown' }`, emitted when
  // BOTH fields are absent — has a non-blank `name` ("Unknown" itself is a
  // non-empty string), so it satisfied the name check despite being the
  // exact pair SKILL.md's own `isUnreadableState` treats as unreadable. The
  // two checks must agree on what counts as unreadable, or a child fetch
  // that fails one specific way passes this shared input validator only to
  // be correctly rejected downstream by the other (docomply-review
  // round 19, PR #5024).
  const isUnreadableSentinel = (name: unknown, type: unknown): boolean =>
    name === "Unknown" && type === "unknown";
  const hasReadableState = (x: unknown): boolean => {
    if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
    const s = x as Record<string, unknown>;
    if (isUnreadableSentinel(s.name, s.type)) return false;
    return (
      (typeof s.name === "string" && s.name.trim().length > 0) ||
      (typeof s.type === "string" &&
        KNOWN_STATE_TYPES.has(s.type.toLowerCase()))
    );
  };
  const isChild = (c: unknown): c is ReconcileChildInput =>
    typeof c === "object" &&
    c !== null &&
    !Array.isArray(c) &&
    isState((c as Record<string, unknown>).state) &&
    hasReadableState((c as Record<string, unknown>).state) &&
    ((c as Record<string, unknown>).labels === undefined ||
      isLabelArray((c as Record<string, unknown>).labels));

  if (v.found !== undefined && typeof v.found !== "boolean") return false;
  if (v.truncated !== undefined && typeof v.truncated !== "boolean")
    return false;
  if (!isLabelArray(v.parentLabels)) return false;
  if (!Array.isArray(v.children) || !v.children.every(isChild)) return false;
  return true;
}

// Bounds on the stdin read below (docomply-review round 9, a reference-implementation pull request):
// `readStdin` used to await EOF with no deadline and accumulate every chunk
// with no size cap. SKILL.md's Step 5a invocation pipes a machine-assembled
// temp file — normally tiny — but a stalled producer would otherwise hang
// this process indefinitely, and an oversized or runaway listing could
// exhaust memory before validation ever runs. Both are overridable via env
// var purely so the test suite can exercise them without a slow real wait;
// no production caller should ever need to.
//
// Parsed rather than passed straight through `Number(...)`: `Number('abc')`
// is `NaN`, and `total > NaN` is always `false`, so a typo'd byte-cap
// override would silently disable the cap entirely rather than falling back
// to the default; `setTimeout` with a `NaN` delay coerces to ~1ms in Node,
// so a typo'd timeout override would make every read fail almost instantly
// instead (coderabbitai, PR #5024).
//
// The optional `max` REJECTS a too-large override back to `fallback`, a
// DIFFERENT failure mode than the invalid-input fallback above:
// `Number.isInteger` is true for any finite whole number regardless of
// magnitude (`Number.isInteger(1e100)` is `true`), so a byte-cap override
// like `1e100` passed the positive-integer check yet effectively disabled
// the memory bound entirely — nothing capped it against a sane ceiling
// (docomply-review round 19, a reference-implementation pull request). An earlier revision CLAMPED an
// over-`max` value to `max` instead of falling back — for
// `RECONCILE_STDIN_TIMEOUT_MS`, that turned a clearly-mistaken huge value
// into "wait up to Node's ~24.8-day setTimeout ceiling" instead of the
// intended 30-second default, i.e. the opposite of a safety bound
// (docomply-review round 20, a reference-implementation pull request). These are protective ceilings
// against a misconfiguration, not a "use as much as is allowed" request, so
// out-of-range in EITHER direction (too small/invalid, or too large) means
// the override is not trustworthy and `fallback` is what a caller actually
// gets.
export function positiveIntEnv(
  name: string,
  fallback: number,
  max?: number,
): number {
  const n = Number(process.env[name]);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return max !== undefined && n > max ? fallback : n;
}
// 1 GiB: far more than any real listing could ever need (the default is
// 10MiB), but still small enough to bound memory exhaustion from a malformed
// override.
const MAX_STDIN_BYTES_CEILING = 1024 * 1024 * 1024;
const MAX_STDIN_BYTES = positiveIntEnv(
  "RECONCILE_MAX_STDIN_BYTES",
  10 * 1024 * 1024,
  MAX_STDIN_BYTES_CEILING,
);
// Node's setTimeout coerces a delay past its 32-bit signed max (2147483647ms,
// ~24.8 days) down to ~1ms instead of rejecting it, so an override above that
// ceiling would make every read fail almost instantly (coderabbitai,
// PR #5024).
const NODE_MAX_TIMEOUT_MS = 2_147_483_647;
const STDIN_TIMEOUT_MS = positiveIntEnv(
  "RECONCILE_STDIN_TIMEOUT_MS",
  30_000,
  NODE_MAX_TIMEOUT_MS,
);

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      fn();
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_STDIN_BYTES) {
        settle(() =>
          reject(
            new Error(
              `stdin exceeded ${MAX_STDIN_BYTES} bytes without completing`,
            ),
          ),
        );
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () =>
      settle(() => resolve(Buffer.concat(chunks).toString("utf8")));
    const onError = (err: Error) => settle(() => reject(err));
    const timer = setTimeout(() => {
      settle(() =>
        reject(new Error(`stdin read exceeded ${STDIN_TIMEOUT_MS}ms`)),
      );
      process.stdin.destroy();
    }, STDIN_TIMEOUT_MS);

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
  });
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), {
    flags: [],
    values: [],
    noPositional: true,
    usage: "Usage: reconcile_parent_status.ts  (ReconcileInput JSON on stdin)",
  });
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }

  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    console.error(
      `failed to read stdin: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    console.error(
      `stdin is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  if (!isReconcileInputShape(input)) {
    console.error(
      "stdin is not a valid ReconcileInput: expected { found?, truncated?, parentLabels: [], children: [{ state?, labels? }] }",
    );
    return 1;
  }

  console.log(JSON.stringify(reconcileParentStatus(input)));
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
