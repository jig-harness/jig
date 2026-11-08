/**
 * The projection: after the plan, each pull request the dispatcher manages
 * gets the state label its ledger maps to (`labels.ts`), and the receipt
 * says what was written. A pull request is managed when it was read for a
 * ledger and carries one, or carries a label of the set; a merged one when
 * it carries a label of the set, and only its follow-up's end moves it
 * (`followed-up`). An open pull request a serialized change area holds
 * behind another (`contention.ts`) carries `held` whatever its ledger
 * says, and one whose place there cannot be told this tick keeps the
 * labels it has. Only a pull request whose labels disagree is written,
 * in one `gh` call; one that agrees costs nothing.
 *
 * Writes happen only with `--apply`, for a repository the machine file
 * lists; otherwise the receipt says what would be written. A write the
 * forge refuses (a label that does not exist, no permission) is a record of
 * the receipt, not a failed tick, and a later tick tries again: the failure
 * ledger (`failures.ts`) counts the failures in a row and backs the write
 * off, reported as waiting, until its next try.
 */
import type { Contention } from "../contention.ts";
import type { ActionBook } from "../failures.ts";
import { editLabels } from "../forge.ts";
import {
  carriesSet,
  hasCommand,
  type LabelChange,
  type LabelConfig,
  labelChange,
  type Projected,
  stateOf,
} from "../labels.ts";
import { failureText } from "../text.ts";
import type {
  DrivenPr,
  LabelCommand,
  LabelReport,
  LabelWrite,
  MergedPr,
} from "../types.ts";

export interface ProjectionInput {
  config: LabelConfig;
  /** The open pull requests, with their labels. */
  open: ReadonlyArray<{ number: number; labels?: string[] }>;
  /** The open pull requests read for a ledger this tick. */
  read: ReadonlySet<number>;
  drives: readonly DrivenPr[];
  merged: readonly MergedPr[];
  /** The merged pull requests whose follow-up is done. */
  followedUp: ReadonlySet<number>;
  /** The pull requests serialization holds, or cannot place, this tick. */
  serialized?: Pick<Contention, "held" | "unplaced">;
}

/** The ledger classes whose ledger reads: the `drive` command on them has been carried out. */
const READABLE = (d: DrivenPr | undefined): boolean =>
  d !== undefined && d.class !== "unarmed" && d.class !== "unplaced";

function driveNote(drive: DrivenPr | undefined): string {
  if (drive === undefined || drive.class === "unarmed")
    return "no drive ledger: a drive is armed once at this head, and the label is replaced by the state label once its ledger exists";
  if (drive.class === "unplaced")
    return `its drive ledger cannot be read this tick (${drive.why}), so the label is left as it is`;
  return `it has a drive ledger (${drive.class}): nothing is armed for the label, which is replaced by the state label`;
}

const HOLD_NOTE =
  "a person's hold: no stage runs on it while the label is there, and the tick never removes it";

/** The command labels one pull request carries, as the receipt reports them. */
function commandsOf(
  config: LabelConfig,
  number: number,
  labels: readonly string[],
  drive: DrivenPr | undefined,
  open: boolean,
): LabelCommand[] {
  const target = `PR #${number}`;
  const out: LabelCommand[] = [];
  if (hasCommand(config, labels, "drive"))
    out.push({
      target,
      command: "drive",
      note: open
        ? driveNote(drive)
        : "merged: the label does nothing here, and is left as it is",
    });
  if (hasCommand(config, labels, "rearm"))
    out.push({
      target,
      command: "rearm",
      note: "a person's request to re-arm a stopped drive in its existing tree; consumed after its launch is accepted",
    });
  if (hasCommand(config, labels, "hold"))
    out.push({ target, command: "hold", note: HOLD_NOTE });
  return out;
}

/** The pull requests a person's `hold` label is on, open or merged; none where the labels are off. */
export function heldPullRequests(
  config: LabelConfig | null,
  prs: ReadonlyArray<{ number: number; labels?: string[] }>,
): Set<number> {
  if (config === null) return new Set();
  return new Set(
    prs
      .filter((p) => hasCommand(config, p.labels, "hold"))
      .map((p) => p.number),
  );
}

/** The changes the projection wants, and the receipt's labels part before any write. */
export function planLabels(input: ProjectionInput): {
  report: LabelReport;
  changes: LabelChange[];
} {
  const { config } = input;
  const drives = new Map(input.drives.map((d) => [d.number, d]));
  const report: LabelReport = {
    prefix: config.prefix,
    onlyLabeled: config.onlyLabeled,
    unlabeled: input.open.filter((p) => !input.read.has(p.number)).length,
    states: [],
    commands: [],
    held: [],
    writes: [],
  };
  const changes: LabelChange[] = [];
  const project = (
    number: number,
    labels: readonly string[],
    projected: Projected,
    consumeDrive: boolean,
  ) => {
    report.states.push({
      target: `PR #${number}`,
      state: projected === "unknown" ? "unknown" : projected.state,
    });
    const change = labelChange(config, number, labels, projected, consumeDrive);
    if (change !== null) changes.push(change);
  };
  // Merged between the two listings: the merged state wins, as the plan has it.
  const mergedNumbers = new Set(input.merged.map((m) => m.number));
  for (const pr of input.open) {
    if (!input.read.has(pr.number)) continue;
    if (mergedNumbers.has(pr.number)) continue;
    const labels = pr.labels ?? [];
    const drive = drives.get(pr.number);
    report.commands.push(...commandsOf(config, pr.number, labels, drive, true));
    if (drive === undefined && !carriesSet(config, labels)) continue;
    project(
      pr.number,
      labels,
      serialState(input, pr.number, drive),
      READABLE(drive),
    );
  }
  for (const pr of input.merged) {
    const labels = pr.labels ?? [];
    if (!carriesSet(config, labels)) continue;
    report.commands.push(
      ...commandsOf(config, pr.number, labels, undefined, false),
    );
    const done = input.followedUp.has(pr.number);
    project(
      pr.number,
      labels,
      done ? { state: "followed-up" } : "unknown",
      false,
    );
  }
  return { report, changes };
}

/** An open pull request's state: `held` while serialization holds it, its ledger's otherwise; left as it is while its place cannot be told. */
function serialState(
  input: ProjectionInput,
  pr: number,
  drive: DrivenPr | undefined,
): Projected {
  if (input.serialized?.unplaced.has(pr) === true) return "unknown";
  if (input.serialized?.held.has(pr) === true) return { state: "held" };
  return stateOf(drive);
}

/** How the projection may write this tick. */
export interface WriteMode {
  /** `--apply`, for a repository the machine file lists. */
  apply: boolean;
  /** Why the tick's time is spent; `null` while it is not. */
  late: () => string | null;
  /** The failure ledger: a write that keeps failing backs off, and each write's result is counted. */
  book?: ActionBook | null;
}

/** The failure ledger's key of a pull request's label write. */
export const labelKey = (pr: number): string => `label PR #${pr}`;

const describe = (c: LabelChange): string =>
  [...c.add.map((l) => `+${l}`), ...c.remove.map((l) => `-${l}`)].join(" ");

/** Write each change in one call, in pull request order; each outcome goes into the receipt. */
export async function writeLabels(
  slug: string,
  changes: readonly LabelChange[],
  mode: WriteMode,
  edit = editLabels,
): Promise<LabelWrite[]> {
  const out: LabelWrite[] = [];
  for (const change of [...changes].sort((a, b) => a.pr - b.pr)) {
    const base = {
      target: `PR #${change.pr}`,
      add: change.add,
      remove: change.remove,
    };
    if (!mode.apply) {
      out.push({ ...base, outcome: "would", detail: describe(change) });
      continue;
    }
    const late = mode.late();
    if (late !== null) {
      out.push({ ...base, outcome: "waits", detail: late });
      continue;
    }
    const key = labelKey(change.pr);
    const backing = mode.book?.waits(key) ?? null;
    if (backing !== null) {
      out.push({ ...base, outcome: "waits", detail: backing });
      continue;
    }
    const of = { key, kind: "label" as const, target: base.target };
    try {
      await edit(slug, change.pr, change.add, change.remove);
      out.push({ ...base, outcome: "written", detail: describe(change) });
      mode.book?.ran(of, null);
    } catch (error) {
      const why = failureText(error);
      out.push({
        ...base,
        outcome: "failed",
        detail: `${describe(change)} was refused, and a later tick tries again: ${why}`,
      });
      mode.book?.ran(of, `${describe(change)} was refused: ${why}`);
    }
  }
  return out;
}
