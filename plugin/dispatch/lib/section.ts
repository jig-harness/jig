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
import { CANONICAL_STATES } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import {
  DEFAULT_LABELS,
  type LabelConfig,
  LONGEST_NAME,
  MAX_LABEL,
} from "./labels.ts";
import { duration } from "./machine-config.ts";
import type { AdoptRule, DispatchSection } from "./types.ts";

const DEFAULT_STATES = ["todo"];
/** `stalled_after` and `blocked_after`'s default. */
const DEFAULT_WAIT_MS = 30 * 60_000;
/** The expectations' defaults: `drive_rounds_flat`, `pickup_within`, `followup_within`. */
const DEFAULT_ROUNDS_FLAT = 3;
const DEFAULT_PICKUP_WITHIN_MS = 2 * 3_600_000;
const DEFAULT_FOLLOWUP_WITHIN_MS = 3_600_000;
/** `pickup_deadline`'s default: an implementation outruns a review pass's deadline. */
const DEFAULT_PICKUP_DEADLINE_MS = 3 * 3_600_000;
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
  "blocked_after",
  "drive_rounds_flat",
  "pickup_within",
  "pickup_deadline",
  "followup_within",
  "followup_stale_after",
  "notices_linger",
  "notices_branch",
  "renotify_after",
  "labels",
  "adopt",
];
const LABEL_KEYS = ["enabled", "prefix", "only_labeled"];
const ADOPT_KEYS = ["enabled", "authors", "within"];
/** `adopt.within`'s default: a week. */
const DEFAULT_ADOPT_WITHIN_MS = 168 * 3_600_000;
/** A GitHub label is at most 50 characters, and the prefix goes before every name of the set. */
const MAX_PREFIX = MAX_LABEL - LONGEST_NAME;

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

function states(value: unknown): Checked<string[]> {
  if (value === undefined || value === null) return ok(DEFAULT_STATES);
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((s) => !(CANONICAL_STATES as readonly unknown[]).includes(s))
  )
    return invalid(
      `dispatch.states must be a nonempty list of canonical states (${CANONICAL_STATES.join(", ")})`,
    );
  if (new Set(value).size !== value.length)
    return invalid("dispatch.states lists a state twice");
  // `do-item`'s claim moves an item there: a claimed item is never a pickup.
  if (value.includes("in_progress"))
    return invalid(
      "dispatch.states cannot list in_progress, the state do-item's claim moves an item to",
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

function flag(
  value: unknown,
  field: string,
  fallback: boolean,
): Checked<boolean> {
  if (value === undefined || value === null) return ok(fallback);
  if (typeof value !== "boolean")
    return invalid(`dispatch.labels.${field} must be true or false`);
  return ok(value);
}

function prefix(value: unknown): Checked<string> {
  if (value === undefined || value === null) return ok(DEFAULT_LABELS.prefix);
  // `gh pr edit --add-label` splits its value at commas.
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    value.includes(",") ||
    value.length > MAX_PREFIX
  )
    return invalid(
      `dispatch.labels.prefix must be a nonempty string of at most ${MAX_PREFIX} characters, with no comma and no space at either end`,
    );
  // The `automation:` family names the jobs that open pull requests, not dispatch state.
  if (value.startsWith("automation:"))
    return invalid(
      "dispatch.labels.prefix must not start with 'automation:', the family workflows label their pull requests with",
    );
  return ok(value);
}

/** `dispatch.labels`: off unless `enabled`, and `only_labeled` only with it. */
function labels(value: unknown): Checked<LabelConfig> {
  if (value === undefined || value === null) return ok(DEFAULT_LABELS);
  if (!isMapping(value)) return invalid("dispatch.labels must be a mapping");
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((k) => !LABEL_KEYS.includes(k));
  if (unknown.length > 0)
    return invalid(
      `dispatch.labels has unknown key(s): ${unknown.join(", ")} (known: ${LABEL_KEYS.join(", ")})`,
    );
  const enabled = flag(raw.enabled, "enabled", DEFAULT_LABELS.enabled);
  if (!enabled.ok) return enabled;
  const labelPrefix = prefix(raw.prefix);
  if (!labelPrefix.ok) return labelPrefix;
  const onlyLabeled = flag(
    raw.only_labeled,
    "only_labeled",
    DEFAULT_LABELS.onlyLabeled,
  );
  if (!onlyLabeled.ok) return onlyLabeled;
  if (onlyLabeled.value && !enabled.value)
    return invalid(
      "dispatch.labels.only_labeled needs dispatch.labels.enabled: with the labels off, no pull request carries one",
    );
  return ok({
    enabled: enabled.value,
    prefix: labelPrefix.value,
    onlyLabeled: onlyLabeled.value,
  });
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
  const unknown = Object.keys(raw).filter((k) => !ADOPT_KEYS.includes(k));
  if (unknown.length > 0)
    return invalid(
      `dispatch.adopt has unknown key(s): ${unknown.join(", ")} (known: ${ADOPT_KEYS.join(", ")})`,
    );
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
): Checked<Pick<DispatchSection, "identity" | "states" | "followupCommand">> {
  const identity = text(section.identity, "identity");
  if (!identity.ok) return identity;
  const pickupStates = states(section.states);
  if (!pickupStates.ok) return pickupStates;
  const followupCommand = text(section.followup_command, "followup_command");
  if (!followupCommand.ok) return followupCommand;
  return ok({
    identity: identity.value,
    states: pickupStates.value,
    followupCommand: followupCommand.value,
  });
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
>;

/** The section's waits and expectations, and where and how often notices go. */
function timings(section: Record<string, unknown>): Checked<Timings> {
  const stalledAfterMs = wait(section.stalled_after, "stalled_after");
  if (!stalledAfterMs.ok) return stalledAfterMs;
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
  const unknown = Object.keys(section).filter((k) => !KEYS.includes(k));
  if (unknown.length > 0)
    return invalid(
      `dispatch has unknown key(s): ${unknown.join(", ")} (known: ${KEYS.join(", ")})`,
    );
  const rules = labelsAndAdopt(section);
  if (!rules.ok) return rules;
  const picked = pickup(section);
  if (!picked.ok) return picked;
  const waits = timings(section);
  if (!waits.ok) return waits;
  const pickupDeadlineMs = wait(
    section.pickup_deadline,
    "pickup_deadline",
    DEFAULT_PICKUP_DEADLINE_MS,
  );
  if (!pickupDeadlineMs.ok) return pickupDeadlineMs;
  return ok({
    ...picked.value,
    ...waits.value,
    pickupDeadlineMs: pickupDeadlineMs.value,
    labels: rules.value.labels,
    adopt: rules.value.adopt,
  });
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
