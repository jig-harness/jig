#!/usr/bin/env bun
/**
 * Tracker operations from the command line, through the consumer's tracker
 * (`issue_tracker` in `.config/jig.yaml`).
 *
 * Usage:
 *     bun tracker.ts children <issue-key>
 *     bun tracker.ts transition <issue-key> <canonical-state>
 *     bun tracker.ts comment <issue-key>          # body on stdin
 *     bun tracker.ts states                       # canonical → tracker names
 *     bun tracker.ts issue-states                 # item keys on stdin → open/closed
 *     bun tracker.ts labels                       # label role → tracker labels
 *     bun tracker.ts create                       # new issue as JSON on stdin
 *     bun tracker.ts update <issue-key>           # patch as JSON on stdin
 *     bun tracker.ts search [--include-closed] [--] <text>
 *     bun tracker.ts relations <issue-key>
 *     bun tracker.ts relate <issue-key> <blocks|related|duplicate> <target-key>
 *     bun tracker.ts available-labels             # every label issues can carry
 *
 * `issue-states` reads item keys, one per line, and prints each key's
 * current state as `open`, `closed` (completed, canceled or duplicate) or
 * `not_found`: the live half of M4's deferral check reads it. A key the
 * tracker answers without a state category is an error, never `open`.
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

import { runEntry } from "./lib/cli.ts";
import { ownTrackerConfig } from "./lib/tracker/config.ts";
import {
  CANONICAL_STATES,
  type CanonicalState,
  openTracker,
} from "./lib/tracker/index.ts";
import {
  CLOSED_STATE_TYPES,
  type IssuePatch,
  type NewIssue,
  RELATION_TYPES,
  type RelationType,
  type Tracker,
  TrackerRequestError,
} from "./lib/tracker/port.ts";
import { labelsAsConfig } from "../../../shared/tracker-labels.ts";

const USAGE = `usage:
  tracker.ts children <issue-key>
  tracker.ts transition <issue-key> <canonical-state>
  tracker.ts comment <issue-key>   (body on stdin)
  tracker.ts states
  tracker.ts issue-states          (item keys on stdin, one per line)
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

/** A lookup that cannot be answered; the operation fails rather than guess. */
class ItemStateError extends Error {}

/** The shape of an item key: letters and digits, a hyphen, a number. */
const ITEM_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** How many keys are looked up at once. */
const LOOKUPS_AT_ONCE = 4;

/** The item keys on `text`, one per line; blank lines are skipped, repeats once. */
export function parseItemKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const line of text.split(/\r\n|\r|\n/)) {
    const key = line.trim();
    if (key === "") continue;
    if (!ITEM_KEY.test(key))
      throw new UsageError(`'${key}' is not an item key like ENG-123`);
    keys.add(key);
  }
  return [...keys].sort();
}

/**
 * Each key's state as `open`, `closed` or `not_found`. A lookup that fails,
 * or an issue the tracker reports with no state category, fails the whole
 * answer: a partial map would read an unanswered key as a pass.
 */
export async function itemStates(
  tracker: Pick<Tracker, "poolIssue">,
  keys: readonly string[],
): Promise<Record<string, "open" | "closed" | "not_found">> {
  const states: Record<string, "open" | "closed" | "not_found"> = {};
  let next = 0;
  async function worker(): Promise<void> {
    while (next < keys.length) {
      const key = keys[next++] as string;
      const issue = await tracker.poolIssue(key);
      if (issue === null) states[key] = "not_found";
      else if (issue.state.type === "")
        throw new ItemStateError(
          `${key}: the tracker reported no state category`,
        );
      else
        states[key] = (CLOSED_STATE_TYPES as readonly string[]).includes(
          issue.state.type,
        )
          ? "closed"
          : "open";
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(LOOKUPS_AT_ONCE, keys.length) }, worker),
  );
  return Object.fromEntries(
    Object.entries(states).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** One operation: its positional arguments, its options, what it prints. */
interface Operation {
  /** How many positional arguments it takes, and how usage names them. */
  arity: number;
  takes: string;
  flags?: string[];
  /** Print the result indented, for a person reading a listing. */
  indent?: boolean;
  run: (args: string[], flags: Set<string>) => Promise<unknown>;
}

const OPERATIONS: Record<string, Operation> = {
  states: {
    arity: 0,
    takes: "no argument",
    indent: true,
    run: async () => ownTrackerConfig().states,
  },
  "issue-states": {
    arity: 0,
    takes: "no argument; the item keys come on stdin, one per line",
    indent: true,
    run: async () => {
      const keys = parseItemKeys(await readStdin());
      return itemStates(openTracker(), keys);
    },
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
    run: async ([key]) => {
      const body = await readStdin();
      if (body.trim() === "") throw new UsageError("the comment body is empty");
      await openTracker().postComment(key as string, body);
      return { issue: key, commented: true };
    },
  },
  create: {
    arity: 0,
    takes: "no argument; the issue comes on stdin",
    run: async () => {
      const issue = parseNewIssue(await readStdin());
      return openTracker().createIssue(issue);
    },
  },
  update: {
    arity: 1,
    takes: "one issue key; the patch comes on stdin",
    run: async ([key]) => {
      const patch = parsePatch(key as string, await readStdin());
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

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const op =
    name !== undefined && Object.hasOwn(OPERATIONS, name)
      ? OPERATIONS[name]
      : undefined;
  if (op === undefined)
    return usage(
      name === undefined ? "missing operation" : `unknown operation: ${name}`,
    );
  // `--` ends the options: what follows is positional, so text that starts
  // with `--` can be searched for.
  const end = rest.indexOf("--");
  const options = end === -1 ? rest : rest.slice(0, end);
  const flags = options.filter((a) => a.startsWith("--"));
  const args = [
    ...options.filter((a) => !a.startsWith("--")),
    ...(end === -1 ? [] : rest.slice(end + 1)),
  ];
  const unknown = flags.filter((f) => !(op.flags ?? []).includes(f));
  if (unknown.length > 0) return usage(`unknown option: ${unknown.join(", ")}`);
  if (args.length !== op.arity) return usage(`${name} takes ${op.takes}`);
  try {
    const out = await op.run(args, new Set(flags));
    console.log(JSON.stringify(out, null, op.indent === true ? 2 : undefined));
    return 0;
  } catch (err) {
    if (isUsage(err)) return usage(err.message);
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) runEntry(() => main(process.argv.slice(2)));
