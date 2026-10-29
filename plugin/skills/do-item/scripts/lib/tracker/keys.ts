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
 * Reading the shape needs configuration only (and, for GitHub, possibly the
 * repository's git remote), never the tracker: a caller that only recognises keys
 * in text works offline.
 */

import { readConfig } from "../../../../../shared/consumer.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { trackerConfigFrom, type TrackerConfig } from "./config.ts";
import { remoteUrl, repoFromRemote, slug } from "./github/refs.ts";

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
 * with the pattern's text before the key, then the key, then the pattern's
 * text after it, a separator (`-`, `_`, `/`, `.`) or the end. For a team
 * key, one leading `<word>/` segment the pattern does not have is allowed,
 * since tools and people prefix branches (`feature/`, a user name); a bare
 * number is not distinctive enough for that (`feature/3-column-layout`
 * names no issue), so a number key is read only where the pattern puts it.
 * When the key follows the slug (`{slug}-{key}`), the whole branch must
 * match the pattern as rendered, with a slug or with an empty one (a title
 * with no Latin letters or digits), and the key is the last place it fits.
 * The pattern is read as rendered (`tidyBranchName`), and a pattern
 * `branchPatternAmbiguity` refuses names no key.
 */
export function keyFromBranch(
  branch: string,
  keys: IssueKeys,
  pattern: string,
): string | null {
  const tidy = tidyBranchName(pattern);
  if (branchPatternAmbiguity(tidy) !== null) return null;
  const at = tidy.search(/\{key(?:_lower)?\}/);
  if (at < 0) return null;
  const before = tidy.slice(0, at);
  const name = branch.trim();
  const shapes = [tidy, tidyBranchName(tidy.replace("{slug}", ""))];
  if (!before.includes("{")) {
    // The pattern's text after the key, as rendered with a slug and without.
    const after = shapes.map((shape) =>
      escapeRe(
        /^[^{]*/.exec(shape.slice(shape.indexOf("}", at) + 1))?.[0] ?? "",
      ),
    );
    const m = new RegExp(
      `^${keys.sharesPullRequestNumbers ? "" : "(?:[^/]+/)?"}${escapeRe(before)}(${keys.branchSource})(?=[-_/.]|$${after.map((a) => (a === "" ? "" : `|${a}`)).join("")})`,
      "i",
    ).exec(name);
    return m?.[1] === undefined ? null : keys.fromBranch(m[1]);
  }
  const found = new Set<string>();
  for (const shape of shapes) {
    const m = new RegExp(`^${wholePattern(shape, keys)}$`, "i").exec(name);
    if (m?.[1] !== undefined) found.add(keys.fromBranch(m[1]));
  }
  return found.size === 1 ? ([...found][0] ?? null) : null;
}

/**
 * Why the branches a pattern renders cannot all be read back to their key,
 * or `null` when they can: two placeholders side by side, more than one
 * `{slug}`, or a digit beside a key. Every key ends in digits and a number
 * key is nothing else, so a digit beside one moves where the key ends or
 * starts (`{slug}1{key}` renders `fix112` for #12, which reads as #2 as
 * well). Read on the pattern as written or as tidied alike.
 */
export function branchPatternAmbiguity(pattern: string): string | null {
  if (pattern.includes("}{")) return "puts two placeholders side by side";
  if (pattern.split("{slug}").length > 2) return "uses {slug} more than once";
  if (/\d\{key(?:_lower)?\}|\{key(?:_lower)?\}\d/.test(pattern))
    return "puts a digit beside the key";
  return null;
}

/**
 * A branch name as the renderer leaves it: each run of `-` made one, and
 * trailing `-` and `/` dropped. A pattern tidied the same way is the shape
 * every branch rendered from it with a nonempty slug has, since no key or
 * slug starts or ends with `-`; with an empty slug, the shape is the
 * pattern without `{slug}`, tidied.
 */
export function tidyBranchName(name: string): string {
  return name.replace(/-{2,}/g, "-").replace(/[-/]+$/, "");
}

/**
 * A branch-name pattern as a regular expression source: the first key
 * captured, the slug any text.
 */
function wholePattern(pattern: string, keys: IssueKeys): string {
  let captured = false;
  return pattern
    .split(/(\{[a-z_]+\})/)
    .map((part) => {
      if (part === "{key}" || part === "{key_lower}") {
        const group = captured ? "(?:" : "(";
        captured = true;
        return `${group}${keys.branchSource})`;
      }
      return part === "{slug}" ? ".+" : escapeRe(part);
    })
    .join("");
}

/**
 * The key shape of the configured tracker, or `null` when it cannot be
 * known: a Linear tracker with no `issue_tracker.team`. A GitHub tracker
 * with no `issue_tracker.github.repository` reads its issues' web addresses
 * on the repository its git remote points to, as the adapter does
 * (`homeRepo`): a local `git config` read, not a tracker call.
 */
export function issueKeysOf(
  config: TrackerConfig,
  remote: () => string | null = remoteUrl,
): IssueKeys | null {
  if (config.adapter === "github") {
    if (config.github.repository !== null)
      return numberKeys(config.github.repository);
    const url = remote();
    const derived = url === null ? null : repoFromRemote(url);
    return numberKeys(derived === null ? null : slug(derived));
  }
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
