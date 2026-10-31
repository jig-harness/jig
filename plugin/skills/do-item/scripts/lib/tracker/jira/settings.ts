/**
 * The Jira adapter's settings, `issue_tracker.jira` in `.config/jig.yaml`:
 *
 *   jira:
 *     site: https://example.atlassian.net   # required
 *     issue_type: Task          # the type a new issue gets
 *     subtask_type: Sub-task    # default: the project's one sub-task type
 *     priorities: { urgent: Highest, high: High, medium: Medium, low: Low }
 *     resolutions: { done: Done, canceled: Won't Do, duplicate: Duplicate }
 *     link_types: { blocks: Blocks, related: Relates, duplicate: Duplicate }
 *
 * The section is parsed whatever the adapter, so a mistyped field is refused
 * before the adapter is chosen; only the Jira adapter requires `site`.
 */

import { isRecord } from "../../../../../../shared/guards.ts";
import { TrackerConfigError } from "../config-error.ts";
import { nonEmpty, settingsSection } from "../settings-fields.ts";
import { PRIORITY_NAMES, type PriorityName } from "../github/settings.ts";

export { PRIORITY_NAMES, type PriorityName };

/** The closed states, which a resolution tells apart. */
export const RESOLVED_STATES = ["done", "canceled", "duplicate"] as const;
export type ResolvedState = (typeof RESOLVED_STATES)[number];

/** The port's relation types, each an issue link type on Jira. */
export const LINKED_RELATIONS = ["blocks", "related", "duplicate"] as const;
export type LinkedRelation = (typeof LINKED_RELATIONS)[number];

export interface JiraSettings {
  /** `https://<name>.atlassian.net`, no trailing slash; `null` = not set. */
  site: string | null;
  issueType: string;
  /** `null` = the project's one sub-task type. */
  subtaskType: string | null;
  priorities: Record<PriorityName, string>;
  resolutions: Record<ResolvedState, string>;
  linkTypes: Record<LinkedRelation, string>;
}

const FIELDS = [
  "site",
  "issue_type",
  "subtask_type",
  "priorities",
  "resolutions",
  "link_types",
];

/** The issue type a new issue gets when none is configured. */
export const DEFAULT_ISSUE_TYPE = "Task";

export const DEFAULT_PRIORITIES: Record<PriorityName, string> = {
  urgent: "Highest",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const DEFAULT_RESOLUTIONS: Record<ResolvedState, string> = {
  done: "Done",
  canceled: "Won't Do",
  duplicate: "Duplicate",
};

export const DEFAULT_LINK_TYPES: Record<LinkedRelation, string> = {
  blocks: "Blocks",
  related: "Relates",
  duplicate: "Duplicate",
};

const field = (name: string) => `issue_tracker.jira.${name}`;

function sectionOf(raw: unknown): Record<string, unknown> {
  return settingsSection(raw, "jira", FIELDS);
}

const SITE = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/;

function siteOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const site = nonEmpty(v, field("site"));
  if (!SITE.test(site))
    throw new TrackerConfigError(
      field("site"),
      `${field("site")} must be the site's https address, such as https://example.atlassian.net (got ${JSON.stringify(site)})`,
    );
  return site.replace(/\/$/, "");
}

/**
 * A mapping of `keys` to names over `defaults`; each name must differ from
 * the others, ignoring case, since two keys named alike read back as one.
 */
function namesOf<K extends string>(
  v: unknown,
  name: string,
  keys: ReadonlyArray<K>,
  defaults: Record<K, string>,
): Record<K, string> {
  const out = { ...defaults };
  if (v !== undefined && v !== null && !isRecord(v))
    throw new TrackerConfigError(
      field(name),
      `${field(name)} must be a mapping`,
    );
  for (const [key, value] of Object.entries(v ?? {})) {
    const at = `${field(name)}.${key}`;
    if (!(keys as readonly string[]).includes(key))
      throw new TrackerConfigError(
        at,
        `${at} is not one of ${keys.join(", ")}`,
      );
    out[key as K] = nonEmpty(value, at);
  }
  const values = keys.map((k) => out[k]);
  const twice = values.find(
    (n, i) =>
      values.findIndex((m) => m.toLowerCase() === n.toLowerCase()) !== i,
  );
  if (twice !== undefined)
    throw new TrackerConfigError(
      field(name),
      `${field(name)} names '${twice}' twice; each needs its own name`,
    );
  return out;
}

/** Validate `issue_tracker.jira`. */
export function parseJiraSettings(raw: unknown): JiraSettings {
  const section = sectionOf(raw);
  return {
    site: siteOf(section.site),
    issueType:
      section.issue_type === undefined || section.issue_type === null
        ? DEFAULT_ISSUE_TYPE
        : nonEmpty(section.issue_type, field("issue_type")),
    subtaskType:
      section.subtask_type === undefined || section.subtask_type === null
        ? null
        : nonEmpty(section.subtask_type, field("subtask_type")),
    priorities: namesOf(
      section.priorities,
      "priorities",
      PRIORITY_NAMES,
      DEFAULT_PRIORITIES,
    ),
    resolutions: namesOf(
      section.resolutions,
      "resolutions",
      RESOLVED_STATES,
      DEFAULT_RESOLUTIONS,
    ),
    linkTypes: namesOf(
      section.link_types,
      "link_types",
      LINKED_RELATIONS,
      DEFAULT_LINK_TYPES,
    ),
  };
}

/** The site; throws naming the field when it is not set. */
export function requireSite(settings: JiraSettings): string {
  if (settings.site === null)
    throw new TrackerConfigError(
      field("site"),
      `${field("site")} is not set; it names the Jira Cloud site, such as https://example.atlassian.net`,
    );
  return settings.site;
}
