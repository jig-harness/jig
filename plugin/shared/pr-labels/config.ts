/**
 * `dispatch.labels`, checked in one place: the dispatcher's section reader
 * (`dispatch/lib/section.ts`) checks it with the rest of the section, and
 * every writer of the pull request state labels (the drive, the follow-up
 * and the dispatcher's tick) reads it from the repository's default branch
 * through that reader (`dispatch/lib/label-config.ts`). A repository with no
 * dispatcher turns the labels on with the same setting.
 */
import { isMapping } from "../config-layers.ts";
import { failed, ok, type Outcome } from "../outcome.ts";
import {
  DEFAULT_LABELS,
  type LabelConfig,
  LONGEST_NAME,
  MAX_LABEL,
} from "./projection.ts";

/** A GitHub label is at most 50 characters, and the prefix goes before every name of the set. */
const MAX_PREFIX = MAX_LABEL - LONGEST_NAME;

const LABEL_KEYS = ["enabled", "prefix", "only_labeled"];

type Checked<T> = Outcome<T, "invalid">;

function invalid(reason: string): Checked<never> {
  return failed("invalid", reason);
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
  // The `automation:` family names the jobs that open pull requests, not pull request state.
  if (value.startsWith("automation:"))
    return invalid(
      "dispatch.labels.prefix must not start with 'automation:', the family workflows label their pull requests with",
    );
  return ok(value);
}

/** `dispatch.labels`: off unless `enabled`, and `only_labeled` only with it. */
export function parseLabelConfig(value: unknown): Checked<LabelConfig> {
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
