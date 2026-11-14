#!/usr/bin/env bun
/**
 * Tracker operations from the command line, through the consumer's tracker
 * (`issue_tracker` in `.config/jig.yaml`).
 *
 * Usage:
 *     bun tracker.ts children <issue-key>
 *     bun tracker.ts transition <issue-key> <canonical-state> [--post-merge]
 *     bun tracker.ts post-merge                   # where the post-merge rule stops
 *     bun tracker.ts claim <issue-key>
 *     bun tracker.ts comment <issue-key> --body-file body.md
 *     bun tracker.ts states                       # canonical → tracker names
 *     bun tracker.ts issue-states                 # item keys on stdin → open/closed
 *     bun tracker.ts labels                       # label role → tracker labels
 *     bun tracker.ts create --input issue.json
 *     bun tracker.ts update <issue-key> --input patch.json
 *     bun tracker.ts search [--include-closed] [--] <text>
 *     bun tracker.ts relations <issue-key>
 *     bun tracker.ts relate <issue-key> <blocks|related|duplicate> <target-key>
 *     bun tracker.ts migrate-relations [--dry-run]
 *     bun tracker.ts sync-plan-blocks <epic-key> [--dry-run]
 *     bun tracker.ts available-labels             # every label issues can carry
 *     bun tracker.ts facet-stores                 # where type, priority and size are kept
 *     bun tracker.ts attachments <issue-key>      # the files attached to an issue
 *     bun tracker.ts attach <issue-key> --input attachment.json
 *     bun tracker.ts fetch-attachment <issue-key> <attachment-id> --out <file>
 *
 * `issue-states` reads item keys, one per line, and prints each key's
 * current state as `open`, `closed` (completed, canceled or duplicate) or
 * `not_found`: the live half of M4's deferral check reads it. A key the
 * tracker answers without a state category, or with one that is neither open
 * (triage, backlog, unstarted, started) nor closed, is an error, never `open`.
 *
 * `claim` starts an issue for the identity the tracker's credential acts
 * as: it refuses an issue already in `in_progress`, in `pr_open` or
 * `blocked`, or assigned to anyone else (exit 3, nothing written), assigns it to that identity and moves it
 * to `in_progress`, then reads it again and stands down (exit 4) when
 * another claim landed first. The reason is printed on stderr and in the
 * JSON on stdout. In a pickup the dispatcher started (`JIG_LAUNCH` names
 * its launch record), a claim that landed is noted on that record, so the
 * dispatcher counts the item as its pickup's however soon the pass ends.
 *
 * Where the repository's default branch sets `do_item.preflight_command`,
 * `claim` first runs it, before the claim lock and any write, with the
 * issue's `get_issue.ts` JSON on standard input: exit 0 goes on; exit 3
 * refuses (exit 3 here, the command's first line of output the reason,
 * `"why": "preflight"` and the item's `updatedAt` in the JSON); any other
 * exit, or a run past its deadline, refuses too. Where the repository sets
 * `do_item.claim_from`, an item in a state outside it, or in a status that
 * maps to no canonical state, is refused (exit 3, `"why": "state"`). With
 * `do_item.claim_marker`, the claim posts the claim marker
 * (`lib/claim-marker.ts`) before it writes, and of the markers on the item
 * the earliest wins (`lib/claim-token.ts`): a claim that finds an earlier
 * one, or cannot post and read back its own, refuses (exit 3,
 * `"why": "marker"`, nothing written to the item), and one that finds an
 * earlier one after it wrote stands down (exit 4). `"marker"` in the JSON
 * says whether the read after the write confirmed it.
 *
 * Canonical states: backlog, todo, in_progress, in_review, done, canceled,
 * and where the consumer uses them triage, pr_open, blocked, ops_pending,
 * duplicate. A transition to an optional state the consumer leaves unset
 * (`pr_open`, `blocked`) writes nothing and prints `skipped` with the reason.
 *
 * `transition … --post-merge` marks the post-merge rule's move: a move to
 * `done` is refused (exit 3, nothing written) when `do_item.post_merge_state`
 * is not `done`. Without the flag, a person's direct move still works.
 * `post-merge` prints that policy: `{ state, closer, closing }`, `closing`
 * being the closing comment's sentence on who closes the item, or `null`.
 *
 * `create` reads `{ title, description?, labels?, type?, priority?, size?,
 * parent?, project? }`; `update` reads `{ title?, description?, type?,
 * priority?, size?, parent?, project?, addLabels?, removeLabels? }`, where
 * `parent: null` removes the parent and `type: null` or `size: null` the
 * value. Labels and the project are named; priority runs from 0 (none) to
 * 4 (low); a type or a size is a value of its facet, written to the store
 * `issue_tracker.facets` keeps it in. A key either does not know is a usage
 * error.
 *
 * `facet-stores` prints where each facet is kept and why, each named
 * store's health, and what detection and the organization's discovery saw;
 * it reads and changes nothing else.
 *
 * `relate <a> duplicate <b>` records `a` as a duplicate of `b` (the tracker
 * may close `a`). `relations` reports each relation from the issue's side:
 * `blocks`, `blocked_by`, `related`, `duplicate` (it is a duplicate of the
 * other) and `duplicated_by` (the other is a duplicate of it).
 *
 * `migrate-relations` converts the relations an adapter once kept as text
 * into the tracker's own (GitHub: the `related` comments become related
 * links and are marked superseded), and reports what it converted; with
 * `--dry-run` it writes nothing. Run it again after a failure: it only does
 * what is left.
 *
 * `attach` attaches a file in the form the tracker offers (`form`: Linear
 * and Jira `upload`; GitHub Issues a `comment` carrying a text file that
 * fits one, or a `link` to the `url` the input names), reading
 * `lib/attachment-ops.ts`'s input; with `replace`, it then removes the
 * older attachments with the same file name or title, once the issue lists
 * the new one, and reports any it kept with the reason. A file the tracker
 * can hold in no form is refused (exit 3, nothing written, the reason in
 * `refused`). `fetch-attachment` writes an attachment's bytes to `--out`;
 * one the tracker only links is refused (exit 3).
 *
 * `sync-plan-blocks` writes the dependency edges of an epic's execution plan
 * as `blocks` relations the tracker lacks, so a dependency is stated in both
 * places; run it after the plan is written.
 *
 * Output: JSON on stdout. Exit codes: 0 done, 2 usage (input the operation
 * cannot take), 1 the operation failed (the reason on stderr), a label,
 * project or issue that does not resolve to exactly one included; for
 * `claim`, 3 refused and 4 stood down; for `attach` and `fetch-attachment`,
 * 3 refused. A call to the tracker that failed exits with its failure class
 * (`shared/outbound/failure.ts`, `EXIT_OF_CLASS`), the reason on stderr
 * after the class: 5 `rate-limited`, the credential's rate limit spent, with
 * the time it resets on stderr (`RATE-LIMITED until <time>`): the request it
 * names was not sent or was refused; 6 `unreachable`, no answer (stderr
 * adds "the request may have been applied" when it left); 7 `too-costly`;
 * 8 `server-fault`; 9 `unauthorized`; 10 `not-found`; 11 `invalid`. 5, 6,
 * 7 and 8 clear by waiting. A claim refused part way may have written its
 * first step; the dispatcher's stall check then reports the item as claimed
 * with no session.
 */

import { jiraStateMaps } from "./lib/tracker/jira/state-maps.ts";
import { readFile } from "node:fs/promises";
import { isRateLimited } from "../../../shared/tracker-budget.ts";
import {
  type FailureClass,
  failureOf,
  OutboundError,
} from "../../../shared/outbound/failure.ts";
import { claimServedIssue } from "./lib/served-claim.ts";
import { withClaimLock } from "./lib/claim-lock.ts";
import { claimIssue } from "./lib/claim.ts";
import { blockedClaimRefusal } from "./lib/blocked-claim.ts";
import { getIssue } from "./get_issue.ts";
import {
  claimPreflightCommand,
  preflightClaim,
  unreadablePreflight,
} from "./lib/preflight.ts";
import {
  claimPlanBlockFromDefaultBranch,
  claimSettingsFromDefaultBranch,
} from "./lib/claim-settings.ts";
import { claimBranch, claimSession } from "./lib/claim-marker.ts";
import { claimWithMarker } from "./lib/claim-token.ts";
import {
  NOT_DISPATCHED,
  notePickupClaim,
} from "../../../dispatch/lib/pickup-claim.ts";
import { consumerRoot, readOverlay } from "../../../shared/consumer.ts";
import { syncPlanBlocks } from "./lib/plan-blocks.ts";
import { executionPlanBlock } from "./select_execution_issue.ts";
import { runEntry } from "./lib/cli.ts";
import { ATTACHMENT_OPERATIONS } from "./lib/attachment-ops.ts";
import { ownTrackerConfig } from "./lib/tracker/config.ts";
import { closerSentence, parsePostMerge } from "./lib/post-merge.ts";
import { issueKeysOf, ANY_KEY_SOURCE } from "./lib/tracker/keys.ts";
import {
  CANONICAL_STATES,
  type CanonicalState,
  openTracker,
} from "./lib/tracker/index.ts";
import {
  CLOSED_STATE_TYPES,
  type IssuePatch,
  type NewIssue,
  OPEN_STATE_TYPES,
  RELATION_TYPES,
  type RelationType,
  type Tracker,
  TrackerRequestError,
} from "./lib/tracker/port.ts";
import { labelsAsConfig } from "../../../shared/tracker-labels.ts";

const USAGE = `usage:
  tracker.ts children <issue-key>
  tracker.ts transition <issue-key> <canonical-state>
  tracker.ts claim <issue-key>
  tracker.ts comment <issue-key>   (body on stdin)
  tracker.ts states
  tracker.ts issue-states          (item keys on stdin, one per line)
  tracker.ts labels
  tracker.ts create                (new issue as JSON on stdin)
  tracker.ts update <issue-key>    (patch as JSON on stdin)
  tracker.ts search [--include-closed] [--] <text>   (-- ends the options)
  tracker.ts relations <issue-key>
  tracker.ts relate <issue-key> <${RELATION_TYPES.join("|")}> <target-key>
  tracker.ts migrate-relations [--dry-run]
  tracker.ts sync-plan-blocks <epic-key> [--dry-run]
  tracker.ts available-labels
  tracker.ts facet-stores
  tracker.ts attachments <issue-key>
  tracker.ts attach <issue-key>    (attachment as JSON on stdin)
  tracker.ts fetch-attachment <issue-key> <attachment-id> --out <file>`;

/** The machine-local claim mutex identity for one canonical tracker issue. */
export function claimLockKey(
  tracker: Pick<Tracker, "adapter" | "team">,
  issue: string,
): string {
  const namespace =
    tracker.adapter === "github" ? tracker.team.toLowerCase() : tracker.team;
  return `${tracker.adapter}:${namespace}:${issue}`;
}

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
const FACET_VALUE: Kind = {
  ok: (v) => typeof v === "string" && v.trim() !== "",
  want: "a nonempty value of the facet",
};
const FACET_CHANGE: Kind = {
  ok: (v) => v === null || FACET_VALUE.ok(v),
  want: "a nonempty value of the facet, or null to remove it",
};

const NEW_ISSUE_FIELDS: Record<string, Kind> = {
  title: TEXT,
  description: TEXT,
  labels: LABEL_NAMES,
  type: FACET_VALUE,
  priority: PRIORITY,
  size: FACET_VALUE,
  parent: TEXT,
  project: TEXT,
};

const PATCH_FIELDS: Record<string, Kind> = {
  title: TEXT,
  description: TEXT,
  type: FACET_CHANGE,
  priority: PRIORITY,
  size: FACET_CHANGE,
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

/**
 * The shape of an item key on any tracker (`ENG-123`, `#123`), in any case:
 * the keys come from documents, which may predate the configured tracker.
 */
const ITEM_KEY = new RegExp(`^${ANY_KEY_SOURCE}$`, "i");

/** How many keys are looked up at once. */
const LOOKUPS_AT_ONCE = 4;

/** The item keys on `text`, one per line; blank lines are skipped, repeats once. */
export function parseItemKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const line of text.split(/\r\n|\r|\n/)) {
    const key = line.trim();
    if (key === "") continue;
    if (!ITEM_KEY.test(key))
      throw new UsageError(`'${key}' is not an item key like ENG-123 or #123`);
    keys.add(key);
  }
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Each key's state as `open`, `closed` or `not_found`. A lookup that fails,
 * or an issue the tracker reports with no state category or one it does not
 * know, fails the whole answer: a partial map would read an unanswered key as
 * a pass, and an unknown category read as open would do the same.
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
      if (issue === null) {
        states[key] = "not_found";
        continue;
      }
      const type = issue.state.type;
      if ((CLOSED_STATE_TYPES as readonly string[]).includes(type))
        states[key] = "closed";
      else if ((OPEN_STATE_TYPES as readonly string[]).includes(type))
        states[key] = "open";
      else
        throw new ItemStateError(
          type === ""
            ? `${key}: the tracker reported no state category`
            : `${key}: the tracker reported the state category ${JSON.stringify(type)}, which is neither open nor closed`,
        );
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(LOOKUPS_AT_ONCE, keys.length) }, worker),
  );
  return Object.fromEntries(
    Object.entries(states).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** One operation: its positional arguments, its options, what it prints. */
interface Operation {
  /** How many positional arguments it takes, and how usage names them. */
  arity: number;
  takes: string;
  flags?: string[];
  input?: "input" | "body-file" | "out";
  /** Print the result indented, for a person reading a listing. */
  indent?: boolean;
  run: (args: string[], flags: Set<string>, input?: string) => Promise<unknown>;
  /** The exit code for what `run` returned, when it is not always 0. */
  exitOf?: (out: unknown) => number;
}

/**
 * `claim`: the repository's start rules (its preflight command, before the
 * lock and any write), then the claim itself, served or plain, then the
 * claim marker where the repository asks for one.
 */
async function claim(
  key: string,
  person: string | undefined,
  ancestor: string | undefined,
  blocking: string | undefined,
): Promise<unknown> {
  const config = ownTrackerConfig();
  const shape = issueKeysOf(config);
  const normalized = shape?.normalize(key) ?? key;
  const tracker = openTracker();
  const overlay = readOverlay();
  // A post-merge policy the issue link cannot honour is refused before the claim writes.
  parsePostMerge(overlay);
  const root = consumerRoot();
  const read = await claimSettingsFromDefaultBranch(root, overlay);
  if (!read.ok) return unreadablePreflight(normalized, read.failure.reason);
  const settings = read.value;
  // Only a pulled-blocker claim enforces the epic plan; any other claim never reads it.
  const planBlock =
    person && blocking ? await claimPlanBlockFromDefaultBranch(root) : null;
  if (planBlock !== null && !planBlock.ok)
    return unreadablePreflight(normalized, planBlock.failure.reason);
  // Before the lock and before any write: a refusal leaves nothing behind.
  const command = await claimPreflightCommand(root, overlay);
  if (!command.ok)
    return unreadablePreflight(normalized, command.failure.reason);
  const refusal =
    command.value === null
      ? null
      : await preflightClaim(root, command.value, normalized, () =>
          getIssue(normalized, tracker, shape),
        );
  if (refusal !== null) return refusal;
  const blocked = await blockedClaimRefusal(tracker, normalized);
  if (blocked !== null) return blocked;
  const result = await withClaimLock(
    claimLockKey(tracker, normalized),
    async () => {
      // The projection may have blocked the item while the claim waited for the lock.
      const stale = await blockedClaimRefusal(tracker, normalized);
      if (stale !== null) return stale;
      const ancestorKey = ancestor
        ? (shape?.normalize(ancestor) ?? ancestor)
        : undefined;
      const body = () =>
        person
          ? claimServedIssue(tracker, normalized, {
              person,
              ...(ancestorKey ? { ancestor: ancestorKey } : {}),
              ...(blocking
                ? { blocking: shape?.normalize(blocking) ?? blocking }
                : {}),
              hitlLabel: config.labels.hitl,
              manualOpsLabel: config.labels.manualOps,
              ...(planBlock?.ok && planBlock.value !== undefined
                ? { executionPlanBlock: planBlock.value }
                : {}),
              claimFrom: settings.claimFrom,
            })
          : claimIssue(tracker, normalized, { claimFrom: settings.claimFrom });
      if (!settings.claimMarker) return body();
      // The marker names who the item will be assigned to, before it is.
      const claimant = person
        ? (await tracker.user(person)).name
        : (await tracker.viewer()).name;
      return claimWithMarker(
        tracker,
        normalized,
        { session: claimSession(), branch: await claimBranch(root), claimant },
        body,
      );
    },
  );
  if (result.outcome === "claimed") noteDispatchedClaim(result.issue);
  return result;
}

/**
 * In a pickup the dispatcher started, note the claim on its launch record, so
 * the dispatcher counts the item as its pickup's however soon the pass ends.
 * A failed note leaves the claim standing: it is reported beside it.
 */
function noteDispatchedClaim(issue: string): void {
  const noted = notePickupClaim(issue);
  if (!noted.ok)
    console.error(
      `the claim of ${issue} was not noted for the dispatcher: ${noted.failure.reason}`,
    );
  else if (!noted.value.noted && noted.value.why !== NOT_DISPATCHED)
    console.error(
      `the claim of ${issue} was not noted for the dispatcher: ${noted.value.why}`,
    );
}

/** `claim`'s exit codes: refused before any write, stood down after the re-read. */
const CLAIM_EXIT = { claimed: 0, refused: 3, stood_down: 4 } as const;

const OPERATIONS: Record<string, Operation> = {
  states: {
    arity: 0,
    takes: "no argument",
    indent: true,
    run: async () => {
      const config = ownTrackerConfig();
      const byType =
        config.adapter === "jira"
          ? jiraStateMaps(config.states, config.jira)
          : {};
      return Object.keys(byType).length === 0
        ? config.states
        : { ...config.states, states_by_type: byType };
    },
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
    flags: ["--post-merge"],
    run: async ([key, state], flags) => {
      if (!(CANONICAL_STATES as readonly string[]).includes(state as string))
        throw new UsageError(
          `'${state}' is not a canonical state (${CANONICAL_STATES.join(", ")})`,
        );
      if (flags.has("--post-merge")) {
        const policy = parsePostMerge(readOverlay());
        if (state === "done" && policy.state !== "done") {
          const refused = `do_item.post_merge_state is ${policy.state}: the post-merge rule stops at ${policy.state} and a person closes ${key}`;
          console.error(refused);
          return { issue: key, state, refused };
        }
      }
      const tracker = openTracker();
      const issue =
        tracker.adapter === "jira"
          ? await tracker.getIssue(key as string)
          : null;
      if (tracker.adapter === "jira" && issue === null)
        throw new TrackerRequestError(
          "unresolved",
          `issue ${key} does not exist`,
        );
      const name =
        issue === null
          ? tracker.stateName(state as CanonicalState)
          : tracker.stateName(state as CanonicalState, issue);
      if (name === null)
        return {
          issue: key,
          state,
          name,
          skipped: `${issue?.nativeType == null ? "issue_tracker.states" : `issue_tracker.jira.states_by_type.${issue.nativeType}`}.${state} is not set`,
        };
      await tracker.transition(key as string, state as CanonicalState);
      return { issue: key, state, name };
    },
    exitOf: (out) =>
      typeof out === "object" && out !== null && "refused" in out ? 3 : 0,
  },
  "post-merge": {
    arity: 0,
    takes: "no argument",
    run: async () => {
      const policy = parsePostMerge(readOverlay());
      return { ...policy, closing: closerSentence(policy) };
    },
  },
  claim: {
    arity: 1,
    takes: "one issue key",
    run: async ([key], flags) => {
      const forFlags = [...flags].filter((f) => f.startsWith("--for"));
      const ancestorFlags = [...flags].filter((f) =>
        f.startsWith("--ancestor"),
      );
      const blockingFlags = [...flags].filter((f) =>
        f.startsWith("--blocking"),
      );
      if (
        forFlags.some((f) => !f.startsWith("--for=") || f.length === 6) ||
        ancestorFlags.some(
          (f) => !f.startsWith("--ancestor=") || f.length === 11,
        ) ||
        blockingFlags.some(
          (f) => !f.startsWith("--blocking=") || f.length === 11,
        ) ||
        forFlags.length > 1 ||
        ancestorFlags.length > 1 ||
        blockingFlags.length > 1
      )
        throw new UsageError(
          "claim accepts one nonempty --for=PERSON, --ancestor=ISSUE and --blocking=ISSUE",
        );
      const person = forFlags[0]?.slice(6);
      const ancestor = ancestorFlags[0]?.slice(11);
      const blocking = blockingFlags[0]?.slice(11);
      if ((ancestor || blocking) && !person)
        throw new UsageError("--ancestor and --blocking require --for");
      return claim(key as string, person, ancestor, blocking);
    },
    exitOf: (out) => {
      const result = out as Awaited<ReturnType<typeof claimIssue>>;
      if (result.outcome !== "claimed") console.error(result.reason);
      return CLAIM_EXIT[result.outcome];
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
  "migrate-relations": {
    arity: 0,
    takes: "no argument",
    flags: ["--dry-run"],
    indent: true,
    run: async (_args, flags) => {
      const tracker = openTracker();
      if (tracker.migrateRelations === undefined)
        throw new UsageError(
          `the ${tracker.adapter} adapter keeps every relation in the tracker's own, so there is nothing to migrate`,
        );
      return tracker.migrateRelations({ dryRun: flags.has("--dry-run") });
    },
    exitOf: (out) => {
      const report = out as { unresolved?: unknown[]; unmarked?: unknown[] };
      return (report.unresolved?.length ?? 0) > 0 ||
        (report.unmarked?.length ?? 0) > 0
        ? 1
        : 0;
    },
  },
  "sync-plan-blocks": {
    arity: 1,
    takes: "one epic key",
    flags: ["--dry-run"],
    indent: true,
    run: ([epic], flags) =>
      syncPlanBlocks(openTracker(), epic as string, {
        block: executionPlanBlock(),
        dryRun: flags.has("--dry-run"),
      }),
  },
  "available-labels": {
    arity: 0,
    takes: "no argument",
    indent: true,
    run: () => openTracker().listLabels(),
  },
  "facet-stores": {
    arity: 0,
    takes: "no argument",
    indent: true,
    run: () => openTracker().facetStores(),
  },
  ...ATTACHMENT_OPERATIONS,
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
  const unknown = flags.filter(
    (flag) =>
      !allowed.has(flag) &&
      !(
        name === "claim" &&
        (/^--for=.+/.test(flag) ||
          /^--ancestor=.+/.test(flag) ||
          /^--blocking=.+/.test(flag))
      ),
  );
  if (unknown.length)
    throw new UsageError(`unknown option: ${unknown.join(", ")}`);
  if (args.length !== op.arity)
    throw new UsageError(`${name} takes ${op.takes}`);
  return { args, flags: new Set(flags) };
}

/** The exit code of an operation a failed call to the tracker stopped, by its failure class. */
export const EXIT_OF_CLASS: Readonly<Record<FailureClass, number>> = {
  "rate-limited": 5,
  unreachable: 6,
  "too-costly": 7,
  "server-fault": 8,
  unauthorized: 9,
  "not-found": 10,
  invalid: 11,
};

/** The exit code and the error line of a failure: by its class when a call to the tracker failed, else 1. */
export function failureExit(error: unknown): { code: number; line: string } {
  const failure =
    isRateLimited(error) || error instanceof OutboundError
      ? failureOf(error)
      : null;
  if (failure?.code === "rate-limited")
    return {
      code: EXIT_OF_CLASS["rate-limited"],
      line: `RATE-LIMITED until ${new Date(failure.until ?? Date.now()).toISOString()}: ${failure.reason}`,
    };
  if (failure !== null) {
    const lost =
      failure.sent === true ? " (the request may have been applied)" : "";
    return {
      code: EXIT_OF_CLASS[failure.code],
      line: `${failure.code.toUpperCase()}: ${failure.reason}${lost}`,
    };
  }
  return {
    code: 1,
    line: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function reportFailure(error: unknown): number {
  if (isUsage(error)) return usage(error.message);
  const { code, line } = failureExit(error);
  console.error(line);
  return code;
}

/** Normalize valued claim options before generic positional/flag validation. */
function normalizeClaimOptions(rest: string[]): void {
  for (const flag of ["--for", "--ancestor", "--blocking"]) {
    const index = rest.indexOf(flag);
    if (index === -1) continue;
    const value = rest[index + 1];
    if (!value || value.startsWith("--"))
      throw new UsageError(`${flag} requires an identity or issue key`);
    rest.splice(index, 2, `${flag}=${value}`);
  }
  for (const flag of ["--for=", "--ancestor=", "--blocking="])
    if (rest.filter((v) => v.startsWith(flag)).length > 1)
      throw new UsageError("duplicate claim option");
}

export async function main(argv: string[]): Promise<number> {
  try {
    const [name, ...rest] = argv;
    const op = operationNamed(name);
    if (name === "claim") normalizeClaimOptions(rest);
    const input = inputFile(op, rest);
    const { args, flags } = operationArguments(op, name as string, rest);
    const out = await op.run(args, flags, input);
    console.log(JSON.stringify(out, null, op.indent === true ? 2 : undefined));
    return op.exitOf?.(out) ?? 0;
  } catch (error) {
    return reportFailure(error);
  }
}

if (import.meta.main) runEntry(() => main(process.argv.slice(2)));
