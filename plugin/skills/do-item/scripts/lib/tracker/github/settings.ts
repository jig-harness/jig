/**
 * The GitHub adapter's settings, `issue_tracker.github` in
 * `.config/jig.yaml`; every field is optional:
 *
 *   github:
 *     repository: owner/name   # default: the `origin` remote's repository
 *     states_from: labels      # or `project`, a board's Status field
 *     project: https://github.com/orgs/owner/projects/1
 *     status_field: Status
 *     priority_labels: { urgent: …, high: …, medium: …, low: … }
 */

import { isRecord } from "../../../../../../shared/guards.ts";
import { TrackerConfigError } from "../config-error.ts";

/** Where the GitHub adapter keeps an open issue's workflow state. */
export const GITHUB_STATE_SOURCES = ["labels", "project"] as const;
export type GitHubStateSource = (typeof GITHUB_STATE_SOURCES)[number];
export const DEFAULT_STATES_FROM: GitHubStateSource = "labels";

/** The board field that holds the state when none is named. */
export const DEFAULT_STATUS_FIELD = "Status";

/** The priorities a label stands for, 1 (urgent) to 4 (low), by name. */
export const PRIORITY_NAMES = ["urgent", "high", "medium", "low"] as const;
export type PriorityName = (typeof PRIORITY_NAMES)[number];

/** A GitHub Projects board, as its web address names it. */
export interface GitHubProject {
  url: string;
  ownerType: "organization" | "user";
  owner: string;
  number: number;
}

export interface GitHubSettings {
  /** `owner/name`; `null` = the repository the `origin` remote points to. */
  repository: string | null;
  statesFrom: GitHubStateSource;
  /** Required when `statesFrom` is `project`. */
  project: GitHubProject | null;
  /** The board's single-select field that holds the state. */
  statusField: string;
  /** The label that carries each priority. */
  priorityLabels: Record<PriorityName, string>;
}

const FIELDS = [
  "repository",
  "states_from",
  "project",
  "status_field",
  "priority_labels",
];
const REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const PROJECT_URL =
  /^https:\/\/github\.com\/(orgs|users)\/([A-Za-z0-9-]+)\/projects\/([1-9]\d*)\/?$/;

const field = (name: string) => `issue_tracker.github.${name}`;

/** A priority label's default: `priority: urgent` and so on. */
export function defaultPriorityLabel(name: PriorityName): string {
  return `priority: ${name}`;
}

function nonEmpty(v: unknown, at: string): string {
  if (typeof v !== "string" || v.trim() === "")
    throw new TrackerConfigError(at, `${at} must be a nonempty string`);
  return v;
}

function sectionOf(raw: unknown): Record<string, unknown> {
  if (raw !== undefined && raw !== null && !isRecord(raw))
    throw new TrackerConfigError(
      "issue_tracker.github",
      "issue_tracker.github must be a mapping",
    );
  const section = (raw ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(section).find((k) => !FIELDS.includes(k));
  if (unknown !== undefined)
    throw new TrackerConfigError(
      field(unknown),
      `${field(unknown)} is not a field (${FIELDS.join(", ")})`,
    );
  return section;
}

function repositoryOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !REPOSITORY_PATTERN.test(v))
    throw new TrackerConfigError(
      field("repository"),
      `${field("repository")} must be owner/name (got ${JSON.stringify(v)})`,
    );
  return v;
}

function statesFromOf(v: unknown): GitHubStateSource {
  const value = v ?? DEFAULT_STATES_FROM;
  if (!(GITHUB_STATE_SOURCES as readonly unknown[]).includes(value))
    throw new TrackerConfigError(
      field("states_from"),
      `${field("states_from")} must be one of ${GITHUB_STATE_SOURCES.join(", ")} (got ${JSON.stringify(value)})`,
    );
  return value as GitHubStateSource;
}

function projectOf(v: unknown): GitHubProject | null {
  if (v === undefined || v === null) return null;
  const url = nonEmpty(v, field("project"));
  const m = PROJECT_URL.exec(url);
  if (m === null)
    throw new TrackerConfigError(
      field("project"),
      `${field("project")} must be a board's web address, https://github.com/orgs/<org>/projects/<n> or https://github.com/users/<user>/projects/<n> (got ${JSON.stringify(url)})`,
    );
  return {
    url,
    ownerType: m[1] === "orgs" ? "organization" : "user",
    owner: m[2] as string,
    number: Number(m[3]),
  };
}

/** The configured priority labels over the defaults; each must differ. */
function priorityLabelsOf(v: unknown): Record<PriorityName, string> {
  const labels = Object.fromEntries(
    PRIORITY_NAMES.map((p) => [p, defaultPriorityLabel(p)]),
  ) as Record<PriorityName, string>;
  if (v !== undefined && v !== null && !isRecord(v))
    throw new TrackerConfigError(
      field("priority_labels"),
      `${field("priority_labels")} must be a mapping`,
    );
  for (const [key, name] of Object.entries(v ?? {})) {
    const at = `${field("priority_labels")}.${key}`;
    if (!(PRIORITY_NAMES as readonly string[]).includes(key))
      throw new TrackerConfigError(
        at,
        `${at} is not a priority (${PRIORITY_NAMES.join(", ")})`,
      );
    labels[key as PriorityName] = nonEmpty(name, at);
  }
  const names = PRIORITY_NAMES.map((p) => labels[p]);
  const twice = names.find(
    (n, i) => names.findIndex((m) => m.toLowerCase() === n.toLowerCase()) !== i,
  );
  if (twice !== undefined)
    throw new TrackerConfigError(
      field("priority_labels"),
      `${field("priority_labels")} names '${twice}' twice; each priority needs its own label`,
    );
  return labels;
}

/** Validate `issue_tracker.github`. */
export function parseGitHubSettings(raw: unknown): GitHubSettings {
  const section = sectionOf(raw);
  const statesFrom = statesFromOf(section.states_from);
  const project = projectOf(section.project);
  if (statesFrom === "project" && project === null)
    throw new TrackerConfigError(
      field("states_from"),
      `${field("states_from")} is project, so ${field("project")} must name the board`,
    );
  return {
    repository: repositoryOf(section.repository),
    statesFrom,
    project,
    statusField:
      section.status_field === undefined
        ? DEFAULT_STATUS_FIELD
        : nonEmpty(section.status_field, field("status_field")),
    priorityLabels: priorityLabelsOf(section.priority_labels),
  };
}
