#!/usr/bin/env bun
/**
 * loop-metrics.ts — what one PR's review loop cost.
 *
 * Prints, for a PR driven or not: how many rounds it took, how many threads it
 * produced, what the outcome mix was, and how much of the final code landed
 * AFTER review started. Beside them, what the drive did without a person
 * (`lib/metrics-autonomy.ts`): self-restarts by cause, re-arms and takeovers,
 * provisional decisions and how many a person reversed before the merge (the
 * validation measure for the `wide` autonomy level), and the review bots'
 * transparent acknowledgements. `drive.ts` prints this block when it stops, so a driven
 * PR's final summary carries the numbers without manual archaeology.
 *
 * That last quantity is temporal, not causal — it is every commit after the
 * first reviewed head, whatever prompted it, not code a round demanded. See
 * `lib/metrics.ts` § "What the split does NOT establish", which owns the rule;
 * a second statement of it here is a second copy to drift.
 *
 * Why it exists: cutting low-value review rounds means turning dials, and
 * without a baseline every dial is tuned blind. An 87.7% accepted share reads
 * as "the materiality bar is not biting" and reads equally well as "the
 * reviewers were precise and the fixes were needed". No dial should move before
 * this baseline exists — and a baseline only exists if producing it is cheaper
 * than not.
 *
 * Every print of these speed/volume numbers also carries the quality
 * counterweight: the recorded, human-adjudicated defect-escape figure (or an
 * explicit "unmeasured" marker), pulled from `lib/escape-baseline.ts`.
 * A speed number surfacing alone invites optimizing convergence speed at the
 * expense of escaped defects — see `SKILL.md` § What the loop cost for the policy
 * this enforces.
 *
 * Usage:
 *   loop-metrics.ts [PR] [--json | --severity-warnings]
 *
 *   PR      defaults to the PR for the current branch.
 *   --json  the full metric object, for a report or a spreadsheet — plus an
 *           `escapeBaseline` field carrying the SAME repo-wide defect-escape
 *           record on every PR's object (it does not vary per PR), so an
 *           aggregation over many PRs (`jq -s '.'`, see `review-loop-baseline.md`
 *           § Reproducing it) sees it repeated once per element rather than
 *           reading it once from any single one.
 *   --severity-warnings  only the current-round, 100%-unreadable reviewer
 *           alerts. Used by `drive.ts` before a pass starts; it intentionally
 *           skips unrelated economy and defect-escape measurements.
 *
 * Exit codes:
 *   0  metrics printed
 *   1  the PR could not be read
 *   2  usage error
 *
 * It is a REPORTING tool and nothing acts on it: no gate consumes its output,
 * no round changes because of it, and it never mutates anything on GitHub. A
 * failure here therefore costs a missing summary — which is why `drive.ts`
 * calls it best-effort and lets a converged drive still exit 0 without one.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { swallow } from "../../../shared/errors.ts";
import { fail, isDigits, runMain } from "./lib/cli.ts";
import {
  type EscapeBaseline,
  readRecordedEscapeBaseline,
  renderEscapeAnchor,
} from "./lib/escape-baseline.ts";
import {
  classifySiblingCommits,
  computeLoopMetrics,
  type LoopMetrics,
  renderLoopMetrics,
  renderSeverityOutageWarnings,
} from "./lib/metrics.ts";
import type { DurableAutonomy } from "./lib/metrics-autonomy.ts";
import {
  git,
  helperTimeoutSeconds,
  resolvePr,
  run,
  tsArgv,
} from "./lib/proc.ts";
import { readLedgerSnapshot, resolveLogin } from "./lib/state/ledger-forge.ts";
import { isUsableState } from "./lib/state/schema.ts";
import { type PrSample, resolveRepo, samplePr } from "./lib/sample.ts";

const here = dirname(fileURLToPath(import.meta.url));
const driveState = join(here, "drive-state.ts");

/**
 * Is `oid` an ancestor of `base` in this clone's LOCAL history?
 *
 * `null` when that cannot be established here — the base ref not fetched, a
 * shallow clone, a bad oid — matching `defect-escape.ts`'s
 * `laterFixCommits`: no local evidence is never asserted as "not an
 * ancestor", because a merge left unclassified still reports its (unchanged)
 * merge count rather than silently misattributing churn.
 */
async function isAncestorOfBase(
  oid: string,
  base: string,
): Promise<boolean | null> {
  if (oid === "" || base === "") return null;
  const r = await git(["merge-base", "--is-ancestor", oid, base], {
    stderr: "ignore",
  });
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  return null;
}

/**
 * Commits reachable from `second` but not from `first` — the sibling
 * branch's own history a merge with that parent pair imported. Empty on any
 * local failure: the same best-effort contract as `isAncestorOfBase`, and
 * `classifySiblingCommits` treats an empty set as "nothing to exclude" rather
 * than as a claim the branch imported nothing.
 */
async function siblingCommitsOf(
  first: string,
  second: string,
): Promise<ReadonlySet<string>> {
  const r = await git(["rev-list", `${first}..${second}`], {
    stderr: "ignore",
  });
  if (r.code !== 0) return new Set();
  return new Set(r.stdout.split("\n").filter((l) => l !== ""));
}

/**
 * The base ref to test ancestry against — a FIXED point, never `origin/<base>`'s
 * current, moving tip.
 *
 * For a merged PR, `mergeCommitOid^1` is the base branch's own tip immediately
 * BEFORE this PR landed, for all three merge strategies GitHub offers (a merge
 * commit's first parent, a squash commit's sole parent, a rebase-merge's last
 * commit's sole parent — all base-before-merge). That point never moves, so a
 * sibling branch this PR imported stays classified as a sibling merge forever,
 * even after the base absorbs that same sibling tip through some later,
 * unrelated PR — which `origin/<base>`'s moving tip would misread as "the
 * import was actually a base sync", silently re-attributing the sibling's
 * commits to this branch's own authored churn. Open PRs have no merge commit
 * yet, so `origin/<base>`'s current tip is the only available referent — and is
 * not yet wrong, since there is no "as of merge" snapshot to fall short of.
 */
function baseSnapshotOf(sample: PrSample): string {
  if (sample.mergeCommitOid !== "") return `${sample.mergeCommitOid}^1`;
  return sample.baseRefName === "" ? "" : `origin/${sample.baseRefName}`;
}

/**
 * Resolve `classifySiblingCommits`'s two injected predicates against this
 * clone's local git history, once per PR. `lib/metrics.ts` stays pure and
 * pinnable without a network; this is where the git actually happens.
 */
async function resolveSiblingCommitOids(
  sample: PrSample,
): Promise<ReadonlySet<string>> {
  const base = baseSnapshotOf(sample);
  const ancestry = new Map<string, boolean | null>();
  const siblings = new Map<string, ReadonlySet<string>>();
  for (const c of sample.commits) {
    if (c.parents < 2) continue;
    const [first, second] = c.parentOids;
    if (first === undefined || second === undefined) continue;
    if (!ancestry.has(second)) {
      ancestry.set(second, await isAncestorOfBase(second, base));
    }
    const key = `${first}..${second}`;
    if (ancestry.get(second) === false && !siblings.has(key)) {
      siblings.set(key, await siblingCommitsOf(first, second));
    }
  }
  return classifySiblingCommits(
    sample.commits,
    (oid) => ancestry.get(oid) ?? null,
    (first, second) => siblings.get(`${first}..${second}`) ?? new Set(),
  );
}

/**
 * The drive's own durable round count, or `null` when this clone does not hold
 * it — which is the ordinary case for a PR driven from another machine or for
 * one whose Conductor worktree has since been archived.
 *
 * Deliberately soft, unlike `drive.ts`'s own reads of the same value: there the
 * count is the ROUND BUDGET and an unreadable one is a loop with no bound, so
 * it is a hard stop. Here it is a decoration next to a number derived from the
 * PR itself, and refusing to print any metrics because a state file is missing
 * would defeat the whole point of deriving them from the PR.
 */
async function durableRounds(pr: string): Promise<number | null> {
  const r = await run(tsArgv(driveState, ["rounds", pr]), {
    stderr: "ignore",
  });
  if (r.code !== 0) return null;
  const raw = r.stdout.trim();
  return isDigits(raw) ? Number.parseInt(raw, 10) : null;
}

/** What a drive state or a ledger records of the drive's autonomy. */
function autonomyOf(s: {
  decisions?: DurableAutonomy["decisions"];
  events?: DurableAutonomy["events"];
  takeovers?: readonly unknown[];
}): DurableAutonomy {
  return {
    decisions: s.decisions ?? [],
    events: s.events ?? [],
    takeovers: (s.takeovers ?? []).length,
  };
}

/** This clone's drive state, `null` when it holds none that ever drove. */
async function localAutonomy(pr: string): Promise<DurableAutonomy | null> {
  const r = await run(tsArgv(driveState, ["get", pr]), {
    stderr: "ignore",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (r.code !== 0) return null;
  try {
    const s: unknown = JSON.parse(r.stdout);
    return isUsableState(s, Number.parseInt(pr, 10)) && s.rounds > 0
      ? autonomyOf(s)
      : null;
  } catch (err) {
    swallow(err, "drive-state.ts get printed no JSON");
    return null;
  }
}

/**
 * What the drive recorded of its autonomy: its decisions, its self-restarts
 * and re-arms, and how many takeovers. From this clone's state, else from
 * the pull request's drive ledger, so a drive run from another clone counts
 * toward the validation measure too. `null` when neither holds one, soft
 * like `durableRounds`.
 */
export async function durableAutonomy(
  pr: string,
): Promise<DurableAutonomy | null> {
  const local = await localAutonomy(pr);
  if (local !== null) return local;
  const snapshot = await readLedgerSnapshot(pr, await resolveLogin());
  if (typeof snapshot === "string") return null;
  const parsed = snapshot.canonical?.parsed;
  return parsed?.kind === "ledger" ? autonomyOf(parsed.ledger) : null;
}

/**
 * The recorded defect-escape baseline, resolved against THIS clone's
 * repository root — best-effort, like `durableRounds` above: an
 * unreadable root or a doc `readRecordedEscapeBaseline` cannot parse both
 * degrade to `null`, which `renderEscapeAnchor` turns into the explicit
 * "unmeasured" marker rather than an absent line. Speed numbers never print
 * without this pairing — see the module header and `SKILL.md` § What the loop cost.
 */
export async function resolveEscapeBaseline(): Promise<EscapeBaseline | null> {
  const r = await git(["rev-parse", "--show-toplevel"], { stderr: "ignore" });
  if (r.code !== 0) return null;
  return readRecordedEscapeBaseline(r.stdout.trim());
}

/**
 * Composes exactly what `main()` writes to stdout — extracted so a test can
 * pin the REAL composition (the anchor trailing the economy block in text
 * mode, `escapeBaseline` present in the JSON object) rather than a
 * hand-rebuilt copy that would stay green if `main()`'s own wiring were
 * deleted.
 */
export function renderReport(
  metrics: LoopMetrics,
  escapeBaseline: EscapeBaseline | null,
  json: boolean,
): string {
  return json
    ? `${JSON.stringify({ ...metrics, escapeBaseline }, null, 2)}\n`
    : `${renderLoopMetrics(metrics)}${renderEscapeAnchor(escapeBaseline)}\n`;
}

export interface ReportDeps {
  resolveRepo: typeof resolveRepo;
  samplePr: typeof samplePr;
  durableRounds: (pr: string) => Promise<number | null>;
  /** This clone's drive state's autonomy record; absent reads as none held. */
  durableAutonomy?: (pr: string) => Promise<DurableAutonomy | null>;
  resolveSiblingCommitOids: (sample: PrSample) => Promise<ReadonlySet<string>>;
  resolveEscapeBaseline: typeof resolveEscapeBaseline;
  write: (s: string) => void;
}

const defaultDeps: ReportDeps = {
  resolveRepo,
  samplePr,
  durableRounds,
  durableAutonomy,
  resolveSiblingCommitOids,
  resolveEscapeBaseline,
  write: (s: string) => {
    process.stdout.write(s);
  },
};

/**
 * Everything `main()` does once it has a resolved PR number and `--json` flag —
 * deliberately its OWN function, injectable, so a test can pin the REAL
 * sequence `main()` runs (repo → sample → metrics → escape baseline → write)
 * rather than a hand-rebuilt copy that stays green if this wiring changes
 * underneath it (`loop-metrics.test.ts` used to pin `renderReport` alone, which
 * does not exercise this sequence at all — a regression reverting the `write`
 * call below to `renderLoopMetrics(metrics)` directly would have left every
 * existing test green). `main()` itself is reduced to argv parsing plus one
 * call in here, so there is no second, untested place this composition could
 * drift to.
 */
export async function runReport(
  pr: string,
  json: boolean,
  deps: ReportDeps = defaultDeps,
): Promise<void> {
  const repo = await deps.resolveRepo();
  const sample = await deps.samplePr(Number.parseInt(pr, 10), repo);
  const metrics = computeLoopMetrics(
    sample,
    await deps.durableRounds(pr),
    await deps.resolveSiblingCommitOids(sample),
    (await deps.durableAutonomy?.(pr)) ?? null,
  );
  const escapeBaseline = await deps.resolveEscapeBaseline();
  deps.write(renderReport(metrics, escapeBaseline, json));
}

/**
 * Report only formatter outages that would leave a reviewer's decline ladder
 * fully inert for the round about to be triaged. This is intentionally narrower
 * than `runReport`: it needs the same complete PR sample and metric computation,
 * but not durable state, git ancestry, or the defect-escape baseline.
 */
export async function runSeverityWarnings(
  pr: string,
  deps: Pick<ReportDeps, "resolveRepo" | "samplePr" | "write"> = defaultDeps,
): Promise<void> {
  const repo = await deps.resolveRepo();
  const sample = await deps.samplePr(Number.parseInt(pr, 10), repo);
  const metrics = computeLoopMetrics(sample, null, new Set());
  const warnings = renderSeverityOutageWarnings(metrics);
  if (warnings !== "") deps.write(`${warnings}\n`);
}

async function main(): Promise<number> {
  let pr = "";
  let json = false;
  let severityWarnings = false;
  for (const a of process.argv.slice(2)) {
    if (a === "--json") json = true;
    else if (a === "--severity-warnings") severityWarnings = true;
    else if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
    // The documented interface takes at most one PR. Letting a second
    // positional overwrite the first made `loop-metrics.ts 4052 4053` measure
    // 4053 and say nothing — a mistyped invocation reporting a real, confident
    // answer about the wrong pull request.
    else if (pr !== "") fail(2, `unexpected second PR argument: ${a}`);
    else pr = a;
  }
  pr = await resolvePr(pr);
  if (!isDigits(pr)) fail(2, "loop-metrics: could not resolve a PR number");
  if (json && severityWarnings) {
    fail(2, "--json and --severity-warnings cannot be combined");
  }

  if (severityWarnings) await runSeverityWarnings(pr);
  else await runReport(pr, json);
  return 0;
}

// Guarded, unlike several sibling CLIs in this directory: `resolveEscapeBaseline`
// and `renderReport` are now exported so `loop-metrics.test.ts` can
// pin the REAL composition `main()` writes to stdout rather than a hand-rebuilt
// copy — importing this module for that must not also execute `main()` as a
// side effect (which would parse `process.argv`, resolve a PR and hit the
// network). Same pattern as `defect-escape.ts`/`round-plan.ts`/`self-inflicted.ts`.
if (import.meta.main) runMain("loop-metrics", main);
