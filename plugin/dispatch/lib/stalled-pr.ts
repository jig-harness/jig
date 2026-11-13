/**
 * A stalled pickup whose work is finished: the pickup opened a pull request,
 * then ended before it moved its item to `pr_open`. The tick tells it from
 * abandoned work by its own records alone:
 *
 * - the branch: the one the runtime reports checked out in the workspace a
 *   launch record of this host for the item names (a pickup's own record,
 *   or a batch's that holds the item);
 * - the pull request: an open one whose head is that branch and whose
 *   description links the item as `do-item` links it, a `Closes <KEY>` or
 *   `Refs <KEY>` line (`bodyLinker`, qualified where a GitHub tracker's
 *   issues live in another repository).
 *
 * The open pull requests are the ones the tick's query of the repository
 * already read (`forge-batch.ts`), so the rule makes no forge request of its
 * own. Where they did not read, nothing moves and the stall need says so.
 *
 * Found, an item in its in-progress state moves to `pr_open`, never to done,
 * on the host that owns the repository (`actions/pr-open-moves.ts`); one
 * already in `pr_open` is quiet while that pull request is open. Where the
 * repository names no `pr_open` state, or this host does not own the
 * repository, nothing moves and the stall need names the pull request. A
 * pull request no launch of this host opened is not this rule's case: the
 * steward's `settle` record links it.
 */
import type { ReadRecord } from "./launches.ts";
import type { SessionsReport } from "./runtime/port.ts";
import type { ClaimedItem, PrOpenMove } from "./types.ts";
import type { PrLinkText } from "./work-links.ts";

/** What the rule reads beside the plan's own input. */
export interface StalledPrInput {
  /** The open pull requests as the tick's query of the repository read them; `null` when they did not read. */
  prs: readonly PrLinkText[] | null;
  /** The tracker's name for `pr_open`; `null` where the repository names none. */
  prOpen: string | null;
  /** Whether this host owns the repository: only the owner writes to the tracker. */
  owner: boolean;
  /** Whether a pull request's description links the item, as `do-item` links it. */
  links: (body: string, key: string) => boolean;
}

/** An open pull request from a launch's branch that links the item. */
export interface LaunchPr {
  number: number;
  url: string;
  branch: string;
  /** The launch record whose workspace has the branch checked out. */
  record: string;
}

/** What the open pull requests say of a claimed item's launches. */
export type LaunchPrRead =
  | { kind: "none" }
  | { kind: "unread"; why: string }
  | { kind: "open"; pr: LaunchPr };

/** What an open launch pull request makes of a claimed item. */
export type LaunchPrStep =
  | { kind: "move"; move: PrOpenMove }
  | { kind: "quiet"; why: string }
  | { kind: "stall"; note: string };

/** Each branch a pickup launch of this host for `key` worked on, with its record, as the runtime reports the record's workspace. */
function launchBranches(
  key: string,
  launches: readonly ReadRecord[],
  sessions: SessionsReport,
): Array<{ branch: string; record: string }> {
  if (!sessions.ok) return [];
  const branchAt = (path: string) =>
    sessions.workspaces.find((w) => w.path === path)?.branch ?? "";
  return launches
    .filter(({ record }) => pickupOf(record, key))
    .map(({ record }) => ({
      branch: record.workspace === null ? "" : branchAt(record.workspace.path),
      record: record.id,
    }))
    .filter((b) => b.branch !== "");
}

/** Whether a launch record is a pickup of `key`, alone or in a batch. */
function pickupOf(record: ReadRecord["record"], key: string): boolean {
  if (record.action !== "pickup") return false;
  return (
    record.item === key || (record.batchItems ?? []).some((i) => i.key === key)
  );
}

/** The open pull request a launch of this host for `key` opened and that links it, if any. */
function launchPrOf(
  key: string,
  launches: readonly ReadRecord[],
  sessions: SessionsReport,
  input: StalledPrInput | undefined,
): LaunchPrRead {
  if (input === undefined) return { kind: "none" };
  const branches = launchBranches(key, launches, sessions);
  if (branches.length === 0) return { kind: "none" };
  if (input.prs === null)
    return {
      kind: "unread",
      why: `whether its launch's branch ${branches[0]?.branch} has an open pull request cannot be told: the open pull requests' descriptions did not read this tick`,
    };
  const found = [...input.prs]
    .sort((a, b) => a.number - b.number)
    .flatMap((pr) => {
      const launch = branches.find((b) => b.branch === pr.headRefName);
      return launch !== undefined && input.links(pr.body, key)
        ? [{ number: pr.number, url: pr.url, ...launch }]
        : [];
    });
  const [pr] = found;
  return pr === undefined ? { kind: "none" } : { kind: "open", pr };
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function prText(pr: LaunchPr): string {
  return `pull request #${pr.number} (${pr.url}), open from ${pr.branch}, the branch of its launch record ${pr.record}, links it`;
}

/** What the open pull request a launch opened makes of a claimed item with no running session. */
function launchPrStep(
  item: ClaimedItem,
  pr: LaunchPr,
  input: StalledPrInput,
): LaunchPrStep {
  const { prOpen } = input;
  if (prOpen === null)
    return {
      kind: "stall",
      note: `${prText(pr)}; the repository names no pr_open state, so nothing moved`,
    };
  if (sameName(item.state, prOpen))
    return {
      kind: "quiet",
      why: `in ${item.state} with no running session: ${prText(pr)}, so it is not a stalled pickup while that pull request is open`,
    };
  if (!input.owner)
    return {
      kind: "stall",
      note: `${prText(pr)}; only the host that owns the repository moves an item to pr_open, and this host does not own it`,
    };
  return {
    kind: "move",
    move: {
      target: item.key,
      pr: pr.number,
      url: pr.url,
      branch: pr.branch,
      record: pr.record,
      from: item.state,
      to: prOpen,
    },
  };
}

/** What the open pull requests say of a claimed item, and what that makes of it; `step` is `null` when no launch pull request is open. */
export interface LaunchPrReading {
  read: LaunchPrRead;
  step: LaunchPrStep | null;
}

/** Read a claimed item's launch pull request, and what it makes of the item. */
export function readLaunchPr(
  item: ClaimedItem,
  launches: readonly ReadRecord[],
  sessions: SessionsReport,
  input: StalledPrInput | undefined,
): LaunchPrReading {
  const read = launchPrOf(item.key, launches, sessions, input);
  return {
    read,
    step:
      read.kind === "open" && input !== undefined
        ? launchPrStep(item, read.pr, input)
        : null,
  };
}

/** What a stall need adds for its item's launch pull request: why it did not move, or that it could not be told. */
export function stallNote({ read, step }: LaunchPrReading): string | null {
  if (read.kind === "unread") return read.why;
  return step?.kind === "stall" ? step.note : null;
}
