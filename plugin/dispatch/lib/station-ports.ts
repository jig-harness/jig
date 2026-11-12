/**
 * The steps the tick takes on a person's answer to a need's decision
 * (`station-answers.ts`), each reading again, just before it acts, the
 * facts that make it safe, and refusing with why when one no longer holds:
 *
 * | Step | Checks first | Does |
 * | --- | --- | --- |
 * | run a follow-up again | the `followup` stage is on; no hold label; the earliest trusted marker is still the one the need names, this host's tick's, not marked done; no session holds the pull request | deletes that marker, so a later tick starts the follow-up again |
 * | record a follow-up done | the same | marks that marker done where it stands, as a follow-up run by hand leaves it |
 * | release a pickup's claim | the `pickup` stage is on; the tracker reads; no session holds the item; the line knows of no open pull request that carries it | moves the item to the first state a pickup starts from |
 * | detach a checkout | it is idle: clean, every commit on the remote, no drive or process in it (`shared/idle-holder.ts`) | detaches it at its commit, as an open does an idle holder |
 * | re-arm a drive | the `rearm` stage is on; the dispatch labels are on; no hold label | adds the rearm label, a person's command the tick then carries out |
 * | clear a launch record | it is still pending and its launch cannot be retried, and no process runs it | removes it, as `jig dispatch clear` does |
 */
import {
  CANONICAL_STATES,
  type CanonicalState,
  type Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { treeDrivers } from "../../skills/drive-pr/scripts/lib/state/tree-drivers.ts";
import { conversationOf } from "../../skills/drive-pr/scripts/lib/driver/park-answers.ts";
import { orcaCommandOrInstalled } from "../../shared/orca.ts";
import {
  BusyHolderError,
  releaseHiddenHolder,
} from "../../shared/orca-workspace/holder.ts";
import {
  boundedHook,
  type OpenPort,
  orcaAnswer,
} from "../../shared/orca-workspace/port.ts";
import { localContext, withLimit } from "../../shared/orca-workspace/runner.ts";
import { listComments } from "../../shared/records/forge-claims.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { stateRoot } from "../receipts.ts";
import { readMarkers } from "./followup-marker.ts";
import { pullRequestLabels } from "./forge.ts";
import { holding } from "./holding.ts";
import { commandLabel, hasCommand } from "./labels.ts";
import { holdsItem } from "./launch-pickups.ts";
import {
  inspectRow,
  readEnded,
  removeRecordIf,
  writeRecord,
} from "./launches.ts";
import { writeCommandLabel } from "./requests.ts";
import type { SessionsReport, Workspace } from "./runtime/port.ts";
import type { SharedContext } from "./shared-launches.ts";
import type { StationPorts } from "./station-answers.ts";
import { retryable } from "./stuck-launches.ts";
import { failureText } from "./text.ts";
import type { DispatchSection, RepoTarget } from "./types.ts";
import type { WorkLinks } from "./work-links.ts";

/** The longest one step's git checks run. */
const STEP_LIMIT_MS = 60_000;

const refused = (reason: string) => failed("refused", reason);

/** What the ports read and write through, for one repository's tick. */
export interface StationInputs {
  repo: RepoTarget;
  /** The stages the machine file switches on for the repository. */
  enabled: ReadonlySet<string>;
  section: DispatchSection;
  shared: SharedContext;
  login: string | null;
  tracker: Tracker | null;
  issueRepository: string | null;
  links: WorkLinks | null | undefined;
  sessions: () => Promise<SessionsReport>;
  root?: string;
}

/** Why a stage the step belongs to is off; `null` when it is on. */
function stageOff(inputs: StationInputs, stage: string): string | null {
  return inputs.enabled.has(stage)
    ? null
    : `the ${stage} stage is off for ${inputs.repo.slug} on this host`;
}

/** Why the pull request's labels stop the step: a person's hold label, or labels that do not read; `null` when nothing does. */
async function heldBy(
  inputs: StationInputs,
  pr: number,
): Promise<string | null> {
  const labels = inputs.section.labels;
  if (!labels.enabled) return null;
  const read = await pullRequestLabels(inputs.repo.slug, pr);
  if (!read.ok)
    return `the labels of PR #${pr} do not read: ${read.failure.reason}`;
  return hasCommand(labels, read.value, "hold")
    ? `a person's hold label is on PR #${pr}`
    : null;
}

/** Why a session holding the work stops the step; `null` when none does. */
async function sessionHolds(
  inputs: StationInputs,
  joined: (w: Workspace) => boolean,
  what: string,
): Promise<string | null> {
  const held = holding(await inputs.sessions(), joined);
  if (held.kind === "free") return null;
  return held.kind === "unknown"
    ? `whether a session holds ${what} cannot be told: ${held.reason}`
    : `a session holds ${what}`;
}

/** Why the follow-up's marker no longer stands as the need read it; `null` when it does. */
async function markerMoved(
  inputs: StationInputs,
  pr: number,
  marker: number,
): Promise<string | null> {
  const markers = await readMarkers(
    inputs.shared.records,
    inputs.repo.slug,
    pr,
  );
  if (!Array.isArray(markers))
    return `the follow-up markers of PR #${pr} do not read: ${markers.unreadable}`;
  const [first] = markers.filter((m) => m.trusted).sort((a, b) => a.id - b.id);
  if (first?.id !== marker)
    return `marker comment ${marker} no longer claims the follow-up of PR #${pr}`;
  if (first.run.kind !== "tick")
    return `marker comment ${marker} is not the tick's`;
  if (first.run.host !== undefined && first.run.host !== inputs.shared.host)
    return `marker comment ${marker} is host ${first.run.host}'s, which settles its own follow-up`;
  return first.run.outcome === "done"
    ? `marker comment ${marker} is marked done`
    : null;
}

/** Every check a follow-up step makes before it touches the marker. */
async function followupFault(
  inputs: StationInputs,
  pr: number,
  marker: number,
): Promise<string | null> {
  return (
    stageOff(inputs, "followup") ??
    (await heldBy(inputs, pr)) ??
    (await markerMoved(inputs, pr, marker)) ??
    (await sessionHolds(inputs, (w) => w.prs.includes(pr), `PR #${pr}`))
  );
}

async function release(
  inputs: StationInputs,
  pr: number,
  marker: number,
): Promise<Outcome<void, "refused">> {
  const released = await inputs.shared.records.release(
    { repo: inputs.repo.slug, pr },
    marker,
  );
  return released.ok
    ? ok(undefined)
    : refused(
        `marker comment ${marker} could not be deleted: ${released.failure.reason}`,
      );
}

/** The marker deleted once every check a follow-up step makes holds, or why it was not. */
async function checkedRelease(
  inputs: StationInputs,
  pr: number,
  marker: number,
): Promise<Outcome<void, "refused">> {
  const fault = await followupFault(inputs, pr, marker);
  return fault === null ? release(inputs, pr, marker) : refused(fault);
}

async function rerunFollowup(
  inputs: StationInputs,
  pr: number,
  marker: number,
): Promise<Outcome<string, "refused">> {
  const released = await checkedRelease(inputs, pr, marker);
  return released.ok
    ? ok(
        `deleted marker comment ${marker}; a later tick starts the follow-up of PR #${pr} again`,
      )
    : released;
}

async function doneFollowup(
  inputs: StationInputs,
  pr: number,
  marker: number,
): Promise<Outcome<string, "refused">> {
  const fault = await followupFault(inputs, pr, marker);
  if (fault !== null) return refused(fault);
  // The marker is marked done where it stands, so it blocks a new run throughout and is never missing between steps.
  const ended = await inputs.shared.records.end(
    { repo: inputs.repo.slug, pr },
    "followup",
    marker,
    {
      state: "ended",
      at: new Date().toISOString(),
      exit: null,
      outcome: "done",
    },
  );
  return ended.ok
    ? ok(`marked marker comment ${marker} of PR #${pr} done`)
    : refused(
        `marker comment ${marker} could not be marked done and stands as it was: ${ended.failure.reason}`,
      );
}

/** The state a pickup starts from, as the tracker names it; `null` when the section names none the tracker knows. */
function startState(section: DispatchSection): CanonicalState | null {
  const first = section.states[0];
  return (CANONICAL_STATES as readonly string[]).includes(first ?? "")
    ? (first as CanonicalState)
    : null;
}

/** Mark the ended pickup record `id` released, so the item is launched again; why it could not be, or `null`. */
function releaseRecord(
  inputs: StationInputs,
  item: string,
  id: string,
): string | null {
  const root = inputs.root ?? stateRoot();
  const ended = readEnded(id, root);
  if (ended === null) return `launch record ${id} is not an ended record`;
  const { record } = ended;
  if (record.action !== "pickup" || record.repo !== inputs.repo.slug)
    return `launch record ${id} is not a pickup of ${inputs.repo.slug}`;
  const members: string[] = record.batchItems?.map((i) => i.key) ?? [
    record.item ?? "",
  ];
  if (!members.includes(item))
    return `launch record ${id} is not a pickup of ${item}`;
  if (!holdsItem(record, item)) return null;
  // Only the member answered is released; its siblings keep the question they wait on.
  const released = [...(record.releasedItems ?? []), item];
  record.releasedItems = released;
  if (members.every((m) => released.includes(m))) record.released = true;
  writeRecord(record, root);
  return null;
}

/** Why an open pull request stops a release of `item`, or that none can be told; `null` when none carries it. */
function carryFault(inputs: StationInputs, item: string): string | null {
  const carried = inputs.links?.prsOf(item) ?? null;
  if (carried === null)
    return `whether an open pull request carries ${item} cannot be told this tick`;
  return carried.length > 0
    ? `open pull request ${carried.map((p) => `#${p.number}`).join(", ")} carries ${item}`
    : null;
}

/** Move `item` to `state`; why the tracker did not, or `null`. */
async function moveTo(
  tracker: Tracker,
  item: string,
  state: CanonicalState,
): Promise<string | null> {
  try {
    await tracker.transition(item, state, AbortSignal.timeout(60_000));
    return null;
  } catch (error) {
    return `the tracker did not move ${item} to ${state}: ${failureText(error)}`;
  }
}

async function releasePickup(
  inputs: StationInputs,
  item: string,
  recordId: string | null,
): Promise<Outcome<string, "refused">> {
  const off = stageOff(inputs, "pickup");
  if (off !== null) return refused(off);
  const { tracker } = inputs;
  if (tracker === null) return refused("the tracker did not open this tick");
  const state = startState(inputs.section);
  if (state === null)
    return refused(
      "the repository's dispatch section names no state a pickup starts from",
    );
  let current: Awaited<ReturnType<Tracker["getIssue"]>>;
  try {
    current = await tracker.getIssue(item);
  } catch (error) {
    return refused(`${item} did not read: ${failureText(error)}`);
  }
  if (current === null) return refused(`${item} is gone from the tracker`);
  if (["completed", "canceled", "duplicate"].includes(current.state.type))
    return refused(
      `${item} is now ${current.state.name}, not a claim to release`,
    );
  const carriedBy = carryFault(inputs, item);
  if (carriedBy !== null) return refused(carriedBy);
  const held = await sessionHolds(inputs, (w) => w.items.includes(item), item);
  if (held !== null) return refused(held);
  const unclaimed = ["backlog", "unstarted", "triage"].includes(
    current.state.type,
  );
  const stuck = unclaimed ? null : await moveTo(tracker, item, state);
  if (stuck !== null) return refused(stuck);
  const unreleased =
    recordId === null ? null : releaseRecord(inputs, item, recordId);
  if (unreleased !== null) return refused(`${item} is free, but ${unreleased}`);
  return ok(
    unclaimed
      ? `${item} was not claimed; released its ended launch record, so a later tick picks it up afresh`
      : `moved ${item} to ${state}; a later tick picks it up afresh`,
  );
}

function detachCheckout(
  inputs: StationInputs,
  branch: string,
  path: string,
  stage: string | null,
): Promise<Outcome<string, "refused">> {
  const off = stage === null ? null : stageOff(inputs, stage);
  if (off !== null) return Promise.resolve(refused(off));
  const host = withLimit(
    // The detach's own line goes to the step's outcome, not the tick's log.
    localContext(() => undefined),
    STEP_LIMIT_MS,
  );
  const orca = orcaCommandOrInstalled(process.env);
  const port: OpenPort = {
    host,
    runHook: boundedHook,
    orcaCall: <T>(args: string[], what: string) =>
      orcaAnswer<T>(host.run([orca, ...args, "--json"]), what),
    where: "",
    drivers: treeDrivers,
  };
  try {
    releaseHiddenHolder(port, inputs.repo.path, branch, path, inputs.repo.slug);
  } catch (error) {
    return Promise.resolve(
      refused(
        error instanceof BusyHolderError
          ? `the checkout at ${path} is still in use: ${error.reasons.join("; ")}`
          : failureText(error),
      ),
    );
  }
  return Promise.resolve(ok(`detached the checkout at ${path} from ${branch}`));
}

async function rearmDrive(
  inputs: StationInputs,
  pr: number,
): Promise<Outcome<string, "refused">> {
  const off = stageOff(inputs, "rearm");
  if (off !== null) return refused(off);
  const labels = inputs.section.labels;
  if (!labels.enabled)
    return refused(
      `${inputs.repo.slug} has its dispatch labels off, so the rearm label cannot carry the re-arm; re-arm the drive by hand`,
    );
  const held = await heldBy(inputs, pr);
  if (held !== null) return refused(held);
  const label = commandLabel(labels, "rearm");
  const written = await writeCommandLabel(inputs.repo.slug, pr, label, true);
  return written.ok
    ? ok(`added ${label} to PR #${pr}; the next tick re-arms its drive`)
    : refused(written.failure.reason);
}

async function clearRecord(
  inputs: StationInputs,
  id: string,
): Promise<Outcome<string, "refused">> {
  const root = inputs.root ?? stateRoot();
  const row = await inspectRow(id, root);
  if (row === null) return refused(`launch record ${id} is gone`);
  if (row.state.kind !== "pending" || row.record === null)
    return refused(`launch record ${id} is ${row.state.kind}, not stuck`);
  const { action } = row.record;
  // A re-arm or a takeover record is the rearm stage's.
  const stage =
    action === "rearm" || action === "takeover"
      ? "rearm"
      : action === "pickup" || action === "followup"
        ? action
        : null;
  const off = stage === null ? null : stageOff(inputs, stage);
  if (off !== null) return refused(off);
  if (retryable(row.record))
    return refused(`launch record ${id}'s launch can still be retried`);
  return removeRecordIf(id, row, root)
    ? ok(`cleared launch record ${id}`)
    : refused(`launch record ${id} changed while it was read`);
}

/** The ports of one repository's tick. */
export function stationPorts(inputs: StationInputs): StationPorts {
  return {
    self: inputs.login,
    issueRepository: inputs.issueRepository,
    async comments(repo, number) {
      const listed = await listComments({ repo, number }, { timeoutSec: 60 });
      return listed.ok ? ok(conversationOf(listed.value)) : listed;
    },
    rerunFollowup: (pr, marker) => rerunFollowup(inputs, pr, marker),
    doneFollowup: (pr, marker) => doneFollowup(inputs, pr, marker),
    releasePickup: (item, record = null) => releasePickup(inputs, item, record),
    detachCheckout: (_target, branch, path, stage = null) =>
      detachCheckout(inputs, branch, path, stage),
    rearmDrive: (pr) => rearmDrive(inputs, pr),
    clearRecord: (record) => clearRecord(inputs, record),
  };
}
