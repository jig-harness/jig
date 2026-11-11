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
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
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

/**
 * The login a send writes as, checked against `--as`: refused when the
 * medium named none, or when `as` names another.
 */
export function writerLogin(
  login: string | null,
  as: string | undefined,
  where: string,
): Outcome<string, "refused"> {
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

const row = (name: string, value: string) => `  ${name.padEnd(11)}${value}`;

/** The plan as it prints before a write, or as a dry run. */
export function renderPlan(plan: Plan, dryRun: boolean): string {
  return [
    `jig send ${plan.address} ${plan.verb}${dryRun ? " (dry run)" : ""}`,
    row("repository", plan.repo),
    row("writes as", plan.writesAs),
    ...(plan.earlier ?? []).map((e) => row("earlier", e)),
    row("record", plan.record),
    row("where", plan.where),
    row("read by", plan.reader),
    row("undo", plan.undo),
    ...(plan.notice === null ? [] : [row("note", plan.notice)]),
    ...(plan.detail ?? []).map(([name, value]) =>
      row(name, value.replaceAll("\n", `\n${" ".repeat(13)}`)),
    ),
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
  return [
    row("sent", wrote.replaceAll("\n", `\n${" ".repeat(13)}`)),
    row("next", reader),
  ].join("\n");
}
