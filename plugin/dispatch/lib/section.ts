/**
 * A repository's `dispatch` section, read from the configuration file its
 * default branch holds on the forge. A tick never reads it from a checkout:
 * the tick works beside pull requests' head branches, and a section read
 * there would let an unreviewed change choose what a timer starts.
 */
import { isMapping, parseConfigText } from "../../shared/config-layers.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import {
  parseTrackerConfig,
  type TrackerConfig,
} from "../../skills/do-item/scripts/lib/tracker/config.ts";
import {
  CANONICAL_STATES,
  type CanonicalState,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { parseLabelConfig } from "../../shared/pr-labels/config.ts";
import type { LabelConfig } from "./labels.ts";
import { duration } from "./machine-config.ts";
import { parseOverlap, unknownKeys } from "./overlap-config.ts";
import {
  DEFAULT_REVIEWER_FAILURES_BEFORE_ESCALATION,
  reviewerFailurePolicy,
} from "./reviewer-failure.ts";
import type {
  AdoptRule,
  DispatchSection,
  MissingPriority,
  StalledRelaunch,
  StalledScope,
} from "./types.ts";

const DEFAULT_STATES = ["todo"];
/** The command a follow-up runs where the repository names none: the plugin's own follow-up skill. */
export const DEFAULT_FOLLOWUP_COMMAND = "/jig:followup";
/** `stalled_after` and `blocked_after`'s default. */
const DEFAULT_WAIT_MS = 30 * 60_000;
/** The expectations' defaults: `drive_rounds_flat`, `pickup_within`, `followup_within`. */
const DEFAULT_ROUNDS_FLAT = 3;
const DEFAULT_PICKUP_WITHIN_MS = 2 * 3_600_000;
const DEFAULT_FOLLOWUP_WITHIN_MS = 3_600_000;
/** `pickup_deadline`'s default: an implementation outruns a review pass's deadline. */
export const DEFAULT_PICKUP_DEADLINE_MS = 3 * 3_600_000;
/** `notices_linger`'s default. */
const DEFAULT_NOTICES_LINGER_MS = 3_600_000;
/** `renotify_after`'s default: a day. */
const DEFAULT_RENOTIFY_AFTER_MS = 24 * 3_600_000;
/** `followup_stale_after`'s default: a day. */
const DEFAULT_FOLLOWUP_STALE_AFTER_MS = 24 * 3_600_000;
const KEYS = [
  "identity",
  "person",
  "states",
  "followup_command",
  "stalled_after",
  "stalled_scope",
  "stalled_relaunch",
  "missing_priority",
  "blocked_after",
  "drive_rounds_flat",
  "reviewer_failures_before_escalation",
  "pickup_within",
  "pickup_deadline",
  "followup_within",
  "followup_stale_after",
  "notices_linger",
  "notices_branch",
  "renotify_after",
  "labels",
  "adopt",
  "pool",
  "epic_width",
  "overlap",
];
const ADOPT_KEYS = ["enabled", "authors", "within"];
/** `adopt.within`'s default: a week. */
const DEFAULT_ADOPT_WITHIN_MS = 168 * 3_600_000;

/** `pull_requests.branch_name`'s default, the branch form of an item. */
const BRANCH_PATTERN = "{key_lower}-{slug}";

/** The repository's `pull_requests.branch_name`, from the same configuration as its section. */
export function branchPattern(values: Record<string, unknown>): string {
  const prs = values.pull_requests;
  const pattern =
    typeof prs === "object" && prs !== null
      ? (prs as Record<string, unknown>).branch_name
      : undefined;
  return typeof pattern === "string" && pattern !== ""
    ? pattern
    : BRANCH_PATTERN;
}

/**
 * The tracker configuration of a repository's configuration `values`: GitHub
 * Issues with no repository named are the forge repository `slug`'s own.
 * The tick and `jig send` both derive their tracker here, from the default
 * branch's values.
 */
export function trackerConfigOf(
  values: Record<string, unknown>,
  slug: string,
): TrackerConfig {
  const parsed = parseTrackerConfig(values);
  return parsed.adapter === "github" && parsed.github.repository === null
    ? { ...parsed, github: { ...parsed.github, repository: slug } }
    : parsed;
}

/** A value of the section, or why it does not validate. */
type Checked<T> = Outcome<T, "invalid">;

function invalid(reason: string): Checked<never> {
  return failed("invalid", reason);
}

function text(value: unknown, field: string): Checked<string | null> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== "string" || value.trim() === "")
    return invalid(`dispatch.${field} must be a nonempty string`);
  return ok(value.trim());
}

function states(
  value: unknown,
  tracker: Pick<TrackerConfig, "states">,
  field = "states",
): Checked<string[]> {
  if (value === undefined || value === null) return ok(DEFAULT_STATES);
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((s) => !(CANONICAL_STATES as readonly unknown[]).includes(s))
  )
    return invalid(
      `dispatch.${field} must be a nonempty list of canonical states (${CANONICAL_STATES.join(", ")})`,
    );
  if (new Set(value).size !== value.length)
    return invalid(`dispatch.${field} lists a state twice`);
  // `do-item`'s claim moves an item there: a claimed item is never a pickup.
  if (value.includes("in_progress"))
    return invalid(
      `dispatch.${field} cannot list in_progress, the state do-item's claim moves an item to`,
    );
  // An item there has a pull request open: it is claimed work, never a pickup.
  if (value.includes("pr_open"))
    return invalid(
      `dispatch.${field} cannot list pr_open, the state of an item whose pull request is open`,
    );
  // Only the drive-ledger projection or a person moves an item out of it.
  if (value.includes("blocked"))
    return invalid(
      `dispatch.${field} cannot list blocked, the state of an item whose drive stopped on parked work`,
    );
  const prOpen = tracker.states.pr_open?.trim().toLowerCase();
  const alias =
    prOpen === undefined
      ? undefined
      : (value as string[]).find(
          (state) =>
            tracker.states[state as keyof TrackerConfig["states"]]
              ?.trim()
              .toLowerCase() === prOpen,
        );
  if (alias !== undefined)
    return invalid(
      `dispatch.${field} cannot list ${alias}, which shares the '${tracker.states.pr_open}' state name with pr_open; items there have a pull request open and are never pickups`,
    );
  return ok(value as string[]);
}

function rounds(value: unknown): Checked<number> {
  if (value === undefined || value === null) return ok(DEFAULT_ROUNDS_FLAT);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    return invalid(
      "dispatch.drive_rounds_flat must be a positive whole number",
    );
  return ok(value);
}

function reviewerFailures(value: unknown): Checked<number> {
  if (value === undefined || value === null)
    return ok(DEFAULT_REVIEWER_FAILURES_BEFORE_ESCALATION);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    return invalid(
      "dispatch.reviewer_failures_before_escalation must be a positive whole number",
    );
  return ok(value);
}

function wait(
  value: unknown,
  field: string,
  fallback = DEFAULT_WAIT_MS,
): Checked<number> {
  if (value === undefined || value === null) return ok(fallback);
  return duration(value, `dispatch.${field}`);
}

/** A duration that may also be zero (`0s`, `0m`, `0h`): `notices_linger`, `renotify_after`. */
function orZero(
  value: unknown,
  field: string,
  fallback: number,
): Checked<number> {
  if (typeof value === "string" && /^0+\s*[smh]$/.test(value.trim()))
    return ok(0);
  return wait(value, field, fallback);
}

/** `notices_branch`: a branch name with no space; `null` for the repository's notices workspace. */
function noticesBranch(value: unknown): Checked<string | null> {
  const named = text(value, "notices_branch");
  if (!named.ok) return named;
  if (named.value !== null && /\s/.test(named.value))
    return invalid(
      "dispatch.notices_branch must be a branch name, with no space",
    );
  return named;
}

/** `dispatch.labels`, checked as every writer of the state labels checks it. */
function labels(value: unknown): Checked<LabelConfig> {
  return parseLabelConfig(value);
}

/** `dispatch.adopt.authors`: a nonempty list of logins; `null` (the dispatcher's own login) when absent. */
function authors(value: unknown): Checked<string[] | null> {
  if (value === undefined || value === null) return ok(null);
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((a) => typeof a !== "string" || a.trim() === "" || /\s/.test(a))
  )
    return invalid(
      "dispatch.adopt.authors must be a nonempty list of forge logins, each without spaces",
    );
  return ok(value as string[]);
}

/** `dispatch.adopt`: off unless `enabled`. */
function adoptRule(value: unknown): Checked<AdoptRule> {
  const off: AdoptRule = {
    enabled: false,
    authors: null,
    withinMs: DEFAULT_ADOPT_WITHIN_MS,
  };
  if (value === undefined || value === null) return ok(off);
  if (!isMapping(value)) return invalid("dispatch.adopt must be a mapping");
  const raw = value as Record<string, unknown>;
  const refused = unknownKeys("dispatch.adopt", raw, ADOPT_KEYS);
  if (refused !== null) return refused;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
    return invalid("dispatch.adopt.enabled must be true or false");
  const logins = authors(raw.authors);
  if (!logins.ok) return logins;
  const withinMs = wait(raw.within, "adopt.within", DEFAULT_ADOPT_WITHIN_MS);
  if (!withinMs.ok) return withinMs;
  return ok({
    enabled: raw.enabled === true,
    authors: logins.value,
    withinMs: withinMs.value,
  });
}

/** `dispatch.labels` and `dispatch.adopt`, and what the adoption rule needs of the labels. */
function labelsAndAdopt(
  section: Record<string, unknown>,
): Checked<Pick<DispatchSection, "labels" | "adopt">> {
  const labelConfig = labels(section.labels);
  if (!labelConfig.ok) return labelConfig;
  const adopt = adoptRule(section.adopt);
  if (!adopt.ok) return adopt;
  if (adopt.value.enabled && !labelConfig.value.enabled)
    return invalid(
      "dispatch.adopt needs dispatch.labels.enabled: the rule never adopts a pull request carrying the hold label, which is read only with the labels on",
    );
  if (adopt.value.enabled && labelConfig.value.onlyLabeled)
    return invalid(
      "dispatch.adopt needs dispatch.labels.only_labeled off: under only_labeled a pull request with no label of the set is never read, so none could be adopted",
    );
  return ok({ labels: labelConfig.value, adopt: adopt.value });
}

/** Who picks up work, from which states, and the follow-up's command. */
function pickup(
  section: Record<string, unknown>,
  tracker: Pick<TrackerConfig, "states">,
): Checked<Pick<DispatchSection, "identity" | "states" | "followupCommand">> {
  const identity = text(section.identity, "identity");
  if (!identity.ok) return identity;
  const pickupStates = states(section.states, tracker);
  if (!pickupStates.ok) return pickupStates;
  const followupCommand = text(section.followup_command, "followup_command");
  if (!followupCommand.ok) return followupCommand;
  return ok({
    identity: identity.value,
    states: pickupStates.value,
    followupCommand: followupCommand.value,
  });
}

const POOL_KEYS = ["states"];

/**
 * `dispatch.pool`: the ready pool, unassigned items in its states picked up
 * as the factory identity's. Several hosts may take from one pool, so it
 * requires the claim marker (`do_item.claim_marker`), the token that
 * arbitrates between their claims; and the factory identity, whom the claim
 * assigns and whose claimed items the stall watch reads.
 */
function pool(
  values: Record<string, unknown>,
  section: Record<string, unknown>,
  identity: string | null,
  tracker: Pick<TrackerConfig, "states">,
): Checked<DispatchSection["pool"]> {
  const raw = section.pool;
  if (raw === undefined || raw === null) return ok(undefined);
  if (!isMapping(raw)) return invalid("dispatch.pool must be a mapping");
  const refused = unknownKeys("dispatch.pool", raw, POOL_KEYS);
  if (refused !== null) return refused;
  const named = (raw as Record<string, unknown>).states;
  if (named === undefined || named === null)
    return invalid(
      "dispatch.pool.states must name the states whose unassigned items are pickups",
    );
  const poolStates = states(named, tracker, "pool.states");
  if (!poolStates.ok) return poolStates;
  if (identity === null)
    return invalid(
      "dispatch.pool needs dispatch.identity: a pool pickup's claim assigns the item to the factory identity, whose claimed items the dispatcher watches",
    );
  const item = values.do_item;
  if (
    !isMapping(item) ||
    (item as Record<string, unknown>).claim_marker !== true
  )
    return invalid(
      "dispatch.pool needs do_item.claim_marker: true: several hosts may take an item from one pool, and the claim marker is what decides which of their claims holds it",
    );
  return ok({ states: poolStates.value as CanonicalState[] });
}

/** What `timings` reads: every field but the pickup's own, the rules and the deadline. */
type Timings = Omit<
  DispatchSection,
  | "identity"
  | "states"
  | "followupCommand"
  | "labels"
  | "adopt"
  | "pickupDeadlineMs"
  | "retiredEpicWidth"
  | "overlap"
>;

/** `stalled_scope`: `claimed` unless the section says `assigned`. */
function stalledScope(value: unknown): Checked<StalledScope> {
  if (value === undefined || value === null) return ok("claimed");
  return value === "claimed" || value === "assigned"
    ? ok(value)
    : invalid("dispatch.stalled_scope must be claimed or assigned");
}

/** `stalled_relaunch`: `finish-once` unless the section says `never`. */
function stalledRelaunch(value: unknown): Checked<StalledRelaunch> {
  if (value === undefined || value === null) return ok("finish-once");
  return value === "finish-once" || value === "never"
    ? ok(value)
    : invalid("dispatch.stalled_relaunch must be finish-once or never");
}

/** `missing_priority`: `hold` unless the section says `start`. */
function missingPriority(value: unknown): Checked<MissingPriority> {
  if (value === undefined || value === null) return ok("hold");
  return value === "hold" || value === "start"
    ? ok(value)
    : invalid("dispatch.missing_priority must be hold or start");
}

/** The section's waits and expectations, and where and how often notices go. */
function timings(section: Record<string, unknown>): Checked<Timings> {
  const stalledAfterMs = wait(section.stalled_after, "stalled_after");
  if (!stalledAfterMs.ok) return stalledAfterMs;
  const scope = stalledScope(section.stalled_scope);
  if (!scope.ok) return scope;
  const relaunch = stalledRelaunch(section.stalled_relaunch);
  if (!relaunch.ok) return relaunch;
  const blockedAfterMs = wait(section.blocked_after, "blocked_after");
  if (!blockedAfterMs.ok) return blockedAfterMs;
  const driveRoundsFlat = rounds(section.drive_rounds_flat);
  if (!driveRoundsFlat.ok) return driveRoundsFlat;
  const pickupWithinMs = wait(
    section.pickup_within,
    "pickup_within",
    DEFAULT_PICKUP_WITHIN_MS,
  );
  if (!pickupWithinMs.ok) return pickupWithinMs;
  const followupWithinMs = wait(
    section.followup_within,
    "followup_within",
    DEFAULT_FOLLOWUP_WITHIN_MS,
  );
  if (!followupWithinMs.ok) return followupWithinMs;
  const followupStaleAfterMs = wait(
    section.followup_stale_after,
    "followup_stale_after",
    DEFAULT_FOLLOWUP_STALE_AFTER_MS,
  );
  if (!followupStaleAfterMs.ok) return followupStaleAfterMs;
  const noticesLingerMs = orZero(
    section.notices_linger,
    "notices_linger",
    DEFAULT_NOTICES_LINGER_MS,
  );
  if (!noticesLingerMs.ok) return noticesLingerMs;
  const branch = noticesBranch(section.notices_branch);
  if (!branch.ok) return branch;
  const renotifyAfterMs = orZero(
    section.renotify_after,
    "renotify_after",
    DEFAULT_RENOTIFY_AFTER_MS,
  );
  if (!renotifyAfterMs.ok) return renotifyAfterMs;
  return ok({
    stalledAfterMs: stalledAfterMs.value,
    stalledScope: scope.value,
    stalledRelaunch: relaunch.value,
    blockedAfterMs: blockedAfterMs.value,
    driveRoundsFlat: driveRoundsFlat.value,
    pickupWithinMs: pickupWithinMs.value,
    followupWithinMs: followupWithinMs.value,
    followupStaleAfterMs: followupStaleAfterMs.value,
    noticesLingerMs: noticesLingerMs.value,
    noticesBranch: branch.value,
    renotifyAfterMs: renotifyAfterMs.value,
  });
}

/** What bounds and gates a launch: its deadline, and what a priority-less item does. */
function launchPolicy(
  section: Record<string, unknown>,
): Checked<Pick<DispatchSection, "pickupDeadlineMs" | "missingPriority">> {
  const pickupDeadlineMs = wait(
    section.pickup_deadline,
    "pickup_deadline",
    DEFAULT_PICKUP_DEADLINE_MS,
  );
  if (!pickupDeadlineMs.ok) return pickupDeadlineMs;
  const unranked = missingPriority(section.missing_priority);
  if (!unranked.ok) return unranked;
  return ok({
    pickupDeadlineMs: pickupDeadlineMs.value,
    missingPriority: unranked.value,
  });
}

function trackerOf(values: Record<string, unknown>): Checked<TrackerConfig> {
  try {
    return ok(parseTrackerConfig(values));
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The `dispatch` section of parsed configuration values, with defaults;
 * `invalid`, its reason naming the setting, for the first value that does
 * not validate.
 */
export function dispatchSection(
  values: Record<string, unknown>,
): Checked<DispatchSection> {
  const raw = values.dispatch;
  if (raw !== undefined && raw !== null && !isMapping(raw))
    return invalid("dispatch must be a mapping");
  const section = (raw ?? {}) as Record<string, unknown>;
  const refused = unknownKeys("dispatch", section, KEYS);
  if (refused !== null) return refused;
  const rules = labelsAndAdopt(section);
  if (!rules.ok) return rules;
  const parsed = trackerOf(values);
  if (!parsed.ok) return parsed;
  const tracker = parsed.value;
  const picked = pickup(section, tracker);
  if (!picked.ok) return picked;
  const waits = timings(section);
  if (!waits.ok) return waits;
  const launching = launchPolicy(section);
  if (!launching.ok) return launching;
  const ready = pool(values, section, picked.value.identity, tracker);
  if (!ready.ok) return ready;
  const reviewerFailureThreshold = reviewerFailures(
    section.reviewer_failures_before_escalation,
  );
  if (!reviewerFailureThreshold.ok) return reviewerFailureThreshold;
  const overlap = parseOverlap(section.overlap);
  if (!overlap.ok) return overlap;
  return ok({
    ...(ready.value === undefined ? {} : { pool: ready.value }),
    ...picked.value,
    ...waits.value,
    ...launching.value,
    ...(Object.hasOwn(section, "epic_width")
      ? {
          retiredEpicWidth:
            "dispatch.epic_width is retired and ignored. Use dispatch.overlap to weigh shared files, or use execution plan dependency edges or a serialized area for one child at a time.",
        }
      : {}),
    overlap: overlap.value,
    reviewerFailures: reviewerFailurePolicy(
      values,
      reviewerFailureThreshold.value,
    ),
    labels: rules.value.labels,
    adopt: rules.value.adopt,
  });
}

/**
 * The command a repository's follow-ups run on this host: its
 * `dispatch.followup_command`, else `DEFAULT_FOLLOWUP_COMMAND` where this
 * host's machine file lists `followup` among the repository's `stages`;
 * `null`, no follow-ups, otherwise. The default applies only where the
 * stage is on, so a repository that names no command and runs no
 * follow-up on this host costs no read of its merged pull requests.
 */
export function followupCommandOn(
  section: Pick<DispatchSection, "followupCommand">,
  stages: ReadonlySet<string>,
): string | null {
  if (section.followupCommand !== null) return section.followupCommand;
  return stages.has("followup") ? DEFAULT_FOLLOWUP_COMMAND : null;
}

/**
 * The configuration file's values, and its `dispatch` section. A file that
 * does not parse as configuration is `unreadable`, with the parser's
 * message as the reason; a section that does not validate is `invalid`.
 */
export function readSection(
  file: string | null,
  where: string,
): Outcome<
  { values: Record<string, unknown>; section: DispatchSection },
  "unreadable" | "invalid"
> {
  let values: Record<string, unknown>;
  try {
    values = file === null ? {} : parseConfigText(file, where);
  } catch (error) {
    return failed(
      "unreadable",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  const section = dispatchSection(values);
  return section.ok ? ok({ values, section: section.value }) : section;
}
