/** Arrange completed ladder triage for probes of later lifecycle steps. */
import { driveDb } from "../scripts/lib/state/db.ts";
import { freshState, isUsableState } from "../scripts/lib/state/schema.ts";
import { readState, writeState } from "./state-rows.ts";

export function seedAcceptedLadder(
  stateDir: string,
  key: string,
  pr = "999",
): void {
  const state = readState(stateDir, pr) ?? freshState(Number(pr));
  if (!isUsableState(state, Number(pr))) return;
  const drive = driveDb(stateDir);
  const row = drive.db
    .query(
      "SELECT MAX(round) AS round FROM review_rounds WHERE clone = ? AND pr = ?",
    )
    .get(drive.clone, pr) as { round: number | null };
  writeState(stateDir, pr, {
    ...state,
    ladderVerdicts: [
      ...(state.ladderVerdicts ?? []).filter((v) => v.key !== key),
      {
        key,
        stance: "accepted",
        round: Math.max(state.rounds, row.round ?? 0),
      },
    ],
  });
}
