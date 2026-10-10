/** Mechanical predicates shared by the `ci:hold` transition and its tests. */

import { isGitSha } from "./cli.ts";

export const CI_HOLD_LABEL = "ci:hold";
export const FINAL_CI_WITNESS = "Schema gate";
export const REQUIRED_FULL_CI_CHECKS = [
  "code-quality-and-build",
  "tests",
  FINAL_CI_WITNESS,
] as const;

export interface LabelTransition {
  id: string;
  event: "labeled" | "unlabeled";
  actor: string;
  createdAt: string;
}

export interface PrSnapshot {
  state: "OPEN" | "CLOSED" | "MERGED";
  head: string;
  held: boolean;
}

export interface CheckRunLite {
  id: number;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
}

export function parsePrSnapshot(raw: unknown): PrSnapshot | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const value = raw as Record<string, unknown>;
  if (
    value.state !== "OPEN" &&
    value.state !== "CLOSED" &&
    value.state !== "MERGED"
  )
    return null;
  if (typeof value.headRefOid !== "string" || !isGitSha(value.headRefOid))
    return null;
  if (!Array.isArray(value.labels)) return null;
  let held = false;
  for (const entry of value.labels) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return null;
    const label = entry as Record<string, unknown>;
    if (typeof label.name !== "string" || label.name === "") return null;
    if (label.name === CI_HOLD_LABEL) held = true;
  }
  return { state: value.state, head: value.headRefOid, held };
}

export function ciHoldTransitions(raw: unknown): LabelTransition[] | null {
  if (!Array.isArray(raw)) return null;
  const transitions: LabelTransition[] = [];
  for (const value of raw) {
    // Not even a proper object — could be a null/primitive/array element
    // GitHub's API is not documented to emit, but a malformed entry here
    // means this function cannot tell whether it WAS a ci:hold event: an
    // older `continue` skipped it, which could expose a stale event as
    // "latest" and let `release()` remove a label that now belongs to
    // another actor. Every other unrecognized shape below this line already
    // fails the whole read closed once it's known to be a ci:hold event;
    // this is the one case that precedes even knowing that much, so it must
    // fail closed too rather than assume irrelevance (chatgpt-codex-
    // connector, PR #4681 round 4).
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return null;
    const event = value as Record<string, unknown>;
    const kind = event.event;
    if (kind !== "labeled" && kind !== "unlabeled") continue;
    if (
      typeof event.label !== "object" ||
      event.label === null ||
      Array.isArray(event.label)
    )
      return null;
    const label = event.label as Record<string, unknown>;
    if (typeof label.name !== "string") return null;
    if (label.name !== CI_HOLD_LABEL) continue;
    if (
      typeof event.actor !== "object" ||
      event.actor === null ||
      Array.isArray(event.actor)
    )
      return null;
    const actor = event.actor as Record<string, unknown>;
    // REST timeline ids are JSON numbers and can exceed JavaScript's safe
    // integer range. Require the opaque node id so ownership cannot alias
    // through numeric rounding. A malformed matching event fails the whole
    // read closed: skipping it would expose an older event as "latest" and
    // could authorize removal of a newer label transition.
    if (
      typeof event.node_id !== "string" ||
      event.node_id === "" ||
      typeof actor.login !== "string" ||
      actor.login === "" ||
      typeof event.created_at !== "string" ||
      !Number.isFinite(Date.parse(event.created_at))
    )
      return null;
    const id = event.node_id;
    const login = actor.login;
    const createdAt = event.created_at;
    transitions.push({ id, event: kind, actor: login, createdAt });
  }
  return transitions;
}

export function newestCiHoldTransition(raw: unknown): LabelTransition | null {
  const transitions = ciHoldTransitions(raw);
  return transitions?.at(-1) ?? null;
}

/** Compare-and-set guard for removing a label this drive added. */
export function ownsHeldTransition(
  persisted: {
    phase: string;
    eventId?: string;
  } | null,
  latest: LabelTransition | null,
): boolean {
  return (
    persisted?.phase === "held" &&
    latest?.event === "labeled" &&
    latest.id === persisted.eventId
  );
}

/**
 * GitHub mutations can time out after taking effect. The post-write timeline
 * and label snapshot are authoritative; the command exit is diagnostic only.
 */
export function mutationProven(
  _commandExit: number,
  transition: LabelTransition | null,
  liveMatches: boolean,
): transition is LabelTransition {
  return transition !== null && liveMatches;
}

export function parseCheckRuns(raw: unknown): CheckRunLite[] | null {
  const pages = Array.isArray(raw) ? raw : [raw];
  const result: CheckRunLite[] = [];
  for (const pageValue of pages) {
    if (
      typeof pageValue !== "object" ||
      pageValue === null ||
      Array.isArray(pageValue)
    )
      return null;
    const page = pageValue as Record<string, unknown>;
    if (!Array.isArray(page.check_runs)) return null;
    for (const value of page.check_runs) {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return null;
      const run = value as Record<string, unknown>;
      const id = run.id;
      const name = String(run.name ?? "");
      const headSha = String(run.head_sha ?? "");
      const status = String(run.status ?? "");
      const conclusion =
        run.conclusion === null ? null : String(run.conclusion ?? "");
      const startedAt =
        run.started_at === null || run.started_at === undefined
          ? null
          : String(run.started_at);
      if (
        typeof id !== "number" ||
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        name === "" ||
        !isGitSha(headSha) ||
        status === "" ||
        (conclusion !== null && conclusion === "") ||
        (startedAt !== null && !Number.isFinite(Date.parse(startedAt)))
      )
        return null;
      result.push({
        id,
        name,
        headSha,
        status,
        conclusion,
        startedAt,
      });
    }
  }
  return result;
}

/**
 * A completed, non-skipped Schema gate on this exact head. Its conclusion may
 * be failure: this predicate proves the unlabel-triggered run registered;
 * the overall CI verdict decides whether the drive waits or stops. `after` is the
 * server timestamp of the `unlabeled` event; it keeps an older synchronize
 * run from satisfying the final-CI wait while GitHub is still scheduling the
 * unlabel-triggered workflow.
 */
/**
 * The newest run for `name`+`head`, by id — selected BEFORE any freshness or
 * completion check, never after. An earlier version of every caller below
 * filtered to "completed, non-skipped, fresh" runs FIRST and picked the
 * highest id among THOSE, to stop an unrelated stale/irrelevant run from
 * blocking on its own account — but that same filter also silently prefers
 * an older, already-concluded run over a newer rerun of the identical check
 * that is still queued or in-progress, which is exactly backwards for a
 * proof that is about to certify success: the newest evidence is the only
 * evidence that can still change, so it is the only evidence worth trusting
 * (chatgpt-codex-connector, a reference-implementation pull request round 2, superseding the round 1 fix
 * that introduced the filter-first version). The caller validates
 * freshness/completion/success on the run this returns; there is no
 * fallback to an older one if it fails those checks — waiting for the
 * newest run to actually resolve is the safe direction, not an unrelated
 * inefficiency to route around.
 */
function newestRunFor(
  runs: readonly CheckRunLite[],
  name: string,
  head: string,
): CheckRunLite | undefined {
  return runs
    .filter((run) => run.name === name && run.headSha === head)
    .sort((a, b) => a.id - b.id)
    .at(-1);
}

export function freshSchemaGate(
  runs: readonly CheckRunLite[],
  head: string,
  after: string,
  watermark = 0,
  strictAfter = false,
): CheckRunLite | null {
  const floor = Date.parse(after);
  if (!isGitSha(head) || !Number.isFinite(floor)) return null;
  const newest = newestRunFor(runs, FINAL_CI_WITNESS, head);
  if (
    newest === undefined ||
    newest.id <= watermark ||
    newest.status !== "completed" ||
    newest.conclusion === null ||
    newest.conclusion === "skipped" ||
    newest.startedAt === null
  )
    return null;
  const started = Date.parse(newest.startedAt);
  if (strictAfter ? started <= floor : started < floor) return null;
  return newest;
}

/** Initial PR-open CI only needs a completed witness; it predates any hold. */
export function completedInitialSchemaGate(
  runs: readonly CheckRunLite[],
  head: string,
): CheckRunLite | null {
  if (!isGitSha(head)) return null;
  const newest = newestRunFor(runs, FINAL_CI_WITNESS, head);
  if (
    newest === undefined ||
    newest.status !== "completed" ||
    newest.conclusion === null ||
    newest.conclusion === "skipped" ||
    newest.startedAt === null
  )
    return null;
  return newest;
}

/**
 * The branch-protection checks from the opening/full run have all registered
 * and reached a non-skipped terminal result. Failures count as complete: the
 * caller separately decides whether a red head may continue through review.
 */
export function completedRequiredCi(
  runs: readonly CheckRunLite[],
  head: string,
  after?: string,
  requireSuccess = false,
  watermark = 0,
  strictAfter = false,
): boolean {
  if (!isGitSha(head)) return false;
  const floor = after === undefined ? null : Date.parse(after);
  if (floor !== null && !Number.isFinite(floor)) return false;
  return REQUIRED_FULL_CI_CHECKS.every((name) => {
    const newest = newestRunFor(runs, name, head);
    if (
      newest === undefined ||
      newest.id <= watermark ||
      newest.status !== "completed" ||
      newest.conclusion === null ||
      newest.conclusion === "skipped" ||
      newest.startedAt === null
    )
      return false;
    if (floor !== null) {
      const started = Date.parse(newest.startedAt);
      if (strictAfter ? started <= floor : started < floor) return false;
    }
    return !requireSuccess || newest.conclusion === "success";
  });
}

/** Evidence required before adding or re-adding the hold. */
export function completedHoldPrecondition(
  runs: readonly CheckRunLite[],
  head: string,
  latest: LabelTransition | null,
  watermark = 0,
  strictAfter = false,
): CheckRunLite | null {
  if (latest === null) {
    if (!completedRequiredCi(runs, head)) return null;
    return completedInitialSchemaGate(runs, head);
  }
  if (latest.event !== "unlabeled") return null;
  if (
    !completedRequiredCi(
      runs,
      head,
      latest.createdAt,
      false,
      watermark,
      strictAfter,
    )
  )
    return null;
  return freshSchemaGate(runs, head, latest.createdAt, watermark, strictAfter);
}

export function checkRunWatermark(
  runs: readonly CheckRunLite[],
  head: string,
): number | null {
  if (!isGitSha(head)) return null;
  const onHead = runs.filter((run) => run.headSha === head);
  if (onHead.length === 0) return null;
  return Math.max(...onHead.map((run) => run.id));
}
