/**
 * The shape of an issue key, per tracker: how a key looks in text, in a
 * branch name and in a file name, and how a key a person typed is read.
 *
 * Linear's keys carry a team (`ENG-123`); GitHub's carry only a number
 * within the repository (`#123`). Every caller that finds, validates or
 * builds a key goes through the `IssueKeys` the configured adapter's shape
 * gives, so a tracker with another shape is a new entry here, not a change
 * to each caller.
 *
 * Reading the shape needs configuration only, never the tracker: a caller
 * that only recognises keys in text works offline.
 */

import { readConfig } from "../../../../../shared/consumer.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { trackerConfigFrom, type TrackerConfig } from "./config.ts";

export interface IssueKeys {
  /** An example key, for messages: `ENG-123`, `#123`. */
  readonly example: string;
  /**
   * Whether a key is a number in the repository's own number space, which
   * its pull requests share (GitHub's `#123` may name either), so a reader
   * of `#<n>` must tell an issue from a pull request by the words around it.
   */
  readonly sharesPullRequestNumbers: boolean;
  /**
   * The source of a pattern matching one key in running text, delimited so
   * it never matches inside a longer token: no anchors, no flags, no
   * capture groups. Wrap it in `^…$` to test a whole string.
   */
  readonly source: string;
  /** Is `s` exactly one key, in canonical form? */
  is(s: string): boolean;
  /**
   * A key as a person may give it, in canonical form: the key itself in
   * any case, and for GitHub a bare number or the issue's web address.
   * `null` when it names no key of this tracker.
   */
  normalize(input: string): string | null;
  /**
   * The source of a pattern matching the key as a branch name carries it
   * (`toBranch`), case-insensitively: no anchors, no capture groups.
   */
  readonly branchSource: string;
  /** The key a `branchSource` match names. */
  fromBranch(matched: string): string;
  /** The branch-name segment for a key: `ENG-123`, `123`. */
  toBranch(key: string): string;
  /** A key as a file or directory name, free of characters a path or URL treats specially. */
  toFileStem(key: string): string;
  /** The key a `toFileStem` result names, or `null`. */
  fromFileStem(stem: string): string | null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Keys of one Linear team: `<TEAM>-<n>`. */
export function teamKeys(team: string): IssueKeys {
  const core = `${escapeRe(team)}-\\d+`;
  const whole = new RegExp(`^${core}$`);
  const loose = new RegExp(`^${core}$`, "i");
  const upper = (s: string) => s.toUpperCase();
  return {
    example: `${team}-123`,
    sharesPullRequestNumbers: false,
    source: `(?<!\\w)${core}(?!\\w)`,
    is: (s) => whole.test(s),
    normalize: (input) => {
      const s = input.trim();
      return loose.test(s) ? upper(s) : null;
    },
    branchSource: core,
    fromBranch: upper,
    toBranch: (key) => key,
    toFileStem: (key) => key,
    fromFileStem: (stem) => (whole.test(stem) ? stem : null),
  };
}

/**
 * Keys of one GitHub repository: `#<n>`. A bare number and the issue's web
 * address on `repository` (`owner/name`, when known) read as the same key.
 * A branch names the number alone (`feature/123-slug`), as GitHub's own
 * branch-from-issue does, and a file the number after `issue-`.
 */
export function numberKeys(repository: string | null): IssueKeys {
  const whole = /^#[1-9]\d*$/;
  const url =
    repository === null
      ? null
      : new RegExp(
          `^https://github\\.com/${escapeRe(repository)}/issues/([1-9]\\d*)(?:[/?#].*)?$`,
          "i",
        );
  return {
    example: "#123",
    sharesPullRequestNumbers: true,
    // Not after a word character (`owner/name#12` names another
    // repository), `&` (an HTML entity) or `#`; not followed by one.
    source: "(?<![\\w&#])#[1-9]\\d*(?!\\w)",
    is: (s) => whole.test(s),
    normalize: (input) => {
      const s = input.trim();
      if (whole.test(s)) return s;
      if (/^[1-9]\d*$/.test(s)) return `#${s}`;
      const m = url?.exec(s);
      return m?.[1] === undefined ? null : `#${m[1]}`;
    },
    branchSource: "[1-9]\\d*",
    fromBranch: (matched) => `#${matched}`,
    toBranch: (key) => key.replace(/^#/, ""),
    toFileStem: (key) => `issue-${key.replace(/^#/, "")}`,
    fromFileStem: (stem) => {
      const m = /^issue-([1-9]\d*)$/.exec(stem);
      return m === null ? null : `#${m[1]}`;
    },
  };
}

/**
 * The key a branch name carries under the branch-name pattern
 * (`pull_requests.branch_name`, whose `{key}` or `{key_lower}` the branch
 * was built from), or `null` when it carries none. The branch must start
 * with the pattern's text before the key, then the key, then a separator
 * (`-`, `_`, `/`, `.`) or the end. For a team key, one leading `<word>/`
 * segment the pattern does not have is allowed, since tools and people
 * prefix branches (`feature/`, a user name); a bare number is not
 * distinctive enough for that (`feature/3-column-layout` names no issue), so
 * a number key is read only where the pattern puts it. A pattern whose key
 * follows the slug cannot be read back, and gives `null`.
 */
export function keyFromBranch(
  branch: string,
  keys: IssueKeys,
  pattern: string,
): string | null {
  const at = pattern.search(/\{key(?:_lower)?\}/);
  if (at < 0) return null;
  const before = pattern.slice(0, at);
  if (before.includes("{")) return null;
  const re = new RegExp(
    `^${keys.sharesPullRequestNumbers ? "" : "(?:[^/]+/)?"}${escapeRe(before)}(${keys.branchSource})(?=[-_/.]|$)`,
    "i",
  );
  const m = re.exec(branch.trim());
  return m?.[1] === undefined ? null : keys.fromBranch(m[1]);
}

/**
 * The key shape of the configured tracker, or `null` when it cannot be
 * known: a Linear tracker with no `issue_tracker.team`.
 */
export function issueKeysOf(config: TrackerConfig): IssueKeys | null {
  if (config.adapter === "github") return numberKeys(config.github.repository);
  return config.team === null ? null : teamKeys(config.team);
}

/**
 * The key shape from every configuration layer, or `null` when none is
 * configured or the configuration cannot be read. For callers that only
 * recognise keys in text and can do without them.
 */
export function issueKeysOrNull(): IssueKeys | null {
  try {
    return issueKeysOf(trackerConfigFrom(readConfig()));
  } catch (err) {
    swallow(err, "the tracker configuration is unreadable, so no key shape");
    return null;
  }
}

/**
 * The shape of `key`, a canonical key of any tracker Jig knows, or `null`
 * when it is none: for naming a file after a key read without the tracker's
 * configuration. A GitHub shape read this way knows no repository.
 */
export function shapeOfKey(key: string): IssueKeys | null {
  if (/^#[1-9]\d*$/.test(key)) return numberKeys(null);
  const team = /^([A-Z][A-Z0-9]*)-\d+$/.exec(key)?.[1];
  return team === undefined ? null : teamKeys(team);
}

/**
 * A team key of any team, in any case (`ENG-123`, `eng-123`): a Linear key
 * given where the team is unknown or another team's key is passed on as is.
 */
export const ANY_TEAM_KEY = /^[A-Z][A-Z0-9]*-\d+$/i;

/**
 * A pattern matching a key of any tracker Jig knows, when the configured
 * one is unknown: a team key of any team, or a GitHub number key. Wider
 * than any one tracker's, so it is for reading text only, never for
 * deciding which issue a branch or a file names.
 */
export const ANY_KEY_SOURCE =
  "(?:(?<!\\w)[A-Z][A-Z0-9]*-\\d+(?!\\w)|(?<![\\w&#])#[1-9]\\d*(?!\\w))";
