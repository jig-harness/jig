/**
 * A claimed item an open pull request carries: no session holds the item,
 * because its pickup ended once it opened the pull request, and the pull
 * request's drive holds the work, whatever state it is in. The stall watch
 * reads such an item as carried, not as a stalled pickup, whether or not
 * the repository names a `pr_open` state (`stalled-pr.ts`).
 *
 * - A pull request carries the item when the line links it to the item, as
 *   the need's framed decision reads it (`work-links.ts`: its branch names
 *   the item's key, its description closes the item, or the forge says it
 *   closes it), and its head is in the repository itself: one from a fork
 *   carries nothing, and one whose head repository did not read cannot be
 *   told from a fork, so the stall need says so.
 * - Its drive carries the item in every state it has: live, converged and
 *   waiting for its merge, parked on a person's question, stopped and
 *   waiting for a re-arm or a re-drive, or unplaced for this tick while the
 *   forge leaves its state undecided (a mergeability still being computed),
 *   or `unarmed`: no ledger yet, but something asks for one (a person's
 *   `drive` label, the completed pickup's first-drive handoff, the adoption
 *   rule), so the tick is about to arm it. A drive that stays unarmed is
 *   reported by whatever keeps it from arming, not as a stalled pickup.
 *   Whatever a person must do there is the pull request's own need, so the
 *   item raises no second one and is reported with the drive's state beside
 *   it. A pull request with no drive does not carry it: the item is a
 *   stalled pickup, and its need names the pull request.
 * - A pull request the tick read as merged within `MERGED_SETTLES_MS` that
 *   the line links to the item, by its branch or its description, settles
 *   it: the follow-up moves it, so the stall watch raises nothing. A link
 *   that rests on the forge's closing references (an issue in a separate
 *   repository) is unknown for a merged pull request, whose listing does
 *   not carry them, so it settles nothing. One merged longer ago no longer
 *   does: an item its follow-up has not moved by then is a stalled pickup
 *   again.
 * - Where the open pull requests, their links or a linked pull request's
 *   drive did not read this tick, the stall watch reads the item as it reads
 *   one no pull request links, and its need says what could not be told.
 *
 * Like the rest of the stall watch it reads only what the tick's query of
 * the repository already read, and makes no forge request of its own.
 */
import { parseMs } from "../../shared/time.ts";
import { stateOf } from "./labels.ts";
import type { DrivenPr, MergedPr } from "./types.ts";
import { type LinkRules, type PrLinkText, workLinks } from "./work-links.ts";

/** An open pull request, by number and link. */
export interface CarrierPr {
  number: number;
  url: string;
  /** Set where the pull request's head repository did not read: it cannot carry the item, and the stall need says why. */
  headUnread?: true;
}

/** What the stall watch reads to tell whether an open pull request carries a claimed item. */
export interface CarrierInput {
  /** The open pull requests of the repository's own branches the line links to `key`; `null` when the tick could not tell. */
  carriers(key: string): CarrierPr[] | null;
  /** The drive of one open pull request, as this tick read it. */
  drive(pr: number): CarrierDrive;
  /** The pull requests merged since the follow-up stage's start that the line links to `key`; empty where none read. */
  merged?(key: string): CarrierPr[];
}

/** One open pull request's drive, as the stall watch reads it. */
export type CarrierDrive =
  | { kind: "driving" }
  | { kind: "converged" }
  | { kind: "parked"; why: string }
  | { kind: "stopped"; why: string }
  | { kind: "unplaced"; why: string }
  | { kind: "unarmed"; why: string }
  | { kind: "none"; why: string }
  | { kind: "unread"; why: string };

/** The drive states that carry an item: every state a drive the tick read can be in. */
export type CarryingDrive =
  | "driving"
  | "converged"
  | "parked"
  | "stopped"
  | "unplaced"
  | "unarmed";

/** How long after its merge a pull request that links an item settles it for the stall watch: its follow-up's time, waits included. */
const MERGED_SETTLES_MS = 24 * 3_600_000;

/** The ledger classes of a drive parked on a person's question, which its own need frames. */
const ASKS_PERSON: ReadonlySet<DrivenPr["class"]> = new Set([
  "parked",
  "needs-person",
]);

/** What the open pull requests make of a claimed item with no running session. */
export type Carriage =
  /** No open pull request links it, or the carriers were not read: the stall watch reads the item by its other rules. */
  | { kind: "none" }
  | { kind: "carried"; pr: CarrierPr; drive: CarryingDrive; why: string }
  /** A pull request linking it merged: the follow-up settles it. */
  | { kind: "merged"; pr: CarrierPr; why: string }
  /** A pull request links it, but no drive carries it, or what carries it could not be told: the stall need says which. */
  | { kind: "stall"; note: string };

/** A pull request with no drive among the tick's: none where its ledgers read, unread otherwise. */
function noLedger(
  pr: number,
  read: ReadonlySet<number>,
  inScope: ReadonlySet<number> | undefined,
): CarrierDrive {
  if (read.has(pr)) return { kind: "none", why: "it has no drive" };
  return {
    kind: "unread",
    why:
      inScope !== undefined && !inScope.has(pr)
        ? "it carries no dispatch label, so its drive is not read (dispatch.labels.only_labeled)"
        : "its drive was not read this tick",
  };
}

/** The drive of a pull request among `drives`, the ones `read` holds the ledgers of, `inScope` those `only_labeled` keeps. */
function carrierDrive(
  pr: number,
  drives: readonly DrivenPr[],
  read: ReadonlySet<number>,
  inScope: ReadonlySet<number> | undefined,
): CarrierDrive {
  const drive = drives.find((d) => d.number === pr);
  if (drive === undefined) return noLedger(pr, read, inScope);
  const why = `${drive.class}${drive.why === "" ? "" : `: ${drive.why}`}`;
  // Asked for and not yet armed: carried work waiting for a slot, unlike a pull request nothing asks a drive for. The label projection gives both no state.
  if (drive.class === "unarmed") return { kind: "unarmed", why };
  const projected = stateOf(drive);
  if (projected === "unknown")
    // Only a ledger that read and waits on a state the forge leaves undecided is carried; an unreadable heartbeat, a ledger naming no verified head or one with no stop cannot be told.
    return drive.class === "unplaced" &&
      drive.readFailed !== true &&
      drive.forgeUndecided === true
      ? { kind: "unplaced", why }
      : {
          kind: "unread",
          why: `its drive's state could not be told (${why})`,
        };
  if (projected.state === "driving" || projected.state === "converged")
    return { kind: projected.state };
  if (projected.state === null) return { kind: "none", why: "it has no drive" };
  return { kind: ASKS_PERSON.has(drive.class) ? "parked" : "stopped", why };
}

/**
 * What the stall watch reads from the tick's reads: the open pull requests
 * (`null` when they did not read), how the repository's keys link them,
 * the drives the tick read and the pull requests whose ledgers it read.
 * A pull request from a fork is left out before the links
 * are made; one whose head repository did not read stays in, marked, so the
 * stall need can say it could not be told from a fork.
 */
export function carrierInput(read: {
  prs: readonly PrLinkText[] | null;
  rules: LinkRules | null;
  drives: readonly DrivenPr[];
  read: ReadonlySet<number>;
  /** Under `only_labeled`, the pull requests in scope: one outside it has no drive the tick reads. */
  inScope?: ReadonlySet<number>;
  /** The pull requests merged since the follow-up stage's start, as the tick listed them. */
  merged?: readonly MergedPr[];
  /** The tick's time, which a merged pull request's age is read against; without it no merged pull request settles an item. */
  nowMs?: number;
}): CarrierInput {
  const own = read.prs?.filter((p) => p.crossRepository !== true) ?? null;
  const unknownHead = new Set(
    own?.filter((p) => p.crossRepository === undefined).map((p) => p.number),
  );
  const links =
    own === null || read.rules === null ? null : workLinks(own, read.rules);
  const { nowMs } = read;
  const recent = (p: MergedPr) =>
    nowMs !== undefined && nowMs - parseMs(p.mergedAt) <= MERGED_SETTLES_MS;
  const merged = (read.merged ?? []).filter(recent).map(
    (p): PrLinkText => ({
      number: p.number,
      url: p.url,
      headRefName: p.head,
      body: p.body ?? "",
      // The merged listing carries no closing references, so only a link the branch or the description affirms is read; an item in another repository linked by closing references alone reads as not linked.
      closing: [],
    }),
  );
  const mergedLinks =
    read.rules === null
      ? null
      : merged.map((p) => ({
          p,
          links: workLinks([p], read.rules as LinkRules),
        }));
  return {
    carriers: (key) =>
      links
        ?.prsOf(key)
        ?.map((p) =>
          unknownHead.has(p.number) ? { ...p, headUnread: true } : p,
        ) ?? null,
    drive: (pr) => carrierDrive(pr, read.drives, read.read, read.inScope),
    merged: (key) =>
      (mergedLinks ?? []).flatMap(({ links }) => links.prsOf(key) ?? []),
  };
}

function prName(pr: CarrierPr, named?: number): string {
  return pr.number === named
    ? `pull request #${pr.number}`
    : `pull request #${pr.number} (${pr.url})`;
}

/** What the drive's state makes of the item, after the pull request that links it. */
const DRIVE_TEXT: Record<CarryingDrive, (why: string) => string> = {
  driving: () => "its drive is live",
  converged: () => "its drive converged and it waits for its merge",
  parked: (why) =>
    `its drive is parked on a person's question (${why}), which is the pull request's own need`,
  stopped: (why) =>
    `its drive stopped (${why}) and waits for a re-arm or a re-drive, which is the pull request's own need`,
  unplaced: (why) =>
    `its drive's state is undecided this tick (${why}), which a later tick reads again`,
  unarmed: (why) =>
    `its drive waits to be armed (${why}), which the tick arms when a slot and its admission allow`,
};

function carriedWhy(
  state: string,
  pr: CarrierPr,
  drive: CarrierDrive & { kind: CarryingDrive },
): string {
  const how = DRIVE_TEXT[drive.kind]("why" in drive ? drive.why : "");
  return `in ${state} with no running session: carried by ${prName(pr)}, which links it; ${how}`;
}

/** Whether a drive the tick read carries the item. */
function carries(
  drive: CarrierDrive,
): drive is CarrierDrive & { kind: CarryingDrive } {
  return drive.kind !== "none" && drive.kind !== "unread";
}

/** The first merged pull request that links the item, if any. */
function mergedCarriage(
  item: { key: string; state: string },
  input: CarrierInput,
): Carriage | null {
  const [pr] = [...(input.merged?.(item.key) ?? [])].sort(
    (a, b) => a.number - b.number,
  );
  if (pr === undefined) return null;
  return {
    kind: "merged",
    pr,
    why: `in ${item.state} with no running session: ${prName(pr)}, which links it, merged; its follow-up settles it`,
  };
}

/**
 * What the pull requests that link a claimed item make of it, an open one
 * whose drive carries it first, then a merged one; `none` without the
 * input. `named` is a pull request the stall need already names
 * in full, which the note then names by number alone.
 */
export function readCarriage(
  item: { key: string; state: string },
  input: CarrierInput | undefined,
  named?: number,
): Carriage {
  if (input === undefined) return { kind: "none" };
  const open = openCarriage(item, input, named);
  if (open.kind === "carried") return open;
  return mergedCarriage(item, input) ?? open;
}

/** What the open pull requests that link the item make of it. */
function openCarriage(
  item: { key: string; state: string },
  input: CarrierInput,
  named: number | undefined,
): Carriage {
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
    if (pr.headUnread === true) {
      told.push(
        `${prName(pr, named)} links it, but its head repository did not read, so it cannot be told from a fork`,
      );
      unread = true;
      continue;
    }
    if (carries(drive))
      return {
        kind: "carried",
        pr,
        drive: drive.kind,
        why: carriedWhy(item.state, pr, drive),
      };
    // The stall need already says the named pull request links the item.
    told.push(
      pr.number === named
        ? `${prName(pr, named)}: ${drive.why}`
        : `${prName(pr)} links it, but ${drive.why}`,
    );
    unread ||= drive.kind === "unread";
  }
  return {
    kind: "stall",
    note: `${told.join("; ")}${unread ? ", so whether a drive carries it cannot be told" : ""}`,
  };
}
