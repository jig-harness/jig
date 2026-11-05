#!/usr/bin/env bun
/**
 * The drive mailbox's command line (`lib/state/mailbox.ts`):
 *
 *   mailbox.ts send <PR> --kind note --body TEXT [--from WHO]
 *   mailbox.ts send <PR> --kind directive --command hold-push|pause|stop|resume
 *                   [--target hold-push|pause|stop] [--generation N] [--body TEXT]
 *   mailbox.ts check|outbox|gate-state|repair <PR>
 *   mailbox.ts ack <PR> --id ID [--id ID …]
 *   mailbox.ts respond <PR> --id ID --response TEXT
 *
 * `--generation N` addresses a `stop` to the driver of that generation (the
 * number a driver prints at its start and `drives.ts` lists): it ends that
 * driver at its next round boundary and no later one. A `stop` without it
 * ends every later driver in this working tree until `resume --target stop`.
 * `outbox` shows the driver's `ack` of each directive it acted on.
 */
import { definedFields } from "../../../shared/defined-fields.ts";
import { fail, isDigits, runMain } from "./lib/cli.ts";
import { resolvePr } from "./lib/proc.ts";
import {
  appendDirective,
  appendNote,
  appendOutboxRecord,
  DIRECTIVE_COMMANDS,
  type DirectiveCommand,
  foldGateState,
  GATE_NAMES,
  type GateName,
  isGeneration,
  outboxRecordsForPr,
  readInboxMessages,
  repairInbox,
  resolveMailboxDir,
  unseenMessages,
} from "./lib/state/mailbox.ts";

function takeFlag(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined) fail(2, `${flag} requires a value`);
  return value;
}

async function resolvePrArg(pr: string): Promise<string> {
  const resolved = await resolvePr(pr);
  if (resolved === "") {
    fail(
      2,
      "mailbox.ts: could not resolve a PR number (pass one explicitly, or run from a branch with an open PR)",
    );
  }
  // Same `isDigits` guard `guarded-push.ts` applies to its own `pr` argument
  // (lib/cli.ts): `resolvePr` returns explicit input verbatim, so `mailbox.ts
  // send abc ...` would otherwise succeed and write a record no numeric-PR
  // consumer (`foldGateState`, `isPushHeld`, …) ever reads. `'0'` is REJECTED
  // here too, not just non-digits: `isDigits` alone accepts it, but
  // `lib/state/mailbox.ts`'s own `isCanonicalPr` explicitly treats `'0'` as
  // unidentifiable — no GitHub PR is ever numbered `0`. Without this,
  // `mailbox.ts send 0 --kind directive --command hold-push` would succeed at
  // the CLI and write a `pr: "0"` directive that `foldGateState` then poisons
  // EVERY OTHER PR's fold with (a malformed record with no identifiable PR
  // still fails closed for every reader), silently blocking every guarded push
  // in this worktree until an operator manually repairs the inbox.
  if (!isDigits(resolved) || BigInt(resolved) === 0n) {
    fail(2, `mailbox.ts: PR must be numeric and non-zero (got '${resolved}')`);
  }
  // Canonicalized (leading zeros stripped), not just validated as digits: every
  // mailbox comparison (`msg.pr !== pr` in `foldGateState`, the ack cursor's
  // `r.pr === pr`) is a plain STRING equality, so `mailbox.ts send 0999 ...`
  // would otherwise stamp `pr: "0999"` — silently invisible to
  // `foldGateState(dir, '999')`, meaning an apparently successful hold-push
  // would never actually block a push.
  return BigInt(resolved).toString();
}

interface SendArgs {
  pr: string;
  kind: "note" | "directive" | "";
  from: string;
  body?: string;
  command: DirectiveCommand | "";
  target?: GateName;
  generation?: number;
}

/** `v` when it is one of `allowed`, else the usage refusal naming `flag`. */
function oneOf<T extends string>(
  flag: string,
  v: string,
  allowed: readonly T[],
  expected = `one of ${allowed.join(", ")}`,
): T {
  if (!allowed.includes(v as T))
    fail(2, `${flag} must be ${expected} (got '${v}')`);
  return v as T;
}

/** What each `send` flag sets from its value, refusing a value it does not take. */
const SEND_FLAGS: Readonly<Record<string, (v: string, a: SendArgs) => void>> = {
  "--kind": (v, a) => {
    a.kind = oneOf("--kind", v, ["note", "directive"], "'note' or 'directive'");
  },
  "--from": (v, a) => {
    a.from = v;
  },
  "--body": (v, a) => {
    a.body = v;
  },
  "--command": (v, a) => {
    a.command = oneOf("--command", v, DIRECTIVE_COMMANDS);
  },
  "--target": (v, a) => {
    a.target = oneOf("--target", v, GATE_NAMES);
  },
  "--generation": (v, a) => {
    a.generation = isDigits(v) ? Number(v) : Number.NaN;
    if (!isGeneration(a.generation))
      fail(2, `--generation must be a positive whole number (got '${v}')`);
  },
};

function parseSendArgs(argv: string[]): SendArgs {
  const a: SendArgs = {
    pr: "",
    kind: "",
    from: process.env.USER ?? "",
    command: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const flag = SEND_FLAGS[arg];
    if (flag !== undefined) flag(takeFlag(argv, i++, arg), a);
    else if (arg.startsWith("--")) fail(2, `unknown flag: ${arg}`);
    else if (a.pr === "") a.pr = arg;
    else fail(2, `unexpected argument: ${arg}`);
  }
  if (a.kind === "") fail(2, "send: --kind 'note' or 'directive' is required");
  if (a.from === "")
    fail(2, "send: --from is required (no $USER in this environment)");
  return a;
}

/**
 * A note. `--command`, `--target` and `--generation` only apply to a
 * directive: silently ignoring them on a note send let a contradictory
 * invocation (`--kind note --command hold-push`) write a plain note and exit
 * 0, and an operator could believe a hold was installed while
 * `guarded-push.ts` stays clear and proceeds to push.
 */
async function sendNote(dir: string, pr: string, a: SendArgs) {
  for (const [flag, given] of [
    ["--command", a.command !== ""],
    ["--target", a.target !== undefined],
    ["--generation", a.generation !== undefined],
  ] as const)
    if (given)
      fail(2, `send --kind note: ${flag} is only valid with --kind directive`);
  if (a.body === undefined) fail(2, "send --kind note: --body is required");
  return appendNote(dir, pr, a.from, a.body);
}

async function sendDirective(dir: string, pr: string, a: SendArgs) {
  if (a.command === "") fail(2, "send --kind directive: --command is required");
  const { target, body, generation } = a;
  return appendDirective(dir, pr, a.from, a.command, {
    ...definedFields({ target, body, generation }),
  });
}

async function cmdSend(argv: string[]): Promise<number> {
  const a = parseSendArgs(argv);
  const pr = await resolvePrArg(a.pr);
  const dir = await resolveMailboxDir();
  const msg =
    a.kind === "note"
      ? await sendNote(dir, pr, a)
      : await sendDirective(dir, pr, a);
  process.stdout.write(`${JSON.stringify(msg)}\n`);
  return 0;
}

async function cmdCheck(argv: string[]): Promise<number> {
  let pr = "";
  for (const a of argv) {
    if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
    else if (pr === "") pr = a;
    else fail(2, `unexpected argument: ${a}`);
  }
  pr = await resolvePrArg(pr);
  const dir = await resolveMailboxDir();
  // A PURE READ — see `ack`, below, for why this no longer acknowledges
  // anything itself. Nothing to lock: two concurrent `check` calls simply
  // both see the same unacknowledged set, which is correct (neither one
  // mutates anything), not a race.
  const result = unseenMessages(dir, pr);
  if (!result.ok) {
    fail(1, `mailbox.ts check: ${result.why}`);
  }
  process.stdout.write(
    `${JSON.stringify({ messages: result.messages, warnings: result.warnings })}\n`,
  );
  return 0;
}

/**
 * Explicitly acknowledges message ids — the ONLY way an inbox message is ever
 * marked seen. `check` used to do this itself, automatically, right after
 * printing the messages — but "the stdout write returned" is not "the caller
 * received and safely processed the payload": `write()`'s own return value only
 * confirms the data was handed to the OS, and a delayed failure (a reader that
 * closes the pipe after reading only part of it, `EPIPE` surfacing after the
 * write already "succeeded") can leave every message acked with the caller
 * never having durably captured them — silent, unrecoverable loss on this
 * channel's one delivery path. Splitting ack into its own explicit step moves
 * that judgment to the only party that can actually make it: the caller, which
 * acks only once IT has confirmed its own successful handling — a durable log
 * write, a completed hand-off, whatever "safe" means for that specific caller
 * (successively narrower attempts at confirming delivery from THIS side of the
 * pipe all failed; the real fix was to stop trying to infer it at all).
 */
async function cmdAck(argv: string[]): Promise<number> {
  let pr = "";
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--id") ids.push(takeFlag(argv, i++, a));
    else if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
    else if (pr === "") pr = a;
    else fail(2, `unexpected argument: ${a}`);
  }
  if (ids.length === 0) fail(2, "ack: at least one --id is required");
  // An empty `--id ''` (e.g. from an unset shell variable) would otherwise
  // reach `appendOutboxRecord` and write a `received` record `parseOutbox
  // Record` later rejects for having a non-empty-string id — the command
  // reports success (exit 0) while the ack never actually took effect, and
  // the next `check` reports the message again despite it.
  // Validated BEFORE any
  // record is written, not per-id inside the loop below, so a bad id
  // later in the list can't leave an earlier one already durably
  // acknowledged from a call that overall failed.
  for (const id of ids) {
    if (id === "") fail(2, "ack: --id must not be empty");
  }
  pr = await resolvePrArg(pr);
  const dir = await resolveMailboxDir();
  // A typo'd id, or a following flag mistakenly consumed as an id's
  // value, would otherwise durably write an outbox record for an id
  // that names NO real inbox message — the command reports success
  // while the message actually intended stays unseen forever.
  // Validated against every known
  // inbox message for this PR — not just the currently-UNSEEN subset,
  // since re-acking an already-acked id (or acking one already
  // `respond`ed to) is legitimate and must not be refused as though it
  // were a typo. Checked as a complete batch BEFORE any record is
  // written, for the same reason the empty-id check above is.
  const inbox = readInboxMessages(dir, pr);
  if (inbox.file.kind === "unreadable") {
    fail(2, `ack: could not read the inbox (${inbox.file.why})`);
  }
  const knownIds = new Set(inbox.messages.map((m) => m.id));
  for (const id of ids) {
    if (!knownIds.has(id)) {
      fail(
        2,
        `ack: '${id}' is not a known inbox message for PR #${pr}.`,
        "Check 'mailbox.ts check' for the exact id.",
      );
    }
  }
  for (const id of ids) {
    await appendOutboxRecord(dir, {
      id,
      ts: new Date().toISOString(),
      pr,
      status: "received",
    });
  }
  return 0;
}

async function cmdRespond(argv: string[]): Promise<number> {
  let pr = "";
  let id = "";
  let response = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--id") id = takeFlag(argv, i++, a);
    else if (a === "--response") response = takeFlag(argv, i++, a);
    else if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
    else if (pr === "") pr = a;
    else fail(2, `unexpected argument: ${a}`);
  }
  if (id === "") fail(2, "respond: --id is required");
  if (response === "") fail(2, "respond: --response is required");
  pr = await resolvePrArg(pr);
  const dir = await resolveMailboxDir();
  // Same validation as `ack`, and the identical reasoning: a typo'd id
  // would otherwise durably write an answer nobody polling for the real
  // message will ever see.
  const inbox = readInboxMessages(dir, pr);
  if (inbox.file.kind === "unreadable") {
    fail(2, `respond: could not read the inbox (${inbox.file.why})`);
  }
  if (!inbox.messages.some((m) => m.id === id)) {
    fail(
      2,
      `respond: '${id}' is not a known inbox message for PR #${pr}.`,
      "Check 'mailbox.ts check' for the exact id.",
    );
  }
  await appendOutboxRecord(dir, {
    id,
    ts: new Date().toISOString(),
    pr,
    status: "done",
    response,
  });
  return 0;
}

async function cmdOutbox(argv: string[]): Promise<number> {
  let pr = "";
  for (const a of argv) {
    if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
    else if (pr === "") pr = a;
    else fail(2, `unexpected argument: ${a}`);
  }
  pr = await resolvePrArg(pr);
  const dir = await resolveMailboxDir();
  const result = outboxRecordsForPr(dir, pr);
  if (!result.ok) {
    fail(1, `mailbox.ts outbox: ${result.why}`);
  }
  process.stdout.write(
    `${JSON.stringify({ records: result.records, warnings: result.warnings })}\n`,
  );
  return 0;
}

async function cmdRepair(argv: string[]): Promise<number> {
  let pr = "";
  let dryRun = false;
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
    else if (pr === "") pr = a;
    else fail(2, `unexpected argument: ${a}`);
  }
  // `repair` acts on the whole inbox file, not one PR's slice of it — `pr`
  // is only required so this command follows the same resolution rule
  // (explicit arg, else the current branch's PR) as every other subcommand.
  pr = await resolvePrArg(pr);
  const dir = await resolveMailboxDir();
  const result = await repairInbox(dir, dryRun);
  if (!result.ok) {
    fail(1, `mailbox.ts repair: ${result.why}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function cmdGateState(argv: string[]): Promise<number> {
  let pr = "";
  for (const a of argv) {
    if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
    else if (pr === "") pr = a;
    else fail(2, `unexpected argument: ${a}`);
  }
  pr = await resolvePrArg(pr);
  const dir = await resolveMailboxDir();
  const result = foldGateState(dir, pr);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "send":
      return cmdSend(rest);
    case "check":
      return cmdCheck(rest);
    case "ack":
      return cmdAck(rest);
    case "respond":
      return cmdRespond(rest);
    case "outbox":
      return cmdOutbox(rest);
    case "gate-state":
      return cmdGateState(rest);
    case "repair":
      return cmdRepair(rest);
    default:
      fail(
        2,
        `mailbox.ts: unknown subcommand '${sub ?? ""}' — expected send, check, ack, respond, outbox, gate-state, or repair`,
      );
  }
}

if (import.meta.main) runMain("mailbox.ts", main);
