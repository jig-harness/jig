/**
 * The CI hold's durable record and the reads that establish it: the drive
 * state's `ciHold` field, the check runs on a head, and the adoption of a
 * live hold label the drive holds no record of.
 */

import { swallow } from "../../../../shared/errors.ts";
import {
  type CheckRunLite,
  checkRunWatermark,
  type LabelTransition,
  parseCheckRuns,
  ownsHeldTransition,
} from "./ci-hold.ts";
import { fail, isGitSha } from "./cli.ts";
import { ghCall } from "./proc.ts";
import type { CiHoldState } from "./state/schema.ts";
import { openStore } from "./state/store.ts";

type HeldState = Extract<CiHoldState, { phase: "held" }>;

export async function readCiState(pr: string): Promise<CiHoldState | null> {
  return (await openStore(pr)).read().state.ciHold;
}

export async function writeCiState(
  pr: string,
  state: CiHoldState | null,
): Promise<void> {
  const store = await openStore(pr);
  await store.update((current) => ({ ...current, ciHold: state }));
}

export async function checkRuns(head: string): Promise<CheckRunLite[] | null> {
  const result = await ghCall([
    "api",
    "--paginate",
    "--slurp",
    `repos/{owner}/{repo}/commits/${head}/check-runs?per_page=100`,
  ]);
  if (result.code !== 0) return null;
  try {
    return parseCheckRuns(JSON.parse(result.stdout) as unknown);
  } catch (err) {
    swallow(err, "the check-runs answer is not JSON");
    return null;
  }
}

/**
 * The highest check-run id on `head`; exits 1 when the runs cannot be read,
 * and answers `null` when they were read and none is registered yet (the
 * caller waits: a zero watermark is never recorded for a drive release).
 */
export async function headWatermark(
  head: string,
  why: string,
): Promise<number | null> {
  const runs = await checkRuns(head);
  if (runs === null || !isGitSha(head))
    fail(1, `ci-hold: cannot establish the check-run watermark ${why}`);
  return checkRunWatermark(runs, head);
}

/**
 * Record a live hold label's newest `labeled` event as this drive's own, so
 * that the drive pushes under it and removes it at convergence. The label is
 * a CI cost setting: whoever added it, removing it costs one full CI run,
 * which convergence needs anyway, and the final head is certified only on
 * checks that started after the removal. `null` while the timeline does not
 * yet show the label being added.
 */
export async function adopt(
  pr: string,
  head: string,
  latest: LabelTransition | null,
  label: string,
): Promise<HeldState | null> {
  if (latest?.event !== "labeled") return null;
  const held: HeldState = {
    phase: "held",
    adopted: true,
    eventId: latest.id,
    addedAtHead: head,
    actor: latest.actor,
    createdAt: latest.createdAt,
    // Adoption adds no label and needs no pre-add check evidence. Release
    // captures its own watermark immediately before removing the label.
    checkRunWatermark: 0,
  };
  await writeCiState(pr, held);
  console.error(
    `ci-hold: adopted '${label}', added by ${latest.actor} at ${latest.createdAt}; the drive removes it at convergence`,
  );
  return held;
}

/** A live hold label is this drive's (`owned`), or becomes it (`adopted`). */
export async function confirmLiveHold(
  pr: string,
  head: string,
  persisted: CiHoldState | null,
  latest: LabelTransition | null,
  label: string,
): Promise<number> {
  if (ownsHeldTransition(persisted, latest)) {
    process.stdout.write(
      persisted?.phase === "held" && persisted.adopted === true
        ? "adopted\n"
        : "owned\n",
    );
    return 0;
  }
  if ((await adopt(pr, head, latest, label)) !== null) {
    process.stdout.write("adopted\n");
    return 0;
  }
  await writeCiState(pr, null);
  console.error(
    `ci-hold: '${label}' is present but the timeline does not show it being added yet; retrying later`,
  );
  return 4;
}
