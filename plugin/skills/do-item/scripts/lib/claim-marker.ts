/**
 * The claim marker (`do_item.claim_marker`): a comment a claim posts on the
 * item before it writes the item's assignee or state, so another tool
 * reading the tracker can tell which session holds it, the dispatcher can
 * join the claim to its session, and two hosts claiming one item at once
 * agree on which of them holds it (`claim-token.ts`). It is a shared record
 * (`shared/records/envelope.ts`), written in the records codec's marker form
 * the dispatcher's launch claims use:
 *
 *   <!-- jig-claim -->
 *   <!-- jig-claim-data
 *   {"kind":"tracker-claim-marker","v":1,"key":"claim","writer":{…},"at":"…","attempt":"…","session":"…","branch":"…","claimant":"…"}
 *   -->
 *   Claimed by <claimant> · session <id> · branch <branch>
 *
 * The writer's host is a digest, as on every record the tracker keeps.
 */
import { git } from "../../../../shared/proc.ts";
import {
  decodeMarker,
  encodeMarker,
} from "../../../../shared/records/envelope.ts";
import { localWriter } from "../../../../shared/records/writer.ts";

export const CLAIM_MARKER = "<!-- jig-claim -->";
const CLAIM_DATA = "jig-claim-data";
/** The marker's kind in the records registry. */
export const CLAIM_MARKER_KIND = "tracker-claim-marker";
export const CLAIM_MARKER_VERSION = 1;
/** What a claim marker claims: the item it is on. */
export const CLAIM_MARKER_KEY = "claim";

export interface ClaimMarkerFacts {
  /**
   * The claim attempt the marker stands for, unique to it, so the claim
   * finds its own comment when it reads the item's markers back; absent on
   * a marker written before markers named their attempt.
   */
  attempt?: string;
  /** The agent session that claimed: Claude Code's or Codex's id, `unknown` when neither is set. */
  session: string;
  /** The branch checked out where the claim ran; `HEAD` when detached. */
  branch: string;
  /** Who the item is now assigned to. */
  claimant: string;
  at: string;
}

/** The session the claim runs in, as the intent chain names it. */
export function claimSession(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID || "unknown";
}

/** The branch checked out at `root`; `HEAD` when detached or unreadable. */
export async function claimBranch(root: string): Promise<string> {
  const head = await git(["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
    stderr: "pipe",
    timeoutSec: 10,
  });
  const name = head.stdout.trim();
  return head.code === 0 && name !== "" ? name : "HEAD";
}

/** The comment a claim posts. */
export function claimMarkerBody(facts: ClaimMarkerFacts): string {
  const data = encodeMarker(
    CLAIM_DATA,
    {
      kind: CLAIM_MARKER_KIND,
      v: CLAIM_MARKER_VERSION,
      key: CLAIM_MARKER_KEY,
      writer: localWriter("tracker"),
      at: facts.at,
    },
    {
      ...(facts.attempt === undefined ? {} : { attempt: facts.attempt }),
      session: facts.session,
      branch: facts.branch,
      claimant: facts.claimant,
    },
  );
  const line = `Claimed by ${facts.claimant} · session ${facts.session} · branch ${facts.branch}`;
  return `${CLAIM_MARKER}\n${data}\n${line}\n`;
}

/**
 * The facts a comment's claim marker states; `null` when the comment holds
 * none, or one that does not read. What it names is data: nothing reads a
 * field of it as an act.
 */
export function readClaimMarker(body: string): ClaimMarkerFacts | null {
  if (!body.includes(`<!-- ${CLAIM_DATA}`)) return null;
  const read = decodeMarker(body, CLAIM_DATA, CLAIM_MARKER_KIND);
  if (!read.ok) return null;
  const { attempt, session, branch, claimant } = read.value.payload;
  if (
    typeof session !== "string" ||
    typeof branch !== "string" ||
    typeof claimant !== "string"
  )
    return null;
  return {
    ...(typeof attempt === "string" ? { attempt } : {}),
    session,
    branch,
    claimant,
    at: read.value.envelope.at,
  };
}
