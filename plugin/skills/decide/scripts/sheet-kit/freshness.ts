/**
 * The freshness guard of the sheet kit. Facts go stale between drafting and
 * posting, and a sheet uploaded on stale facts has to be replaced after the
 * correction. This guard compares every
 * repository file a sheet's citations name against the `verifiedAt.commit`
 * they were checked at, and names each file that changed since. A sheet with
 * a changed citation is re-verified before it is posted.
 *
 * Scope: the guard knows that a cited file changed. It cannot know whether the
 * claim about that file is still true. That needs a reader.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Path-shaped tokens: a file with an extension (`file.ext`, `dir/file.ext`,
 * optionally followed by `#symbol` or `:12-40`), a dotfile (`.gitignore`), or a
 * directory (`dir/sub/`). Segments may carry `$`, so route files such as
 * `$orderId.tsx` are recognised. The extension must start with a letter, so
 * `v1.2` and `1.0` are not paths. Every token is kept. One that does not exist
 * at the verified commit is reported as unresolved, never dropped: a citation
 * the guard skips silently would read as a citation it checked.
 */
const PATH_TOKEN =
  /(?:^|[\s([`'",;])((?:[\w.@$-]+\/)+(?=[\s)\]`'",;#:]|$)|(?:[\w.@$-]+\/)*[\w@$-][\w.@$-]*\.[A-Za-z][A-Za-z0-9]*|(?:[\w.@$-]+\/)*\.[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)*)(?=[#:\s)\]`'",;.]|$)/g;

/**
 * An extensionless path with a directory part (`apps/web/Dockerfile`). It is
 * a citation like any other: absent at the verified commit, it is reported as
 * unresolved. The last segment ends in a non-dot character, so sentence
 * punctuation (`apps/web/Dockerfile.`) is not part of the path. The `source` field holds citations only, so prose such as
 * `and/or` there is a source error to fix, not a token to skip.
 */
const SLASHED_TOKEN =
  /(?:^|[\s([`'",;])((?:[\w.@$-]+\/)+[\w@$-](?:[\w.@$-]*[\w@$-])?)(?=[#:\s)\]`'",;.]|$)/g;

/**
 * A bare ADR citation, resolved to its file in the ADR directory at the
 * verified commit (`docs/adr` unless the caller names another).
 */
const ADR_TOKEN = /\bADR-\d{3,4}\b/g;
const DEFAULT_ADR_DIR = "docs/adr";

/**
 * Backtick spans are matched as complete pairs, in order, so a closing
 * backtick can never be read as the opening one of the next span. A span that
 * contains whitespace (`.run/Backend Dev.run.xml`) is one citation, taken
 * whole and blanked before the other patterns run, or they would split it at
 * the space. A span without whitespace is an ordinary citation: its content
 * stays in the text for those patterns, set off by spaces.
 */
const BACKTICK_SPAN = /`([^`\n]*)`/g;
const SUFFIX = /(?:#|:\d).*$/;

function quotedPaths(text: string): { paths: string[]; rest: string } {
  const paths: string[] = [];
  const rest = text.replace(BACKTICK_SPAN, (_, span: string) => {
    if (!/\s/.test(span)) return ` ${span} `;
    const path = span.trim().replace(SUFFIX, "");
    if (path) paths.push(path);
    return " ";
  });
  return { paths, rest };
}

function collect(citations: readonly string[], pattern: RegExp, group: number) {
  const out = new Set<string>();
  for (const text of citations)
    for (const match of quotedPaths(text).rest.matchAll(pattern))
      out.add(match[group] as string);
  return [...out].sort();
}

/** Every repository path the citations name, sorted and without repeats. */
export const citedPaths = (citations: readonly string[]): string[] =>
  [
    ...new Set([
      ...collect(citations, PATH_TOKEN, 1),
      ...collect(citations, SLASHED_TOKEN, 1),
      ...citations.flatMap((text) => quotedPaths(text).paths),
    ]),
  ].sort();
const citedAdrs = (citations: readonly string[]): string[] =>
  collect(citations, ADR_TOKEN, 0);

export interface Freshness {
  commit: string;
  /** Cited paths that exist in the repository at the verified commit. */
  checked: string[];
  /** Cited path-shaped tokens absent at the verified commit; not compared. */
  unresolved: string[];
  /** Checked paths whose content differs between the verified commit and the working tree. */
  changed: string[];
}

/**
 * Variables that point git at another repository. A git hook exports some of
 * them for the checkout it runs in, and git honours them over `cwd`, so a
 * guard run from a hook would compare the wrong repository. Windows variable
 * names are case-insensitive, so they are matched without case.
 */
const GIT_LOCATION_VARS = new Set([
  "git_dir",
  "git_work_tree",
  "git_index_file",
  "git_object_directory",
  "git_alternate_object_directories",
  "git_common_dir",
  "git_prefix",
  "git_namespace",
]);

/** `process.env` without the variables that would override `cwd`. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (GIT_LOCATION_VARS.has(key.toLowerCase())) delete env[key];
  return env;
}

function git(args: string[], cwd: string) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
  });
  if (result.error)
    throw new Error(`git ${args[0]} could not run: ${result.error.message}`);
  return result;
}

/**
 * The consumer repository's root: `JIG_CONSUMER_ROOT` when set, else
 * the top of the repository at `cwd`, or `undefined` outside one. Found with
 * the same isolated environment as every other call here: a root discovered
 * through a hook's variables would point the whole check at another
 * repository.
 */
export function repositoryRoot(cwd = process.cwd()): string | undefined {
  const explicit = process.env.JIG_CONSUMER_ROOT;
  if (explicit !== undefined && explicit.trim() !== "")
    return resolve(explicit);
  const result = git(["rev-parse", "--show-toplevel"], cwd);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * Throws when the verified commit is unknown to this clone: then nothing was
 * compared, and "no change" would be a guess.
 */
export function checkFreshness(
  citations: readonly string[],
  commit: string,
  repoRoot: string,
  adrDirectory = DEFAULT_ADR_DIR,
): Freshness {
  const adrDir = `${adrDirectory.replace(/\/+$/, "")}/`;
  const known = git(["cat-file", "-e", `${commit}^{commit}`], repoRoot);
  if (known.status !== 0)
    throw new Error(
      `verifiedAt.commit ${commit} is not in this clone. Fetch it, or re-verify the facts and set a commit that exists.`,
    );
  const existsAt = (path: string) =>
    git(["cat-file", "-e", `${commit}:${path}`], repoRoot).status === 0;
  const checkedSet = new Set<string>();
  const unresolved: string[] = [];
  for (const path of citedPaths(citations))
    if (existsAt(path)) checkedSet.add(path);
    else unresolved.push(path);
  const adrs = citedAdrs(citations);
  if (adrs.length > 0) {
    const listing = git(
      ["ls-tree", "--name-only", `${commit}:${adrDir.replace(/\/$/, "")}`],
      repoRoot,
    );
    const files = listing.status === 0 ? listing.stdout.split("\n") : [];
    for (const adr of adrs) {
      const file = files.find(
        (f) => f.startsWith(`${adr}-`) || f === `${adr}.md`,
      );
      if (file) checkedSet.add(`${adrDir}${file}`);
      else unresolved.push(adr);
    }
  }
  const checked = [...checkedSet].sort();
  unresolved.sort();
  const changedSet = new Set<string>();
  if (checked.length > 0) {
    const diff = git(
      ["diff", "--name-only", commit, "--", ...checked],
      repoRoot,
    );
    if (diff.status !== 0)
      throw new Error(`git diff failed: ${diff.stderr.trim()}`);
    for (const line of diff.stdout.split("\n")) if (line) changedSet.add(line);
    // `git diff` never lists an untracked file, so a new file under a cited
    // directory would leave a claim about "all of it" looking fresh.
    const added = git(
      ["ls-files", "--others", "--exclude-standard", "--", ...checked],
      repoRoot,
    );
    if (added.status !== 0)
      throw new Error(`git ls-files failed: ${added.stderr.trim()}`);
    for (const line of added.stdout.split("\n")) if (line) changedSet.add(line);
  }
  return { commit, checked, unresolved, changed: [...changedSet].sort() };
}
