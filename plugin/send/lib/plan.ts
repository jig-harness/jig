/**
 * What a send would write, before it writes: the repository in full, the
 * login it writes as, what the person already answered (for an answer), the
 * record and where it goes, the reader that acts on it and how to take it
 * back, then what the record decides in full (an answer's option and the
 * framing's digest). `--dry-run` prints this and stops; a real send
 * prints it, writes, and ends with the link to (or the path of) what it
 * wrote and the reader again.
 */
import type { MachineStage } from "../../dispatch/lib/machine-config.ts";
import {
  failedBy,
  failureOf,
  type OutboundFailure,
  outboundFailure,
  outboundOf,
} from "../../shared/outbound/failure.ts";
import {
  type Failure,
  failed,
  ok,
  type Outcome,
} from "../../shared/outcome.ts";
import { isoFromMs } from "../../shared/time.ts";
import { printable } from "../../ask/lib/render.ts";
import { within } from "../../ask/lib/reading.ts";
import type {
  Tracker,
  TrackerUser,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type { Verb } from "./verbs.ts";

/** The tick a send names as its reader when it woke none. */
export const NEXT_TICK = "the dispatcher's next tick";

/**
 * The dispatcher's tick as a record's reader: the machine-file stage under
 * which the tick acts on the record, and the reader named for a given tick
 * (`NEXT_TICK`, or the tick the send woke).
 */
export interface TickReader {
  stage: MachineStage;
  reader(tick: string): string;
}

export interface Plan {
  /** The address in full. */
  address: string;
  repo: string;
  verb: Verb;
  /** The login it writes as, and whose it is. */
  writesAs: string;
  /** The record, in words. */
  record: string;
  /** Where it goes: a link, or a path on this machine. */
  where: string;
  /** The reader that acts on it, and when. */
  reader: string;
  /** The tick, when the tick is the reader (or starts it); `null` when it is not. */
  tick: TickReader | null;
  /** How to take it back, or why it cannot be. */
  undo: string;
  /** What a person must know before it is written; `null` for nothing. */
  notice: string | null;
  /** What was answered before, shown before the record: one entry per earlier answer. */
  earlier?: string[];
  /** Named lines that follow the plan's rows: what the record decides, in full. */
  detail?: Array<[name: string, value: string]>;
  /** Write it: the link to or path of what was written (or, of several records, what was and what was not), or why nothing was. */
  write(): Promise<Outcome<string | PartSent, "refused">>;
}

/** A write of several records that stopped part-way: the links of those sent, and which were not and why. */
export interface PartSent {
  sent: string;
  unsent: string;
}

/** A refusal: a request the station cannot take, or one this machine will not write. */
export type Planned = Outcome<Plan, "refused">;

export const refused = (reason: string) => failed("refused", reason);

/** The cause of a failed login read, in words, by the call's failure class. */
function unreadCause(
  where: string,
  call: OutboundFailure | null,
  reason: string,
): string {
  switch (call?.code) {
    case "rate-limited":
      return call.until === undefined
        ? `the credential's allowance on ${where} is spent; send again once it is restored`
        : `the credential's allowance on ${where} is spent until ${isoFromMs(call.until)}; send again after then`;
    case "unauthorized":
      return `${where} refused the credential (${reason}); sign in again, then send again`;
    case "unreachable":
      return `${where} did not answer (${reason}); send again`;
    case "too-costly":
      return `${where} ran out of time on the request (${reason}); send again`;
    case "server-fault":
      return `${where} answered with a fault of its own (${reason}); send again later`;
    case "not-found":
    case "invalid":
      return `${where}'s answer could not be read (${reason})`;
    default:
      return reason;
  }
}

/** The refusal of a send whose login on `where` was not read, naming why. */
function loginUnread(where: string, failure: Failure) {
  return refused(
    `the login this machine is signed in as on ${where} was not read, so nothing was sent: ${unreadCause(where, outboundOf(failure), failure.reason)}`,
  );
}

/**
 * The login a send writes as, checked against `--as`: refused when the
 * login was not read, naming why; when the medium answered and named none;
 * or when `as` names another.
 */
export function writerLogin(
  read: Outcome<string | null, string>,
  as: string | undefined,
  where: string,
): Outcome<string, "refused"> {
  if (!read.ok) return loginUnread(where, read.failure);
  const login = read.value;
  if (login === null)
    return refused(
      `${where} did not name the login this machine is signed in as, so who would write is not known`,
    );
  if (as !== undefined && as.toLowerCase() !== login.toLowerCase())
    return refused(
      `--as ${as}: this machine is signed in as ${login} on ${where}; sign in as ${as}, or leave --as out`,
    );
  return ok(login);
}

/**
 * The user the tracker's credential acts as, read within `sec` seconds, and
 * the login a send through it writes as, checked as `writerLogin` checks
 * it. A read that failed names the call's class; one that did not settle
 * in time is `unreachable`.
 */
export async function trackerWriter(
  tracker: Pick<Tracker, "viewer">,
  sec: number,
  as: string | undefined,
): Promise<Outcome<{ viewer: TrackerUser; login: string }, "refused">> {
  let read: Outcome<TrackerUser, "unread">;
  try {
    const got = await within(sec, (signal) => tracker.viewer(signal));
    read =
      got === null
        ? failedBy(
            "unread",
            outboundFailure(
              "unreachable",
              `no answer within the answer's deadline (${sec} s)`,
            ),
          )
        : ok(got.value);
  } catch (error) {
    read = failedBy("unread", failureOf(error));
  }
  if (!read.ok) return loginUnread("the tracker", read.failure);
  const viewer = read.value;
  const login = writerLogin(
    ok(viewer.name === "" ? null : viewer.name),
    as,
    "the tracker",
  );
  return login.ok ? ok({ viewer, login: login.value }) : login;
}

/** `text` for the terminal: control and direction-changing characters removed, the layout newlines kept. */
export const shown = (text: string) =>
  text
    .split("\n")
    .map((line) =>
      printable(line).replace(/[\u202a-\u202e\u2066-\u2069]/gu, " "),
    )
    .join("\n");

/** One plan row: every value passes `shown`, whichever field it came from. */
const row = (name: string, value: string) =>
  `  ${name.padEnd(11)}${shown(value).replaceAll("\n", `\n${" ".repeat(13)}`)}`;

/** The plan as it prints before a write, or as a dry run. */
export function renderPlan(plan: Plan, dryRun: boolean): string {
  return [
    shown(`jig send ${plan.address} ${plan.verb}${dryRun ? " (dry run)" : ""}`),
    row("repository", plan.repo),
    row("writes as", plan.writesAs),
    ...(plan.earlier ?? []).map((e) => row("earlier", e)),
    row("record", plan.record),
    row("where", plan.where),
    row("read by", plan.reader),
    row("undo", plan.undo),
    ...(plan.notice === null ? [] : [row("note", plan.notice)]),
    ...(plan.detail ?? []).map(([name, value]) => row(name, value)),
    ...(dryRun ? ["dry run: nothing was written."] : []),
  ].join("\n");
}

/**
 * The end of a real send: what it wrote, and the reader that acts on it;
 * `woken` names the tick the send woke, `null` when it woke none.
 */
export function renderSent(
  plan: Plan,
  wrote: string,
  woken: string | null,
): string {
  const reader =
    woken === null || plan.tick === null
      ? plan.reader
      : plan.tick.reader(woken);
  return [row("sent", wrote), row("next", reader)].join("\n");
}
