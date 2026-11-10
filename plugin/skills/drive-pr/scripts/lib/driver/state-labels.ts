/**
 * The drive's own pull request state label, written when the drive itself
 * writes its ledger: `driving` once the arm has published the running
 * ledger (removing the `drive` command label in the same write), and at the
 * stop the stopped ledger records, as the exit table both the drive and the
 * dispatcher read gives it (`../status/exit-classes.ts`): `converged` for
 * `CONVERGED` while the pull request's head is still the head the drive
 * verified, `parked` for a park, a stop only a person settles, a person's
 * stop and a stop the dispatcher would re-drive, `driving` for a stop the
 * dispatcher re-arms. A stop on a pull request no longer open, and a drive
 * with no ledger (a dry run, `$DRIVE_PR_LEDGER=off`), leave the labels. A
 * ledger write the guards refused (a lost acquisition, a newer takeover
 * claim) is not this drive's, so no label follows it.
 *
 * The state comes from the shared projection (`shared/pr-labels/`), the one
 * the dispatcher's tick projects with, and the setting from `dispatch.labels`
 * on the repository's default branch, as the tick and the label setup read it
 * (`dispatch/lib/label-config.ts`), so a repository with no dispatcher turns
 * the labels on the same way. The write is best effort and bounded: every
 * `gh` call goes through `ghCall`'s deadline, and the edit is made only when
 * the labels disagree; a refusal is one line on the drive's output and never
 * changes its exit, and a defect is reported with its stack, never thrown. It
 * leaves a pull request carrying `hold` or `held` as it is, and never creates
 * a label: the one-time label setup does (`jig dispatch labels`).
 */
import { attempt, failed, ok } from "../../../../../shared/outcome.ts";
import {
  type DoneExits,
  type LedgerReading,
  ledgerState,
} from "../../../../../shared/pr-labels/projection.ts";
import {
  defectLine,
  type OwnForge,
  ownWriteLine,
  writeOwnState,
} from "../../../../../shared/pr-labels/write.ts";
import { defaultBranchLabels } from "../../../../../dispatch/lib/label-config.ts";
import { forge } from "../state/ledger-forge.ts";
import { driveStopClass } from "../status/exit-classes.ts";
import { DRIVE_EXIT } from "../status/terminal-states.ts";

const DONE_EXITS: DoneExits = {
  converged: DRIVE_EXIT.CONVERGED,
  takenOver: DRIVE_EXIT.TAKEN_OVER,
};

/**
 * The ledger write a label follows: the arm's running ledger, or a stop with
 * its exit (`null` when unknown), whether a person's stop is recorded for it,
 * and the head the drive verified.
 */
export type DriveMoment =
  | { armed: true }
  | { stopped: number | null; byPerson: boolean; verifiedSha: string };

/** How the dispatcher will read the ledger this moment writes, as the drive labels it; `null` for a stop with no exit and no person's stop. */
export function ledgerAt(moment: DriveMoment): LedgerReading | null {
  if ("armed" in moment) return { class: "driven" };
  // A stop from outside the drive (`drives.ts --stop`) names no exit; a person's recorded stop still reads as theirs.
  if (moment.stopped === null)
    return moment.byPerson ? { class: "stopped-by-person" } : null;
  return driveStopClass(moment.stopped, moment.byPerson);
}

/** The labels and head of a pull request on `slug`, and their edit, through the drive's own `gh` chokepoint. */
export function driveLabelForge(slug: string): OwnForge {
  return {
    async labels(pr) {
      const r = await forge([
        "pr",
        "view",
        String(pr),
        "--repo",
        slug,
        "--json",
        "labels,headRefOid",
      ]);
      if (!r.ok)
        return failed("unreadable", `its labels did not read: ${r.why}`);
      const parsed = attempt("unreadable", "its labels did not read", () =>
        JSON.parse(r.stdout),
      );
      if (!parsed.ok) return parsed;
      const value = parsed.value as { labels?: unknown; headRefOid?: unknown };
      if (!Array.isArray(value.labels))
        return failed("unreadable", "its labels did not read: no label list");
      const labels = value.labels
        .map((l) => (l as { name?: unknown }).name)
        .filter((n): n is string => typeof n === "string");
      return ok(
        typeof value.headRefOid === "string"
          ? { labels, head: value.headRefOid }
          : { labels },
      );
    },
    async edit(pr, add, remove) {
      const r = await forge([
        "pr",
        "edit",
        String(pr),
        "--repo",
        slug,
        ...add.flatMap((l) => ["--add-label", l]),
        ...remove.flatMap((l) => ["--remove-label", l]),
      ]);
      return r.ok ? ok(undefined) : failed("refused", r.why);
    },
  };
}

/** Where the label calls go: the repository's setting and its forge; by default the checkout's repository on the forge. */
export interface LabelSource {
  settings(): ReturnType<typeof defaultBranchLabels>;
  forge(slug: string): OwnForge;
}

const FORGE_SOURCE: LabelSource = {
  settings: () => defaultBranchLabels(process.cwd()),
  forge: driveLabelForge,
};

/**
 * Write the label `momentOf` gives pull request `pr` (the moment, or how to
 * read it), and say what happened on stderr. Never throws, and never
 * changes the drive's exit.
 */
export async function labelDrive(
  pr: string,
  momentOf: DriveMoment | (() => Promise<DriveMoment>),
  source: LabelSource = FORGE_SOURCE,
  /** Asked just before the write: `false` when the ledger no longer belongs to this acquisition, so the label is left. */
  stillOurs: () => Promise<boolean> = async () => true,
): Promise<void> {
  try {
    // A moment read from the drive's state is read here, inside the boundary, so a throw there is reported, not the drive's.
    const moment = typeof momentOf === "function" ? await momentOf() : momentOf;
    const ledger = ledgerAt(moment);
    if (ledger === null) return;
    const settings = await source.settings();
    if (!settings.ok) {
      console.error(
        `labels: PR #${pr}'s state label is not written: dispatch.labels does not read (${settings.failure.reason})`,
      );
      return;
    }
    const projected = ledgerState(ledger, DONE_EXITS);
    const converged =
      "stopped" in moment &&
      projected !== "unknown" &&
      projected.state === "converged";
    if (converged && moment.verifiedSha === "") {
      console.error(
        `labels: PR #${pr}'s labels are left as they are: the drive recorded no verified head to label converged`,
      );
      return;
    }
    if (!(await stillOurs())) {
      console.error(
        `labels: PR #${pr}'s labels are left as they are: its drive ledger no longer belongs to this driver`,
      );
      return;
    }
    const written = await writeOwnState({
      config: settings.value.config,
      pr: Number(pr),
      projected,
      writer: "drive",
      forge: source.forge(settings.value.slug),
      ...(converged ? { head: moment.verifiedSha } : {}),
    });
    const line = ownWriteLine(Number(pr), written);
    if (line !== null) console.error(`labels: ${line}`);
  } catch (error) {
    console.error(`labels: ${defectLine(`PR #${pr}`, error)}`);
  }
}
