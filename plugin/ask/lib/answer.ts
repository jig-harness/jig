import type { NextOwner } from "../../dispatch/lib/next-owner.ts";
/**
 * What `jig ask` answers for an address, in the shape it prints as JSON
 * (`--json`, version `ANSWER_VERSION`): later versions add fields and never
 * rename one. A field only the machine that answered knows (an account, a
 * session, a path) sits under a `local` key, which an interface that passes
 * an answer on to another machine leaves out.
 */
import type { Station } from "../../shared/address.ts";

/** The version `--json` prints as `v`. */
export const ANSWER_VERSION = 1;

/** Whether a process a holder names runs: judged on this machine, ended, or not knowable here. */
export type ProcessState = "alive" | "dead" | "unknown";

/** The launch that holds a station now. */
export interface Holder {
  /** What it runs: a launch's action (`rearm`, `takeover`, `pickup`, `followup`), or `drive` for a driver nobody dispatched. */
  stage: string;
  /** `this machine`, another host as its claims name it (a digest), or `unknown`. */
  host: string;
  /** The drive's driver generation, where a record names it. */
  generation: number | null;
  process: ProcessState;
  /** Why the process state is what it is, in words. */
  why: string;
  /** What only this machine's records name. */
  local?: {
    account?: string;
    session?: string;
    record?: string;
    workspace?: string;
  };
}

/** The acts a person settles a station with: a closed list. */
const PERSON_ACTS = [
  "answer",
  "re-arm",
  "release the CI hold",
  "merge",
  "re-run the follow-up",
  "choose the session that keeps the item",
  "look at the stalled pickup",
  "answer the waiting session",
  "assign the item as someone who can write",
] as const;
export type PersonAct = (typeof PERSON_ACTS)[number];

/** What a station waits on: nothing, something that settles by itself, or a person's act. */
export type WaitsOn =
  | "none"
  | { waiting: string }
  | { person: PersonAct; why: string };

/** The last launch of the station that ended. */
export interface Last {
  /** Its class from the outcome log's closed list, or as a launch claim's end reads. */
  class: string;
  at: string;
  reason: string;
  /** Where it was read: this machine's outcome log, or a launch claim's end on the forge. */
  from: "outcome log" | "launch claim";
  /** Null when the older record did not keep a handoff. */
  next: NextOwner | null;
}

/** One record kind the answer consulted. */
export interface SourceRead {
  record: string;
  read: boolean;
  /** Why it was not read; what it found, where that matters. */
  detail?: string;
  /** Read from this machine's records only. */
  local?: true;
}

export interface Sources {
  records: SourceRead[];
  forgeCalls: number;
  trackerCalls: number;
}

/** The kinds of entry a thread holds. */
export type EntryKind =
  | "request"
  | "question"
  | "answer"
  | "launch"
  | "outcome";

/** One record of an address's correspondence. */
export interface ThreadEntry {
  at: string;
  kind: EntryKind;
  /** An address, a person as the forge or tracker login, or a host. */
  from: string;
  to: string;
  /** The record's own words, never rewritten. */
  text: string;
  record: { kind: string; url?: string; path?: string };
  /** Read only from this machine's records. */
  local?: true;
  /** For a label request that has come off: when. */
  until?: string;
}

export interface AskAnswer {
  v: typeof ANSWER_VERSION;
  address: string;
  station: Station;
  repo: string;
  key: string;
  /** The piece of work as the forge or tracker names it, where it was read. */
  title: string | null;
  url: string | null;
  holder: Holder | "none";
  state: string;
  /** The state in words: why it reads so. */
  stateDetail: string;
  waitsOn: WaitsOn;
  last: Last | null;
  sources: Sources;
  thread?: ThreadEntry[];
  threadOmitted?: number;
}

/** How `ask` exits: answered (also when nobody holds it), the key names nothing, a usage error. */
export const ASK_EXIT = { ANSWERED: 0, NOTHING: 1, USAGE: 2 } as const;
