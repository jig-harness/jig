/**
 * What the page's two reads come to, which every part of the page reads: the
 * line, the server's clock, and what failed. Pure, so it is worked out once per
 * render and checked without a browser.
 */
import type {
  LineSnapshot,
  RowsAnswer,
  StateAnswer,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import type { ReadFailure } from "./api.ts";
import { clock, serverNow } from "./format.ts";
import type { Read, StateRead } from "./reads.ts";
import { type Clock, isOverdue, type StripView, stripOf } from "./view.ts";

type CodedFailure = Extract<ReadFailure, { kind: "failed" }>;

export interface PageView {
  /** The last state the server returned; `null` before it returned one. */
  answer: StateAnswer | null;
  line: LineSnapshot | null;
  clock: Clock;
  /** Whether either read found the server not answering. */
  gone: boolean;
  /** Whether the timer is past its next tick and the longest recent one. */
  overdue: boolean;
  /** A coded failure, the state read's before the log's. */
  coded: CodedFailure | null;
  /** When the state was last read, on the host's clock. */
  lastRead: string | null;
  /** `plugin 0.0.0`; `null` before anything was read. */
  version: string | null;
  /** Whether the answer speaks of its tick as past. */
  pastTense: boolean;
}

/** What the page knows from the server's own answer, or nothing before one. */
function answered(answer: StateAnswer | null) {
  if (answer === null)
    return { line: null, timeZone: "UTC", lastRead: null, version: null };
  return {
    line: answer.line,
    timeZone: answer.timeZone,
    lastRead: clock(Date.parse(answer.now), answer.timeZone),
    version: `plugin ${answer.plugin ?? "not known"}`,
  };
}

/** The server's clock now; this device's own before the server has said. */
function nowOf(read: StateRead | null, mono: number): number {
  if (read === null) return Date.now();
  return serverNow(
    read.answer.now,
    read.readAtMono,
    Math.max(mono, read.readAtMono),
  );
}

function isCoded(failure: ReadFailure | null): failure is CodedFailure {
  return failure?.kind === "failed";
}

/** The two reads as the page shows them, at this device's running clock `mono`. */
export function pageView(
  state: Read<StateRead>,
  rows: Read<RowsAnswer>,
  mono: number,
): PageView {
  const answer = state.data?.answer ?? null;
  const known = answered(answer);
  const failures = [state.failure, rows.failure];
  const gone = failures.some((failure) => failure?.kind === "gone");
  const nowMs = nowOf(state.data, mono);
  const overdue = known.line !== null && isOverdue(known.line, nowMs);
  return {
    answer,
    line: known.line,
    clock: { nowMs, timeZone: known.timeZone },
    gone,
    overdue,
    coded: failures.find(isCoded) ?? null,
    lastRead: known.lastRead,
    version: known.version,
    pastTense: gone || overdue || isCoded(state.failure),
  };
}

/** The strip: nothing to say of a tick before the first answer, unless the server is gone. */
export function pageStrip(view: PageView): StripView {
  return view.answer === null && !view.gone
    ? { main: "Newest tick not known", sub: "", alarm: false }
    : stripOf(view.line, view.clock, view.gone);
}

/** The footer's sentence on when the page last read. */
export function readLine(view: PageView): string {
  if (view.lastRead === null) return "not read";
  return view.gone
    ? `last read ${view.lastRead} host time`
    : `read ${view.lastRead} host time; reads every 60 s and on focus`;
}

/** `Last read 16:47; `, to lead a sentence about retrying; empty before a read. */
export function lastReadLead(view: PageView): string {
  return view.lastRead === null ? "" : `Last read ${view.lastRead}; `;
}
