/**
 * `--apply` for stale follow-up claims, where the machine file enables
 * `followup`: each claim the plan found stale (`plan-followups.ts`) is
 * released once, so that a later tick starts the follow-up again.
 *
 * 1. the fresh read: a person's hold label is still off; the earliest
 *    trusted marker on the pull request is still the stale one, still not
 *    marked done and with no answer; no running session is joined to it;
 * 2. the pending release record (`followup-releases.ts`), which a claim on
 *    the pull request is released once against;
 * 3. the marker deleted through the shared records, then the record marked
 *    released with its event row; an unsuccessful deletion keeps the pending
 *    record, since its response may have been lost after the deletion.
 *
 * Nothing starts in the tick that releases: the next tick finds no marker
 * and wants the follow-up, as it does for any merge.
 */
import type { SharedClaim } from "../../../shared/records/shared.ts";
import { beginRelease, finishRelease } from "../followup-releases.ts";
import { holding } from "../holding.ts";
import type { LogRow } from "../log.ts";
import { stateRoot } from "../../receipts.ts";
import { failureText } from "../text.ts";
import type {
  Action,
  ReleaseOutcome,
  RepoReport,
  RepoTarget,
  StaleClaim,
} from "../types.ts";
import type { FollowupContext } from "./followup.ts";
import { type ApplyState, outOfTime } from "./launch.ts";

type Release = Action & { release: StaleClaim };

/** Whether an action releases a stale claim rather than launching a follow-up. */
export function isRelease(action: Action): action is Release {
  return action.release !== undefined;
}

function outcomeOf(
  action: Release,
  outcome: ReleaseOutcome["outcome"],
  detail: string,
): ReleaseOutcome {
  return {
    target: action.target,
    marker: action.release.marker,
    claimant: action.release.claimant,
    outcome,
    detail,
  };
}

/** Whether the earliest trusted marker is still the stale claim, as the plan read it. */
function stillStale(claims: readonly SharedClaim[], marker: number): boolean {
  const [first] = claims.filter((c) => c.trusted);
  if (first === undefined || first.id !== marker || !first.says.ok)
    return false;
  // Marked done, or answered by its host, since the plan read it: no longer a claim nobody can see the end of.
  return first.says.value.end === null;
}

/** Why the claim must not be released now; `null` when the fresh read still finds it stale. */
async function changed(
  repo: RepoTarget,
  ctx: FollowupContext,
  pr: number,
  marker: number,
): Promise<string | null> {
  if (ctx.holdReason !== undefined) {
    try {
      const hold = await ctx.holdReason(pr);
      if (hold !== null) return hold;
    } catch (error) {
      return `its labels cannot be read again: ${failureText(error)}`;
    }
  }
  const claims = await ctx.shared.records.list(
    { repo: repo.slug, pr },
    "followup",
  );
  if (!claims.ok) return claims.failure.reason;
  if (!stillStale(claims.value, marker))
    return `marker comment ${marker} is no longer the stale claim the plan read: it was deleted, marked done or answered, or an earlier marker appeared`;
  try {
    const sessions = await ctx.sessions();
    const held = holding(sessions, (w) => w.prs.includes(pr));
    if (held.kind === "unknown") return held.reason;
    if (held.kind === "running")
      return `a session is joined to it now: ${held.workspaces.map((w) => w.path).join(", ")}`;
  } catch (error) {
    return `the runtime cannot be read again: ${failureText(error)}`;
  }
  return null;
}

/** The release's event row: the outcome log counts a stale claim as stalled. */
function eventRow(repo: string, action: Release, at: string): LogRow {
  return {
    kind: "event",
    key: `event ${repo} ${action.target} follow-up claim released, marker ${action.release.marker}`,
    at,
    repo,
    stage: "followup",
    target: action.target,
    event: "followup-released",
    account: null,
    class: "stalled",
    reason: action.reason,
  };
}

/** Release one stale claim: its fresh read, the pending record, the deletion and the record marked released. */
async function releaseOne(
  state: ApplyState,
  repo: RepoTarget,
  action: Release,
  ctx: FollowupContext,
): Promise<ReleaseOutcome> {
  const late = outOfTime(state);
  if (late !== null) return outcomeOf(action, "waits", late);
  const pr = Number(action.target.replace(/^PR #/, ""));
  const { marker } = action.release;
  const why = await changed(repo, ctx, pr, marker);
  if (why !== null) return outcomeOf(action, "waits", why);
  const root = state.root ?? stateRoot();
  const key = { repo: repo.slug, pr, marker };
  if (!beginRelease({ ...key, ...action.release }, root))
    return outcomeOf(
      action,
      "waits",
      "a release of another claim on it is already recorded: it is a person's to settle",
    );
  const deleted = await ctx.shared.records.release(
    { repo: repo.slug, pr },
    marker,
  );
  if (!deleted.ok) {
    return outcomeOf(
      action,
      "refused",
      `marker comment ${marker} could not be deleted: ${deleted.failure.reason}; the pending record is kept for a fresh marker listing`,
    );
  }
  finishRelease(
    key,
    eventRow(repo.slug, action, new Date().toISOString()),
    root,
  );
  return outcomeOf(
    action,
    "released",
    `deleted marker comment ${marker}, ${action.release.claimant}'s claim from ${action.release.claimedAt}; the next tick wants the follow-up again, and a claim on it that goes stale again is a person's`,
  );
}

/** `--apply` for one repository's stale follow-up claims. */
export async function applyReleases(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  ctx: FollowupContext,
): Promise<void> {
  const releases = report.actions.filter(isRelease);
  if (releases.length === 0) return;
  report.releases ??= [];
  for (const action of releases)
    report.releases.push(await releaseOne(state, repo, action, ctx));
}
