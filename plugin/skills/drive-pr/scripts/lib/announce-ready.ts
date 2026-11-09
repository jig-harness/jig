/**
 * The Ready predicate (`merge-ready.ts`) as the merge-ready announcement
 * asks it, on top of its own gates: the forge's protection and review
 * requirements, read live for the announced head. The announcement posts
 * only in merge now or approve first, and words the second as "an approval
 * is still required"; anywhere else it refuses with the predicate's words.
 *
 * The repository's rules are the drive's own (`overlay.ts`), so the review
 * witness is the reviewer app and check the drive's convergence matched.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { reconcileWording } from "./announce-wording.ts";
import { withdrawAnnouncement } from "./announce.ts";
import { readMergeFacts } from "./merge-facts.ts";
import {
  type ForgeFacts,
  type Lane,
  type Readiness,
  type ReadyRules,
  readiness,
} from "./merge-ready.ts";
import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import {
  ciHoldLabelSetting,
  readOptionalOverlay,
  reviewerApp,
} from "./overlay.ts";
import { ghCallTimeoutSeconds } from "./proc.ts";
import { REVIEWER_CHECK } from "./status/evidence.ts";

/** What the predicate says of the announced head: `rc` `0` with its lane, `4` placed elsewhere, `1` unread. */
export interface AnnounceReady {
  rc: 0 | 1 | 4;
  lane: Lane | null;
  says: string;
}

/** The drive's own rules (`overlay.ts`): the reviewer app and check its convergence matched. */
function driveRules(): ReadyRules {
  const app = reviewerApp();
  return {
    reviewerApp: app === "" ? null : app,
    reviewerCheck: REVIEWER_CHECK,
    ciHoldLabel: ciHoldLabelSetting() ?? null,
  };
}

/** PR `pr`'s facts, read live, or why they did not read. */
async function liveFacts(
  pr: number,
): Promise<Outcome<ForgeFacts, "unreadable">> {
  const read = await readMergeFacts(null, [pr], ghCallTimeoutSeconds());
  if (!read.ok) return read;
  const facts = read.value.pulls.get(pr);
  return facts === undefined
    ? failed("unreadable", "the forge did not give this pull request")
    : ok(facts);
}

/** The predicate's placement as the announcement's exit: `0` in merge now or approve first, `1` where it was, `4` elsewhere. */
function rcOf(answer: Readiness): AnnounceReady["rc"] {
  if (answer.lane === "merge-now" || answer.lane === "approve-first") return 0;
  return answer.place === "stay" ? 1 : 4;
}

/** Ask the predicate about PR `pr` at `head`, read live from the forge. */
export async function announceReady(
  pr: string,
  head: string,
): Promise<AnnounceReady> {
  const facts = await liveFacts(Number(pr));
  if (!facts.ok)
    return {
      rc: 1,
      lane: null,
      says: `the forge's merge facts did not read: ${facts.failure.reason}`,
    };
  const hold = holdLabel();
  const answer = readiness(
    {
      ...facts.value,
      slug: "",
      converged: true,
      verifiedSha: head,
      held: facts.value.labels.includes(hold),
    },
    driveRules(),
  );
  return { rc: rcOf(answer), lane: answer.lane, says: answer.says };
}

/** The exit of a re-check against the lane the announcement was written for: `4` when the lane moved. */
export async function laneHolds(
  pr: string,
  head: string,
  lane: Lane | null,
  standingIds: readonly number[] = [],
): Promise<number> {
  const now = await readyOrWithdraw(pr, head, standingIds);
  if (now.rc !== 0) return now.rc;
  if (now.lane === lane) return 0;
  // The surviving wording is for another lane; remove it rather than leave
  // a claim whose warning the final read no longer supports.
  return (await withdrawAll(pr, standingIds)) ? 4 : 1;
}

/** The dispatch `hold` label's name, where the repository turns dispatch labels on; a name no label has where it does not. */
function holdLabel(): string {
  const labels = labelsSection(readOptionalOverlay().dispatch);
  return labels?.enabled === true ? `${prefixOf(labels)}hold` : "";
}

/** The `dispatch.labels` section, `null` when there is none. */
function labelsSection(dispatch: unknown): Record<string, unknown> | null {
  const labels = isRecord(dispatch) ? dispatch.labels : undefined;
  return isRecord(labels) ? labels : null;
}

/** The labels' prefix, `jig:` by default. */
function prefixOf(labels: Record<string, unknown>): string {
  return typeof labels.prefix === "string" ? labels.prefix : "jig:";
}

/** Withdraw each of `ids`; `false` at the first one that stays, said on stderr. */
async function withdrawAll(
  pr: string,
  ids: readonly number[],
): Promise<boolean> {
  for (const id of ids)
    if (!(await withdrawAnnouncement(pr, id))) {
      console.error(
        `announce-merge-ready: could NOT withdraw comment ${id} — remove it by hand.`,
      );
      return false;
    }
  return true;
}

/**
 * Ask the predicate, and when it places the pull request elsewhere (`4`),
 * withdraw the standing announcements `ids` names: an announcement the forge
 * no longer backs is withdrawn, never left standing. Says why it refuses.
 */
export async function readyOrWithdraw(
  pr: string,
  head: string,
  ids: readonly number[],
): Promise<AnnounceReady> {
  const answer = await announceReady(pr, head);
  if (answer.rc === 0) return answer;
  console.error(`announce-merge-ready: ${answer.says} — refusing to announce`);
  const withdrawn = answer.rc !== 4 || (await withdrawAll(pr, ids));
  return withdrawn ? answer : { ...answer, rc: 1 };
}

/** Reconcile every surviving announcement through one live read, wording update and final withdrawal check. */
export async function reconcileStanding(
  pr: string,
  head: string,
  ids: readonly number[],
  dryRun: boolean,
): Promise<number> {
  const standing = dryRun ? [] : ids;
  const current = await readyOrWithdraw(pr, head, standing);
  if (current.rc !== 0) return current.rc;
  const wording = await reconcileWording(pr, ids, head, current.lane, dryRun);
  if (wording !== 0) return wording;
  return await laneHolds(pr, head, current.lane, standing);
}
