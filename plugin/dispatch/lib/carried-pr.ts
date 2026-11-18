/**
 * A claimed item an open pull request carries: no session holds the item,
 * because its pickup ended once it opened the pull request, and a drive
 * works that pull request or has converged and waits for a person's merge.
 * The stall watch reads such an item as carried, not as a stalled pickup,
 * whether or not the repository names a `pr_open` state (`stalled-pr.ts`).
 *
 * - A pull request carries the item when the line links it to the item, as
 *   the need's framed decision reads it (`work-links.ts`: its branch names
 *   the item's key, its description closes the item, or the forge says it
 *   closes it), and its head is in the repository itself: one from a fork,
 *   or whose head repository did not read, carries nothing.
 * - Its drive carries the item while the drive's state is `driving` or
 *   `converged`, the state the pull request's dispatch label shows
 *   (`labels.ts`). A pull request with no drive, or one whose drive stopped
 *   for a person, does not: the item is a stalled pickup, and its need names
 *   the pull request.
 * - Where the open pull requests, their links or a linked pull request's
 *   drive did not read this tick, the stall watch reads the item as it reads
 *   one no pull request links, and its need says what could not be told.
 *
 * Like the rest of the stall watch it reads only what the tick's query of
 * the repository already read, and makes no forge request of its own.
 */
import { stateOf } from "./labels.ts";
import type { DrivenPr } from "./types.ts";
import { type LinkRules, type PrLinkText, workLinks } from "./work-links.ts";

/** An open pull request, by number and link. */
export interface CarrierPr {
  number: number;
  url: string;
}

/** What the stall watch reads to tell whether an open pull request carries a claimed item. */
export interface CarrierInput {
  /** The open pull requests of the repository's own branches the line links to `key`; `null` when the tick could not tell. */
  carriers(key: string): CarrierPr[] | null;
  /** The drive of one open pull request, as this tick read it. */
  drive(pr: number): CarrierDrive;
}

/** One open pull request's drive, as the stall watch reads it. */
export type CarrierDrive =
  | { kind: "driving" }
  | { kind: "converged" }
  | { kind: "none"; why: string }
  | { kind: "stopped"; why: string }
  | { kind: "unread"; why: string };

/** The drive states that carry an item. */
export type CarryingDrive = "driving" | "converged";

/** What the open pull requests make of a claimed item with no running session. */
export type Carriage =
  /** No open pull request links it, or the carriers were not read: the stall watch reads the item by its other rules. */
  | { kind: "none" }
  | { kind: "carried"; pr: CarrierPr; drive: CarryingDrive; why: string }
  /** A pull request links it, but no drive carries it, or what carries it could not be told: the stall need says which. */
  | { kind: "stall"; note: string };

/** The drive of a pull request among `drives`, the ones `read` holds the ledgers of, `inScope` those `only_labeled` keeps. */
function carrierDrive(
  pr: number,
  drives: readonly DrivenPr[],
  read: ReadonlySet<number>,
  inScope: ReadonlySet<number> | undefined,
): CarrierDrive {
  const drive = drives.find((d) => d.number === pr);
  if (drive === undefined) {
    if (read.has(pr)) return { kind: "none", why: "it has no drive" };
    return {
      kind: "unread",
      why:
        inScope !== undefined && !inScope.has(pr)
          ? "it carries no dispatch label, so its drive is not read (dispatch.labels.only_labeled)"
          : "its drive was not read this tick",
    };
  }
  const projected = stateOf(drive);
  if (projected === "unknown")
    return {
      kind: "unread",
      why: `its drive's state could not be told (${drive.class}${drive.why === "" ? "" : `: ${drive.why}`})`,
    };
  if (projected.state === "driving" || projected.state === "converged")
    return { kind: projected.state };
  if (projected.state === null) return { kind: "none", why: "it has no drive" };
  return {
    kind: "stopped",
    why: `its drive stopped (${drive.class}${drive.why === "" ? "" : `: ${drive.why}`})`,
  };
}

/**
 * What the stall watch reads from the tick's reads: the open pull requests
 * (`null` when they did not read), how the repository's keys link them,
 * the drives the tick read and the pull requests whose ledgers it read.
 * A pull request from a fork, or whose head repository did not read, is
 * left out before the links are made.
 */
export function carrierInput(read: {
  prs: readonly PrLinkText[] | null;
  rules: LinkRules | null;
  drives: readonly DrivenPr[];
  read: ReadonlySet<number>;
  /** Under `only_labeled`, the pull requests in scope: one outside it has no drive the tick reads. */
  inScope?: ReadonlySet<number>;
}): CarrierInput {
  const own = read.prs?.filter((p) => p.crossRepository === false) ?? null;
  const links =
    own === null || read.rules === null ? null : workLinks(own, read.rules);
  return {
    carriers: (key) => links?.prsOf(key) ?? null,
    drive: (pr) => carrierDrive(pr, read.drives, read.read, read.inScope),
  };
}

function prName(pr: CarrierPr): string {
  return `pull request #${pr.number} (${pr.url})`;
}

function carriedWhy(
  state: string,
  pr: CarrierPr,
  drive: CarryingDrive,
): string {
  const how =
    drive === "driving"
      ? "its drive is live"
      : "its drive converged and it waits for its merge";
  return `in ${state} with no running session: carried by ${prName(pr)}, which links it; ${how}`;
}

/** What the open pull requests that link a claimed item make of it; `none` without the input. */
export function readCarriage(
  item: { key: string; state: string },
  input: CarrierInput | undefined,
): Carriage {
  if (input === undefined) return { kind: "none" };
  const prs = input.carriers(item.key);
  if (prs === null)
    return {
      kind: "stall",
      note: "whether an open pull request carries it cannot be told: the open pull requests' links did not read this tick",
    };
  if (prs.length === 0) return { kind: "none" };
  const read = [...prs]
    .sort((a, b) => a.number - b.number)
    .map((pr) => ({ pr, drive: input.drive(pr.number) }));
  const told: string[] = [];
  let unread = false;
  for (const { pr, drive } of read) {
    if (drive.kind === "driving" || drive.kind === "converged")
      return {
        kind: "carried",
        pr,
        drive: drive.kind,
        why: carriedWhy(item.state, pr, drive.kind),
      };
    told.push(`${prName(pr)} links it, but ${drive.why}`);
    unread ||= drive.kind === "unread";
  }
  return {
    kind: "stall",
    note: `${told.join("; ")}${unread ? ", so whether a drive carries it cannot be told" : ""}`,
  };
}
