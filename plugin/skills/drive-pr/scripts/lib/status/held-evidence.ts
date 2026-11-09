/** Read hold currency in the drive's local review-round coordinate. */
import { run, tsArgv } from "../proc.ts";
import { asCommentRecord } from "./thread-evidence.ts";

export interface HeldEvidence {
  byKey: Map<string, Record<string, unknown>>;
  reviewRound: number | null;
}

export async function readHeldEvidence(
  script: string,
  pr: string,
  timeoutSec: number,
  reviewedHead: string,
): Promise<HeldEvidence> {
  const result: HeldEvidence = { byKey: new Map(), reviewRound: null };
  const response = await run(tsArgv(script, ["get", pr]), {
    stderr: "inherit",
    timeoutSec,
  });
  if (response.code === 0) {
    try {
      const prospective = await run(
        tsArgv(script, ["prospective-round", pr, "--head", reviewedHead]),
        { stderr: "inherit", timeoutSec },
      );
      const evidence = heldEvidenceFromState(
        JSON.parse(response.stdout),
        prospective,
      );
      if (evidence !== null) return evidence;
    } catch {
      /* An unreadable advisory input counts paths conservatively. */
    }
  }
  console.error(
    `evaluate: could not read hold currency for #${pr} — proceeding without excluding held items from recurrence evidence`,
  );
  return result;
}

/** Narrow the persisted fields before deriving the current local round. */
function heldEvidenceFromState(
  value: unknown,
  prospective: { code: number; stdout: string },
): HeldEvidence | null {
  const state = asCommentRecord(value);
  if (
    state === null ||
    !Array.isArray(state.held) ||
    typeof state.rounds !== "number" ||
    !Number.isInteger(state.rounds) ||
    state.rounds < 0 ||
    typeof state.lastCountedHead !== "string" ||
    prospective.code !== 0
  )
    return null;
  const reviewRound = Number(prospective.stdout.trim());
  if (!Number.isInteger(reviewRound) || reviewRound < 0) return null;
  return { byKey: heldRecordsByKey(state.held), reviewRound };
}

function heldRecordsByKey(
  entries: unknown[],
): Map<string, Record<string, unknown>> {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const record = asCommentRecord(entry);
    if (record && typeof record.key === "string" && record.key !== "")
      byKey.set(record.key, record);
  }
  return byKey;
}

export function isFindingHoldCurrent(
  evidence: HeldEvidence,
  key: string,
): boolean {
  const hold = evidence.byKey.get(key);
  return (
    hold?.kind === "finding" &&
    typeof hold.round === "number" &&
    hold.round >= 0 &&
    evidence.reviewRound !== null &&
    hold.round === evidence.reviewRound
  );
}
