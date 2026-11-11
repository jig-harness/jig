/**
 * A re-arm that failed before its drive moved the ledger: the launch record
 * ended on a non-zero exit that is neither a second driver's refusal
 * (`DRIVER_REFUSAL_EXITS`, which `drive-hold.ts` answers) nor the account's
 * usage-limit wall (`walls.ts`), and the ledger still shows the facts the
 * re-arm acted on. Started again on the same pull request head, branch head
 * and ledger generation, it fails the same way, so it is not started again
 * until one of them changes: the drive becomes a person's
 * (`needs-person`), notified once for those facts. A pull request whose head
 * is not its branch's head is behind its branch, which a drive's attach
 * refuses; closing and reopening the pull request makes the forge take the
 * branch's head, and the next tick re-arms it.
 *
 * Each re-arm of a `re-armable` ledger with a recorded exit records the heads
 * it launched at (`LaunchRecord.heads`). The heads are read again only for a
 * drive whose latest record is such a failure, so a tick spends one forge
 * read on each, and none on any other drive. A record with no heads, and a
 * drive whose heads do not read now, are re-armed as before: an unreadable
 * forge is transient, and a hold this module cannot show the cause of would
 * stop a drive no person was told about.
 */
import {
  DRIVE_EXIT,
  DRIVER_REFUSAL_EXITS,
} from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import type { Outcome } from "../../shared/outcome.ts";
import { factsOf } from "./actions/drive-hold.ts";
import { branchHead, pullRequestHead } from "./forge.ts";
import {
  cancelledBeforeExecution,
  isDrive,
  type ReadRecord,
} from "./launches.ts";
import { sameFacts } from "./recovery-facts.ts";
import type { DrivenPr, RearmHeads } from "./types.ts";

/**
 * Reads the heads a failed re-arm is weighed by. A read given `timeoutSec`
 * ends within it, so a caller holding a deadline bounds the read by what it
 * has left.
 */
export interface HeadReader {
  pr(
    slug: string,
    pr: number,
    timeoutSec?: number,
  ): Promise<Outcome<string, "unreadable">>;
  branch(
    slug: string,
    branch: string,
    timeoutSec?: number,
  ): Promise<Outcome<string, "unreadable">>;
}

const FORGE_HEADS: HeadReader = { pr: pullRequestHead, branch: branchHead };

/** The heads as a launch record keeps them. */
function headsText(heads: RearmHeads): string {
  return `PR head ${heads.pr}, branch head ${heads.branch}`;
}

/** Whether a re-arm of this drive records the heads it launched at: a `re-armable` ledger with a recorded exit. */
function weighsHeads(pr: DrivenPr): boolean {
  return pr.class === "re-armable" && pr.evidence.noCause !== true;
}

/** A drive's latest launch record, when it is a re-arm that failed on the ledger facts as they are now, with the heads it launched at. */
function failedRearm(
  pr: DrivenPr,
  own: readonly ReadRecord[],
): { record: ReadRecord; exit: number; heads: string } | null {
  if (!weighsHeads(pr) || pr.evidence.rearm === true) return null;
  const latest = own
    .filter(
      (r) =>
        isDrive(r.record) &&
        r.record.pr === pr.number &&
        !cancelledBeforeExecution(r),
    )
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt))
    .at(-1);
  const s = latest?.state;
  if (
    latest === undefined ||
    s?.kind !== "ended" ||
    latest.record.action !== "rearm" ||
    latest.record.heads == null ||
    !sameFacts(latest.record.facts, factsOf(pr))
  )
    return null;
  const exit = s.exit.code;
  const wall =
    exit === DRIVE_EXIT.QUOTA_PARKED ||
    s.exit.startup === "quota" ||
    s.exit.wallUnrecorded === true;
  if (exit === null || exit === 0 || wall || DRIVER_REFUSAL_EXITS.has(exit))
    return null;
  return { record: latest, exit, heads: latest.record.heads };
}

/**
 * The heads a re-arm of `pr` launches at, read now; `null` when either does
 * not read, the drive does not weigh them, or `leftMs`, the time the caller
 * has left (`null` for no deadline), is spent. Each read ends within it.
 */
export async function launchHeads(
  slug: string,
  pr: DrivenPr,
  read: HeadReader = FORGE_HEADS,
  leftMs: number | null = null,
): Promise<string | null> {
  if (!weighsHeads(pr) || (leftMs !== null && leftMs < 1000)) return null;
  const timeoutSec = leftMs === null ? undefined : Math.floor(leftMs / 1000);
  const [head, branch] = await Promise.all([
    read.pr(slug, pr.number, timeoutSec),
    read.branch(slug, pr.head, timeoutSec),
  ]);
  return head.ok && branch.ok
    ? headsText({ pr: head.value, branch: branch.value })
    : null;
}

/**
 * Each drive whose latest re-arm failed, with its heads read now: the pull
 * request's head as the tick listed it (`open`), and its branch's head read
 * from the forge. A drive whose heads do not read is left as it is.
 */
export async function withRearmHeads(
  slug: string,
  drives: readonly DrivenPr[],
  open: readonly { number: number; headRefOid?: string }[],
  records: readonly ReadRecord[],
  read: HeadReader = FORGE_HEADS,
): Promise<DrivenPr[]> {
  const own = records.filter((r) => r.record.repo === slug);
  const listed = new Map(open.map((p) => [p.number, p.headRefOid]));
  return Promise.all(
    drives.map(async (pr) => {
      const head = listed.get(pr.number);
      if (failedRearm(pr, own) === null || !head) return pr;
      const branch = await read.branch(slug, pr.head);
      return branch.ok
        ? { ...pr, heads: { pr: head, branch: branch.value } }
        : pr;
    }),
  );
}

/**
 * Each drive whose latest re-arm failed at the heads it shows now, on the
 * same ledger facts: a person's, with the cause, and with the recovery when
 * its pull request is behind its branch. Any change of either head or of the
 * ledger leaves it to be re-armed.
 */
export function settleFailedRearms(
  drives: readonly DrivenPr[],
  own: readonly ReadRecord[],
): DrivenPr[] {
  return drives.map((pr) => {
    const failed = failedRearm(pr, own);
    const heads = pr.heads;
    if (failed === null || heads === undefined) return pr;
    if (headsText(heads) !== failed.heads) return pr;
    const launch = `its re-arm (launch record ${failed.record.record.id}) ended ${failed.exit} without moving its ledger`;
    const why =
      heads.pr === heads.branch
        ? `${launch}, at the same pull request head ${heads.pr.slice(0, 12)} and ledger generation as now: it is not re-armed until its head, its branch's head or its ledger generation changes; a person reads why in the re-arm's output and the drive's handoff`
        : `${launch}: PR #${pr.number} is behind its branch '${pr.head}' (the pull request's head is ${heads.pr.slice(0, 12)}, the branch's ${heads.branch.slice(0, 12)}); close and reopen the pull request so the forge takes the branch's head, and the next tick re-arms it`;
    return {
      ...pr,
      class: "needs-person",
      why,
      evidence: {
        ...pr.evidence,
        failedRearm: failed.record.record.id,
        rearmExit: failed.exit,
        prHead: heads.pr,
        branchHead: heads.branch,
      },
    };
  });
}
