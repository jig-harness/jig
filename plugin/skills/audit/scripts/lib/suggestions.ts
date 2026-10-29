/**
 * The configuration fit's suggestions: a value the detector
 * (`shared/detect.ts`) found that the repository's file leaves unset, with
 * the finding that offers it. Each is offered only when the field is unset,
 * and each carries the evidence it came from.
 */
import {
  changeAreasCatalog,
  type Fact,
  type ForgeRepo,
  issueKeyTeam,
  type KeySource,
  type OpenPull,
  repoSlug,
  stacking,
} from "../../../../shared/detect.ts";
import { at } from "./schema.ts";

/** A value the repository implies for one field, and the fact that shows it. */
export interface Suggestion {
  /** The dotted field, such as `review.bots`. */
  field: string;
  /** The value to set. A list's suggestions for one field add up. */
  value: unknown;
  /** The observable fact the value comes from. */
  evidence: string;
  /** What the audit reports. */
  message: string;
  /** Tells several suggestions for one field apart in their finding ids. */
  key?: string;
  /**
   * The finding's id when the value answers a finding of another kind, such
   * as a contradiction the unset field leaves open; otherwise the id is
   * `suggestion:<field>[:<key>]`.
   */
  id?: string;
}

/** The stable id of a suggestion's finding. */
export function suggestionId(s: Suggestion): string {
  return (
    s.id ?? `suggestion:${s.field}${s.key === undefined ? "" : `:${s.key}`}`
  );
}

/** A detected fact offered as a suggestion, with the audit's `message`. */
export function suggest(
  fact: Fact,
  message: string,
  extra: Pick<Suggestion, "key" | "id"> = {},
): Suggestion {
  return {
    field: fact.field,
    ...(extra.key === undefined ? {} : { key: extra.key }),
    value: fact.value,
    evidence: fact.evidence.join("; "),
    message,
    ...(extra.id === undefined ? {} : { id: extra.id }),
  };
}

/** The suggestions as the detector's facts, for the starter configuration. */
export function suggestedFacts(suggestions: Suggestion[]): Fact[] {
  return suggestions.map((s) => ({
    field: s.field,
    value: s.value,
    evidence: [s.evidence],
  }));
}

/**
 * With `review.repo_slug` unset, the repository the forge names. The field has
 * no default: without it, filing a deferred finding needs `--repo-slug`.
 */
export function repoSlugSuggestion(
  config: Record<string, unknown>,
  repo: ForgeRepo,
): Suggestion[] {
  if (at(config, "review.repo_slug") !== undefined) return [];
  const fact = repoSlug(repo);
  return [
    suggest(
      fact,
      `${fact.evidence.join("; ")}: set review.repo_slug: ${fact.value} so resolve-review-comments files deferred findings against it without --repo-slug`,
    ),
  ];
}

/**
 * With `pull_requests.stacking` unset, `branch` for the open pull requests
 * stacked on another (`stacking` in the detector). The value answers the
 * finding that reports the unset field, and keeps its id and message.
 */
export function stackingSuggestion(
  base: string,
  stacked: OpenPull[],
  finding: { id: string; message: string },
): Suggestion {
  return suggest(stacking(base, stacked), finding.message, { id: finding.id });
}

/**
 * With `issue_tracker.team` unset, the team whose issue keys the repository's
 * history carries most (`issueKeyTeam` in the detector). None for a GitHub
 * tracker, whose keys are issue numbers with no team; with the adapter unset
 * the tracker is GitHub, so the suggestion names the adapter too.
 */
export function trackerTeamSuggestion(
  config: Record<string, unknown>,
  sources: KeySource[],
): Suggestion[] {
  if (at(config, "issue_tracker.team") !== undefined) return [];
  if (at(config, "issue_tracker.adapter") === "github") return [];
  const team = issueKeyTeam(sources);
  if (team === null) return [];
  const evidence = team.evidence.join("; ");
  // An empty `adapter:` (null) is no adapter: the default, which refuses a team.
  const adapter: Suggestion[] =
    at(config, "issue_tracker.adapter") == null
      ? [
          suggest(
            {
              field: "issue_tracker.adapter",
              value: "linear",
              evidence: team.evidence,
            },
            `${evidence}: set issue_tracker.adapter: linear, since the default adapter is github and a team is Linear's`,
          ),
        ]
      : [];
  return [
    ...adapter,
    suggest(
      team,
      `${evidence}: set issue_tracker.team: ${team.value} so the skills recognise them, once you have confirmed it is the tracker's team`,
    ),
  ];
}

/** A tracked file named like a change-area catalog, when none is configured. */
export function catalogSuggestion(
  config: Record<string, unknown>,
  files: string[],
): Suggestion[] {
  if (at(config, "drive.change_areas_catalog") !== undefined) return [];
  const catalog = changeAreasCatalog(files);
  if (catalog === null) return [];
  return [
    suggest(
      catalog,
      `${catalog.value} looks like a change-area catalog: set drive.change_areas_catalog to it so reviews and agent routing use it`,
    ),
  ];
}
