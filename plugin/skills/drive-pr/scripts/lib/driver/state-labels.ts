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
 *
 * The same write carries the projection's tracker output where the
 * repository names `issue_tracker.states.blocked`: a stop with only parked
 * work left moves the items the pull request links to `blocked`, and the
 * arm returns them to the state they left (`do-item/scripts/lib/blocked-move.ts`),
 * under the same rules: best effort, only where the tracker disagrees,
 * never on a pull request carrying `hold` or `held`.
 */
import {
  attempt,
  failed,
  ok,
  type Outcome,
} from "../../../../../shared/outcome.ts";
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
import {
  type ParkLike,
  parkCauses,
} from "../../../../../shared/pr-labels/blocked.ts";
import type { LabelConfig } from "../../../../../shared/pr-labels/projection.ts";
import {
  type BlockedPr,
  blockedLine,
  projectBlocked,
} from "../../../../do-item/scripts/lib/blocked-move.ts";
import { issueKeysOf } from "../../../../do-item/scripts/lib/tracker/keys.ts";
import { openTracker } from "../../../../do-item/scripts/lib/tracker/index.ts";
import { ownTrackerConfig } from "../../../../do-item/scripts/lib/tracker/config.ts";
import { forge } from "../state/ledger-forge.ts";
import { driveStopClass } from "../status/exit-classes.ts";
import { DRIVE_EXIT, driveExitName } from "../status/terminal-states.ts";

const DONE_EXITS: DoneExits = {
  converged: DRIVE_EXIT.CONVERGED,
  takenOver: DRIVE_EXIT.TAKEN_OVER,
};

/**
 * The ledger write a label follows: the arm's running ledger, or a stop with
 * its exit (`null` when unknown), whether a person's stop is recorded for it,
 * and the head the drive verified; for the tracker's `blocked` output, which
 * stop it is (`stopKey`) and the parks it left.
 */
export type DriveMoment =
  | { armed: true }
  | {
      stopped: number | null;
      byPerson: boolean;
      verifiedSha: string;
      stop?: string;
      parks?: ParkLike[];
    };

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
      const names = value.labels.map(
        (l) => (l as { name?: unknown } | null)?.name,
      );
      if (!names.every((n): n is string => typeof n === "string"))
        return failed(
          "unreadable",
          "its labels did not read: a label has no name",
        );
      const labels = names;
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

/** What the tracker output reads of the pull request: its description, labels and address. */
export interface PullRequestFacts {
  body: string;
  labels: string[];
  url: string | null;
}

/** The tracker the `blocked` output writes through, and the shape of its keys. */
export type ItemTracker = Parameters<typeof projectBlocked>[0] & {
  keys: Parameters<typeof projectBlocked>[1];
};

/** Where the label calls go: the repository's setting and its forge; by default the checkout's repository on the forge. */
export interface LabelSource {
  settings(): ReturnType<typeof defaultBranchLabels>;
  forge(slug: string): OwnForge;
  /** The tracker, when the repository names `issue_tracker.states.blocked`; `null` otherwise. */
  items?(): ItemTracker | null;
  /** The pull request's description, labels and address. */
  pullRequest?(slug: string, pr: number): Promise<Outcome<PullRequestFacts>>;
}

/** The checkout's tracker, opened only where `blocked` is named. */
function checkoutItems(): ItemTracker | null {
  const config = ownTrackerConfig();
  if (config.states.blocked === null) return null;
  const keys = issueKeysOf(config);
  if (keys === null) return null;
  return Object.assign(openTracker(config), { keys });
}

/** The pull request's description, labels and address, through the drive's own `gh` chokepoint. */
async function pullRequestFacts(
  slug: string,
  pr: number,
): Promise<Outcome<PullRequestFacts>> {
  const r = await forge([
    "pr",
    "view",
    String(pr),
    "--repo",
    slug,
    "--json",
    "body,labels,url",
  ]);
  if (!r.ok)
    return failed("unreadable", `the pull request did not read: ${r.why}`);
  const parsed = attempt("unreadable", "the pull request did not read", () =>
    JSON.parse(r.stdout),
  );
  if (!parsed.ok) return parsed;
  const v = parsed.value as { body?: unknown; labels?: unknown; url?: unknown };
  const labels = Array.isArray(v.labels)
    ? v.labels.map((l) => (l as { name?: unknown } | null)?.name)
    : null;
  if (
    labels === null ||
    !labels.every((n): n is string => typeof n === "string")
  )
    return failed("unreadable", "the pull request's labels did not read");
  return ok({
    body: typeof v.body === "string" ? v.body : "",
    labels,
    url: typeof v.url === "string" ? v.url : null,
  });
}

const FORGE_SOURCE: LabelSource = {
  settings: () => defaultBranchLabels(process.cwd()),
  forge: driveLabelForge,
  items: checkoutItems,
  pullRequest: pullRequestFacts,
};

/** The stop's own cause, for a stop no park framed. */
function stopCause(
  ledger: LedgerReading,
  moment: DriveMoment,
): { class: string; reason: string } {
  if (!("stopped" in moment) || moment.stopped === null)
    return { class: ledger.class, reason: "a person stopped the drive" };
  const name = driveExitName(moment.stopped);
  return {
    class: ledger.class,
    reason: moment.byPerson
      ? "a person stopped the drive"
      : `the drive stopped with exit ${moment.stopped}${name === null ? "" : ` (${name})`}`,
  };
}

/** The checkout's tracker, or `null` when there is nothing to move; a configuration that does not read is said and moves nothing. */
function openItems(pr: number, source: LabelSource): ItemTracker | null {
  try {
    return source.items?.() ?? null;
  } catch (error) {
    // The checkout's tracker configuration does not read: nothing to move, and the label stands.
    console.error(
      `labels: PR #${pr}'s items are left as they are: the tracker does not open (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}

/** The pull request as the tracker writer reads it, at this moment of its ledger. */
function blockedInput(
  pr: number,
  facts: PullRequestFacts,
  ledger: LedgerReading,
  moment: DriveMoment,
): BlockedPr {
  const stopped = "stopped" in moment ? moment : null;
  return {
    pr,
    url: facts.url,
    body: facts.body,
    labels: facts.labels,
    projected: ledgerState(ledger, DONE_EXITS),
    stop: stopped?.stop ?? "",
    causes: parkCauses(stopped?.parks ?? [], stopCause(ledger, moment)),
  };
}

/**
 * Move the items the pull request links as the projection says: to
 * `blocked` on a park, back out of it on the arm. Says what it did on
 * stderr; never throws.
 */
async function itemsFollow(
  pr: number,
  slug: string,
  config: LabelConfig,
  ledger: LedgerReading,
  moment: DriveMoment,
  source: LabelSource,
): Promise<void> {
  const items = openItems(pr, source);
  if (items === null || source.pullRequest === undefined) return;
  const facts = await source.pullRequest(slug, pr);
  if (!facts.ok) {
    console.error(
      `labels: PR #${pr}'s items are left as they are: ${facts.failure.reason}`,
    );
    return;
  }
  const input = blockedInput(pr, facts.value, ledger, moment);
  for (const o of await projectBlocked(items, items.keys, config, input)) {
    const line = blockedLine(pr, o);
    if (line !== null) console.error(`labels: ${line}`);
  }
}

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
      // Asked again after the label read: a successor can claim the drive during that request.
      beforeEdit: async () =>
        (await stillOurs())
          ? null
          : "its drive ledger no longer belongs to this driver",
    });
    const line = ownWriteLine(Number(pr), written);
    if (line !== null) console.error(`labels: ${line}`);
    if (settings.value.config.enabled && written.outcome !== "held")
      await itemsFollow(
        Number(pr),
        settings.value.slug,
        settings.value.config,
        ledger,
        moment,
        source,
      );
  } catch (error) {
    console.error(`labels: ${defectLine(`PR #${pr}`, error)}`);
  }
}
