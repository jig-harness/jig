#!/usr/bin/env bun
/**
 * Tracker operations from the command line, through the consumer's tracker
 * (`issue_tracker` in `.config/jig.yaml`).
 *
 * Usage:
 *     bun tracker.ts children <issue-key>
 *     bun tracker.ts transition <issue-key> <canonical-state>
 *     bun tracker.ts comment <issue-key> --body-file body.md
 *     bun tracker.ts states                       # canonical → tracker names
 *     bun tracker.ts labels                       # label role → tracker labels
 *     bun tracker.ts create --input issue.json
 *     bun tracker.ts update <issue-key> --input patch.json
 *     bun tracker.ts search [--include-closed] [--] <text>
 *     bun tracker.ts relations <issue-key>
 *     bun tracker.ts relate <issue-key> <blocks|related|duplicate> <target-key>
 *     bun tracker.ts available-labels             # every label issues can carry
 *
 * Canonical states: backlog, todo, in_progress, in_review, done, canceled,
 * and where the consumer uses them triage, ops_pending, duplicate.
 *
 * `create` reads `{ title, description?, labels?, priority?, parent?,
 * project? }`; `update` reads `{ title?, description?, priority?, parent?,
 * project?, addLabels?, removeLabels? }`, where `parent: null` removes the
 * parent. Labels and the project are named; priority runs from 0 (none) to
 * 4 (low). A key either does not know is a usage error.
 *
 * `relate <a> duplicate <b>` records `a` as a duplicate of `b` (the tracker
 * may close `a`). `relations` reports each relation from the issue's side:
 * `blocks`, `blocked_by`, `related`, `duplicate` (it is a duplicate of the
 * other) and `duplicated_by` (the other is a duplicate of it).
 *
 * Output: JSON on stdout. Exit codes: 0 done, 2 usage (input the operation
 * cannot take), 1 the operation failed (the reason on stderr), a label,
 * project or issue that does not resolve to exactly one included.
 */

import { readFile } from "node:fs/promises";
import { runEntry } from "./lib/cli.ts";
import { ownTrackerConfig } from "./lib/tracker/config.ts";
import {
  CANONICAL_STATES,
  type CanonicalState,
  openTracker,
} from "./lib/tracker/index.ts";
import {
  type IssuePatch,
  type NewIssue,
  RELATION_TYPES,
  type RelationType,
  TrackerRequestError,
} from "./lib/tracker/port.ts";
import { labelsAsConfig } from "../../../shared/tracker-labels.ts";

const USAGE = `usage:
  tracker.ts children <issue-key>
  tracker.ts transition <issue-key> <canonical-state>
  tracker.ts comment <issue-key>   (body on stdin)
  tracker.ts states
  tracker.ts labels
  tracker.ts create                (new issue as JSON on stdin)
  tracker.ts update <issue-key>    (patch as JSON on stdin)
  tracker.ts search [--include-closed] [--] <text>   (-- ends the options)
  tracker.ts relations <issue-key>
  tracker.ts relate <issue-key> <${RELATION_TYPES.join("|")}> <target-key>
  tracker.ts available-labels`;

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

function usage(message: string): number {
  console.error(`${message}\n${USAGE}`);
  return 2;
}

/** Input the caller got wrong: reported as usage (exit 2), not a failure. */
export class UsageError extends Error {}

/** What a JSON field must hold, and how a usage error names it. */
interface Kind {
  ok: (v: unknown) => boolean;
  want: string;
}

const TEXT: Kind = { ok: (v) => typeof v === "string", want: "a string" };
const PRIORITY: Kind = {
  ok: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 4,
  want: "an integer from 0 (none) to 4 (low)",
};
const LABEL_NAMES: Kind = {
  ok: (v) =>
    Array.isArray(v) && v.every((l) => typeof l === "string" && l !== ""),
  want: "a list of label names",
};
const PARENT: Kind = {
  ok: (v) => v === null || typeof v === "string",
  want: "an issue key or null",
};

const NEW_ISSUE_FIELDS: Record<string, Kind> = {
  title: TEXT,
  description: TEXT,
  labels: LABEL_NAMES,
  priority: PRIORITY,
  parent: TEXT,
  project: TEXT,
};

const PATCH_FIELDS: Record<string, Kind> = {
  title: TEXT,
  description: TEXT,
  priority: PRIORITY,
  parent: PARENT,
  project: TEXT,
  addLabels: LABEL_NAMES,
  removeLabels: LABEL_NAMES,
};

/** `text` as a JSON object whose keys, and their values' kinds, `fields` allows. */
function parseObject(
  what: string,
  text: string,
  fields: Record<string, Kind>,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError(`${what} on stdin is not JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new UsageError(`${what} on stdin must be a JSON object`);
  for (const [key, v] of Object.entries(value)) {
    const kind = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (kind === undefined)
      throw new UsageError(
        `${what}: unknown key '${key}' (known: ${Object.keys(fields).join(", ")})`,
      );
    if (!kind.ok(v))
      throw new UsageError(`${what}: '${key}' must be ${kind.want}`);
  }
  return value as Record<string, unknown>;
}

/** The new issue `create` reads; an absent description or label list is empty. */
export function parseNewIssue(text: string): NewIssue {
  const obj = parseObject("the new issue", text, NEW_ISSUE_FIELDS);
  if (typeof obj.title !== "string" || obj.title.trim() === "")
    throw new UsageError("the new issue needs a non-empty 'title'");
  return { description: "", labels: [], ...obj, title: obj.title };
}

/** The patch `update` reads; one that changes nothing is refused. */
export function parsePatch(key: string, text: string): IssuePatch {
  const patch = parseObject(`the patch for ${key}`, text, PATCH_FIELDS);
  if (Object.values(patch).every((v) => Array.isArray(v) && v.length === 0))
    throw new UsageError(`the patch for ${key} changes nothing`);
  return patch as IssuePatch;
}

/** One operation: its positional arguments, its options, what it prints. */
interface Operation {
  /** How many positional arguments it takes, and how usage names them. */
  arity: number;
  takes: string;
  flags?: string[];
  input?: "input" | "body-file";
  /** Print the result indented, for a person reading a listing. */
  indent?: boolean;
  run: (args: string[], flags: Set<string>, input?: string) => Promise<unknown>;
}

const OPERATIONS: Record<string, Operation> = {
  states: {
    arity: 0,
    takes: "no argument",
    indent: true,
    run: async () => ownTrackerConfig().states,
  },
  labels: {
    arity: 0,
    takes: "no argument",
    indent: true,
    run: async () => labelsAsConfig(ownTrackerConfig().labels),
  },
  children: {
    arity: 1,
    takes: "one issue key",
    indent: true,
    run: ([key]) => openTracker().listChildren(key as string),
  },
  transition: {
    arity: 2,
    takes: "an issue key and a canonical state",
    run: async ([key, state]) => {
      if (!(CANONICAL_STATES as readonly string[]).includes(state as string))
        throw new UsageError(
          `'${state}' is not a canonical state (${CANONICAL_STATES.join(", ")})`,
        );
      const tracker = openTracker();
      await tracker.transition(key as string, state as CanonicalState);
      return {
        issue: key,
        state,
        name: tracker.stateName(state as CanonicalState),
      };
    },
  },
  comment: {
    arity: 1,
    takes: "one issue key; the body comes on stdin",
    input: "body-file",
    run: async ([key], _flags, input) => {
      const body =
        input === undefined ? await readStdin() : await readFile(input, "utf8");
      if (body.trim() === "") throw new UsageError("the comment body is empty");
      await openTracker().postComment(key as string, body);
      return { issue: key, commented: true };
    },
  },
  create: {
    arity: 0,
    takes: "no argument; the issue comes on stdin",
    input: "input",
    run: async (_args, _flags, input) => {
      const issue = parseNewIssue(
        input === undefined ? await readStdin() : await readFile(input, "utf8"),
      );
      return openTracker().createIssue(issue);
    },
  },
  update: {
    arity: 1,
    takes: "one issue key; the patch comes on stdin",
    input: "input",
    run: async ([key], _flags, input) => {
      const patch = parsePatch(
        key as string,
        input === undefined ? await readStdin() : await readFile(input, "utf8"),
      );
      await openTracker().updateIssue(key as string, patch);
      return { issue: key, updated: true };
    },
  },
  search: {
    arity: 1,
    takes: "one non-empty text",
    flags: ["--include-closed"],
    indent: true,
    run: async ([text], flags) => {
      if ((text as string).trim() === "")
        throw new UsageError("search takes one non-empty text");
      return openTracker().searchIssues(text as string, {
        includeClosed: flags.has("--include-closed"),
      });
    },
  },
  relations: {
    arity: 1,
    takes: "one issue key",
    indent: true,
    run: ([key]) => openTracker().listRelations(key as string),
  },
  relate: {
    arity: 3,
    takes: "an issue key, a relation type and a target key",
    run: async ([key, type, target]) => {
      if (!(RELATION_TYPES as readonly string[]).includes(type as string))
        throw new UsageError(
          `'${type}' is not a relation type (${RELATION_TYPES.join(", ")})`,
        );
      await openTracker().relate(
        key as string,
        type as RelationType,
        target as string,
      );
      return { issue: key, type, target };
    },
  },
  "available-labels": {
    arity: 0,
    takes: "no argument",
    indent: true,
    run: () => openTracker().listLabels(),
  },
};

/** Whether an error is the caller's input rather than a failed operation. */
function isUsage(err: unknown): err is Error {
  return (
    err instanceof UsageError ||
    (err instanceof TrackerRequestError && err.code === "invalid")
  );
}

function operationNamed(name: string | undefined): Operation {
  if (name === undefined) throw new UsageError("missing operation");
  if (!Object.hasOwn(OPERATIONS, name))
    throw new UsageError(`unknown operation: ${name}`);
  return OPERATIONS[name] as Operation;
}

/** The separator and everything after it are positional, even flag-like text. */
function optionBoundary(args: string[]): number {
  const separator = args.indexOf("--");
  return separator === -1 ? args.length : separator;
}

function requiredInputPath(path: string | undefined, flag: string): string {
  if (!path || path.startsWith("--"))
    throw new UsageError(`--${flag} requires a path`);
  return path;
}

/** Remove the operation's file option before checking its remaining arguments. */
function inputFile(op: Operation, rest: string[]): string | undefined {
  if (op.input === undefined) return undefined;
  const index = rest.slice(0, optionBoundary(rest)).indexOf(`--${op.input}`);
  if (index === -1) return undefined;
  const path = requiredInputPath(rest[index + 1], op.input);
  rest.splice(index, 2);
  return path;
}

function operationArguments(op: Operation, name: string, rest: string[]) {
  const boundary = optionBoundary(rest);
  const options = rest.slice(0, boundary);
  const flags = options.filter((arg) => arg.startsWith("--"));
  const args = [
    ...options.filter((arg) => !arg.startsWith("--")),
    ...rest.slice(boundary + 1),
  ];
  const allowed = new Set(op.flags);
  const unknown = flags.filter((flag) => !allowed.has(flag));
  if (unknown.length)
    throw new UsageError(`unknown option: ${unknown.join(", ")}`);
  if (args.length !== op.arity)
    throw new UsageError(`${name} takes ${op.takes}`);
  return { args, flags: new Set(flags) };
}

function reportFailure(error: unknown): number {
  if (isUsage(error)) return usage(error.message);
  console.error(
    `ERROR: ${error instanceof Error ? error.message : String(error)}`,
  );
  return 1;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const [name, ...rest] = argv;
    const op = operationNamed(name);
    const input = inputFile(op, rest);
    const { args, flags } = operationArguments(op, name as string, rest);
    const out = await op.run(args, flags, input);
    console.log(JSON.stringify(out, null, op.indent === true ? 2 : undefined));
    return 0;
  } catch (error) {
    return reportFailure(error);
  }
}

if (import.meta.main) runEntry(() => main(process.argv.slice(2)));
