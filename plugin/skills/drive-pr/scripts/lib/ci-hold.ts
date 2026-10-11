/**
 * Mechanical predicates shared by the CI-hold transition and its tests. The
 * hold label and the required check names are the repository's
 * (`lib/ci-policy.ts`); every predicate takes them as arguments.
 */

import { isGitSha } from "./cli.ts";

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
  /** The GitHub App that published the run; `null` when the payload omits it. */
  appId: number | null;
}

/** A legacy commit status on the head: the latest state per context. */
export interface StatusLite {
  context: string;
  state: string;
  /**
   * The GitHub App that published this status record, read only when a
   * pinned requirement needs it; `null` when it is not an app's or could not
   * be established. Absent (a combined-status entry, which names no
   * publisher), the status meets no pinned requirement.
   */
  appId?: number | null;
}

/**
 * Evidence beyond the head's check runs. `apps` pins a required check to the
 * GitHub Apps that must publish it, as branch protection and rulesets can: a
 * same-named result from another app does not satisfy a pin, and a check
 * pinned to several apps needs a passing result from each. `statuses` lets a
 * required context be met by a legacy commit status, as GitHub allows, and a
 * pinned one only by that app's own newest status; statuses are read only
 * without an unlabel floor or watermark, because a status carries no run id
 * to prove it ran after the hold was released.
 */
export interface RequiredEvidence {
  apps?: ReadonlyMap<string, readonly number[]>;
  statuses?: readonly StatusLite[];
}

/**
 * `held` is whether `holdLabel` is present; always `false` for a repository
 * without a hold label.
 */
export function parsePrSnapshot(
  raw: unknown,
  holdLabel: string | null,
): PrSnapshot | null {
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
    if (holdLabel !== null && label.name === holdLabel) held = true;
  }
  return { state: value.state, head: value.headRefOid, held };
}

export function ciHoldTransitions(
  raw: unknown,
  holdLabel: string,
): LabelTransition[] | null {
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
    if (label.name !== holdLabel) continue;
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

export function newestCiHoldTransition(
  raw: unknown,
  holdLabel: string,
): LabelTransition | null {
  const transitions = ciHoldTransitions(raw, holdLabel);
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
      const app = run.app;
      const appId =
        typeof app === "object" &&
        app !== null &&
        !Array.isArray(app) &&
        Number.isSafeInteger((app as Record<string, unknown>).id)
          ? ((app as Record<string, unknown>).id as number)
          : null;
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
        appId,
      });
    }
  }
  return result;
}

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
  appId?: number,
): CheckRunLite | undefined {
  return runs
    .filter(
      (run) =>
        run.name === name &&
        run.headSha === head &&
        (appId === undefined || run.appId === appId),
    )
    .sort((a, b) => a.id - b.id)
    .at(-1);
}

/**
 * Every required check has registered on this exact head and its newest run
 * reached a non-skipped terminal result. Failures count as complete unless
 * `requireSuccess`: the caller separately decides whether a red head may
 * continue through review. `after` is the server timestamp of the hold's
 * `unlabeled` event; it keeps an older held run from satisfying the final-CI
 * wait while GitHub is still scheduling the unlabel-triggered workflows. An
 * empty `required` list is vacuously complete: the caller relies on the
 * overall CI verdict.
 *
 * `protectionPasses` judges a run as GitHub's branch protection does: a
 * skipped run (a job an `if:` condition skipped) and a neutral one both
 * pass. Only a repository without a hold may pass it: under a hold, a skipped
 * run is the held synchronize run the hold suppressed, never evidence of
 * full CI, and the hold witness keeps requiring `success`.
 */
export function completedRequiredCi(
  runs: readonly CheckRunLite[],
  required: readonly string[],
  head: string,
  after?: string,
  requireSuccess = false,
  watermark = 0,
  strictAfter = false,
  protectionPasses = false,
  evidence: RequiredEvidence = {},
): boolean {
  if (!isGitSha(head)) return false;
  const floor = after === undefined ? null : Date.parse(after);
  if (floor !== null && !Number.isFinite(floor)) return false;
  const met = (name: string, appId: number | undefined): boolean => {
    const newest = newestRunFor(runs, name, head, appId);
    if (newest === undefined && floor === null && watermark === 0) {
      // Status contexts are case-insensitive on GitHub; check-run names
      // are not, so only this fallback folds case.
      const status = evidence.statuses?.find(
        (s) =>
          s.context.toLowerCase() === name.toLowerCase() &&
          (appId === undefined || s.appId === appId),
      );
      if (status !== undefined) {
        if (status.state === "success") return true;
        if (status.state === "failure" || status.state === "error")
          return !requireSuccess;
        return false;
      }
    }
    if (
      newest === undefined ||
      newest.id <= watermark ||
      newest.status !== "completed" ||
      newest.conclusion === null ||
      (newest.conclusion === "skipped" && !protectionPasses) ||
      newest.startedAt === null
    )
      return false;
    if (floor !== null) {
      const started = Date.parse(newest.startedAt);
      if (strictAfter ? started <= floor : started < floor) return false;
    }
    return (
      !requireSuccess ||
      newest.conclusion === "success" ||
      (protectionPasses &&
        (newest.conclusion === "skipped" || newest.conclusion === "neutral"))
    );
  };
  return required.every((name) =>
    pinsOf(name, evidence.apps).every((appId) => met(name, appId)),
  );
}

/** The apps a required check is pinned to; `[undefined]` for any app. */
function pinsOf(
  name: string,
  apps: ReadonlyMap<string, readonly number[]> | undefined,
): readonly (number | undefined)[] {
  const pins = apps?.get(name);
  return pins === undefined || pins.length === 0 ? [undefined] : pins;
}

/**
 * Required (check, app) pairs with no run on `head` from that app: only these
 * can be met by a commit status, so only these need statuses read.
 */
export function requirementsWithoutRun(
  runs: readonly CheckRunLite[],
  required: readonly string[],
  head: string,
  apps?: ReadonlyMap<string, readonly number[]>,
): { context: string; appId: number | undefined }[] {
  return required.flatMap((context) =>
    pinsOf(context, apps)
      .filter((appId) => newestRunFor(runs, context, head, appId) === undefined)
      .map((appId) => ({ context, appId })),
  );
}

/** The latest start among the required checks' newest runs on `head`. */
export function requiredCiStartedAt(
  runs: readonly CheckRunLite[],
  required: readonly string[],
  head: string,
  apps?: ReadonlyMap<string, readonly number[]>,
): string | null {
  let latest: string | null = null;
  for (const name of required)
    for (const appId of pinsOf(name, apps)) {
      const startedAt =
        newestRunFor(runs, name, head, appId)?.startedAt ?? null;
      if (
        startedAt !== null &&
        (latest === null || Date.parse(startedAt) > Date.parse(latest))
      )
        latest = startedAt;
    }
  return latest;
}

/**
 * Evidence required before adding or re-adding the hold: the PR-open run of
 * every required check has completed, or, after a release, the run the
 * unlabel triggered has.
 */
export function completedHoldPrecondition(
  runs: readonly CheckRunLite[],
  required: readonly string[],
  head: string,
  latest: LabelTransition | null,
  watermark = 0,
  strictAfter = false,
): boolean {
  if (required.length === 0) return false;
  if (latest === null) return completedRequiredCi(runs, required, head);
  if (latest.event !== "unlabeled") return false;
  return completedRequiredCi(
    runs,
    required,
    head,
    latest.createdAt,
    false,
    watermark,
    strictAfter,
  );
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
