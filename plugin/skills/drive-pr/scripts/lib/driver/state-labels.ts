/**
 * The drive's own pull request state label, written when its ledger changes:
 * `driving` once the arm has published the running ledger (removing the
 * `drive` command label in the same write), and at the stop the ledger
 * records, `converged` for `CONVERGED`, `parked` for `HITL_PARKED` and for
 * `REVIEW_SKIPPED`, which a person settles. Any other stop leaves the labels
 * to the dispatcher's tick, which reads what the drive cannot (whether a
 * converged head moved, whether the pull request conflicts), and so does a
 * drive with no ledger (a dry run, `$DRIVE_PR_LEDGER=off`).
 *
 * The state comes from the shared projection (`shared/pr-labels/`), the one
 * the tick projects with, and the setting from `dispatch.labels` in the
 * repository's configuration layers, so a repository with no dispatcher
 * turns the labels on the same way. The write is best effort and bounded:
 * two `gh` calls under `ghCall`'s deadline, the second only when the labels
 * disagree; a refusal is one line on the drive's output and never changes
 * its exit. It leaves a pull request carrying `hold` or `held` as it is, and
 * never creates a label: the one-time label setup does
 * (`jig dispatch labels`).
 */
import { failed, ok } from "../../../../../shared/outcome.ts";
import { readLabelConfig } from "../../../../../shared/pr-labels/config.ts";
import {
  type DoneExits,
  type LedgerReading,
  ledgerState,
} from "../../../../../shared/pr-labels/projection.ts";
import {
  type OwnForge,
  ownWriteLine,
  writeOwnState,
} from "../../../../../shared/pr-labels/write.ts";
import { forge } from "../state/ledger-forge.ts";
import { DRIVE_EXIT } from "../status/terminal-states.ts";

const DONE_EXITS: DoneExits = {
  converged: DRIVE_EXIT.CONVERGED,
  takenOver: DRIVE_EXIT.TAKEN_OVER,
};

/** The ledger change a label follows: the arm's running ledger, or a stop with its exit. */
export type DriveMoment = { armed: true } | { stopped: number };

/** How the dispatcher will read the ledger this moment writes; `null` for a stop whose state only the tick can tell. */
export function ledgerAt(moment: DriveMoment): LedgerReading | null {
  if ("armed" in moment) return { class: "driven" };
  const code = moment.stopped;
  if (code === DRIVE_EXIT.CONVERGED) return { class: "done", exit: code };
  if (code === DRIVE_EXIT.HITL_PARKED) return { class: "parked" };
  if (code === DRIVE_EXIT.REVIEW_SKIPPED) return { class: "needs-person" };
  return null;
}

/** The pull request's labels and their edit, through the drive's own `gh` chokepoint. */
export const driveLabelForge: OwnForge = {
  async labels(pr) {
    const r = await forge(["pr", "view", String(pr), "--json", "labels"]);
    if (!r.ok) return failed("unreadable", `its labels did not read: ${r.why}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      return failed("unreadable", "its labels did not read: not JSON");
    }
    const labels = (parsed as { labels?: unknown }).labels;
    if (!Array.isArray(labels))
      return failed("unreadable", "its labels did not read: no label list");
    return ok(
      labels
        .map((l) => (l as { name?: unknown }).name)
        .filter((n): n is string => typeof n === "string"),
    );
  },
  async edit(pr, add, remove) {
    const r = await forge([
      "pr",
      "edit",
      String(pr),
      ...add.flatMap((l) => ["--add-label", l]),
      ...remove.flatMap((l) => ["--remove-label", l]),
    ]);
    return r.ok ? ok(undefined) : failed("refused", r.why);
  },
};

/**
 * Write the label `moment` gives pull request `pr`, and say what happened on
 * stderr. Never throws, and never changes the drive's exit.
 */
export async function labelDrive(
  pr: string,
  moment: DriveMoment,
  labelForge: OwnForge = driveLabelForge,
): Promise<void> {
  try {
    const ledger = ledgerAt(moment);
    if (ledger === null) return;
    const config = readLabelConfig();
    if (!config.ok) {
      console.error(
        `labels: PR #${pr}'s state label is not written: dispatch.labels does not read (${config.failure.reason})`,
      );
      return;
    }
    const written = await writeOwnState({
      config: config.value,
      pr: Number(pr),
      projected: ledgerState(ledger, DONE_EXITS),
      writer: "drive",
      forge: labelForge,
    });
    const line = ownWriteLine(Number(pr), written);
    if (line !== null) console.error(`labels: ${line}`);
  } catch (error) {
    console.error(
      `labels: PR #${pr}'s state label could not be written (${error instanceof Error ? error.message : String(error)}); the dispatcher's next tick corrects it`,
    );
  }
}
