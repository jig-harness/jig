/**
 * What a send would write, before it writes: the repository in full, the
 * login it writes as, the record and where it goes, the reader that acts on
 * it and how to take it back. `--dry-run` prints this and stops; a real send
 * prints it, writes, and ends with the link to (or the path of) what it
 * wrote and the reader again.
 */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import type { Verb } from "./verbs.ts";

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
  /** How to take it back, or why it cannot be. */
  undo: string;
  /** What a person must know before it is written; `null` for nothing. */
  notice: string | null;
  /** Write it: the link to or path of what was written, or why it was not. */
  write(): Promise<Outcome<string, "refused">>;
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
    row("record", plan.record),
    row("where", plan.where),
    row("read by", plan.reader),
    row("undo", plan.undo),
    ...(plan.notice === null ? [] : [row("note", plan.notice)]),
    ...(dryRun ? ["dry run: nothing was written."] : []),
  ].join("\n");
}

/** The end of a real send: what it wrote, and the reader that acts on it. */
export function renderSent(plan: Plan, wrote: string): string {
  return [row("sent", wrote), row("next", plan.reader)].join("\n");
}
