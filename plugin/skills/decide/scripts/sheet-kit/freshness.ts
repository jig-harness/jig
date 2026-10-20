/**
 * The freshness guard of the sheet kit. Facts go stale between drafting and
 * posting, and a sheet uploaded on stale facts has to be replaced after the
 * correction. This guard compares every
 * repository file a sheet's citations name against the `verifiedAt.commit`
 * they were checked at, and names each file that changed since. A sheet with
 * a changed citation is re-verified before it is posted.
 *
 * A citation is checked against the consumer repository unless it is
 * qualified with the name of another repository (`other:apps/api/auth.ts`,
 * `other:ADR-0002`). A qualified citation is resolved in the clone configured
 * for that name, at the commit `verifiedAt.repositories` records for it: two
 * repositories commonly number their ADRs from `ADR-0001`, so a bare token
 * could only ever mean one of them.
 *
 * Scope: the guard knows that a cited file changed. It cannot know whether the
 * claim about that file is still true. That needs a reader.
 */
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
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
 * An ADR citation, resolved to its file in the ADR directory at the verified
 * commit (`docs/adr` unless the caller names another).
 */
const ADR_TOKEN = /\bADR-\d{3,4}\b/g;
const DEFAULT_ADR_DIR = "docs/adr";

/** The name a qualified citation gives a repository: lowercase, so an issue key (`ENG-123`) and a file name (`Makefile:12`) never read as one. */
export const REPOSITORY_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * What may follow a qualifier's colon: a letter, `_`, `.`, `@` or `$`, or a
 * segment that starts with a digit or `-` and goes on to a `/` or an
 * extension (`2026/auth.ts`, `-tools/x.ts`). A line suffix (`path:12-40`),
 * `https://…` and prose such as `note: x` keep their meaning.
 */
const QUALIFIED_START = String.raw`(?=[A-Za-z_.@$]|[\w@$-]+(?:\/|\.[A-Za-z]))`;

/** The `name:` that qualifies the citation after it. */
const QUALIFIER = new RegExp(
  String.raw`(?<=^|[\s([\`'",;])([a-z][a-z0-9_-]*):${QUALIFIED_START}`,
  "g",
);
const QUALIFIED_SPAN = new RegExp(
  String.raw`^([a-z][a-z0-9_-]*):${QUALIFIED_START}(.*)$`,
  "s",
);

/** A leading qualifier on one citation, optionally inside its opening backtick: what the explainer's citation grammar strips before checking the rest. */
export const LEADING_QUALIFIER = new RegExp(
  String.raw`^(\`?)[a-z][a-z0-9_-]*:${QUALIFIED_START}`,
);

/**
 * Backtick spans are matched as complete pairs, in order, so a closing
 * backtick can never be read as the opening one of the next span. A span that
 * contains whitespace (`.run/Backend Dev.run.xml`) is one citation, taken
 * whole and blanked before the other patterns run, or they would split it at
 * the space. A span without whitespace is an ordinary citation: its content
 * stays in the text for those patterns, set off by spaces. A whole span is
 * returned as written; its qualifier is split off before its line suffix is,
 * because a qualified path may start with digits (`beta:2026/x y.ts`) that
 * read like a line suffix.
 */
const BACKTICK_SPAN = /`([^`\n]*)`/g;
const SUFFIX = /(?:#|:\d).*$/;

function quotedPaths(text: string): { paths: string[]; rest: string } {
  const paths: string[] = [];
  const rest = text.replace(BACKTICK_SPAN, (_, span: string) => {
    if (!/\s/.test(span)) return ` ${span} `;
    const path = span.trim();
    if (path) paths.push(path);
    return " ";
  });
  return { paths, rest };
}

/** One thing a citation names: a repository path or an ADR, in the consumer repository or in the one `repository` names. */
interface Cited {
  repository?: string | undefined;
  kind: "path" | "adr";
  name: string;
}

/**
 * Everything one citation text names, and the qualifiers that qualify none of
 * it (`beta:ENG-123`: a qualifier names a path or an ADR). Each qualifier's
 * colon is replaced by a space of the same length, so the scanners see the
 * qualified token as an ordinary one and its position still says which
 * qualifier it follows. An ADR inside a qualified path
 * (`other:docs/adr/ADR-0002-x.md`) belongs to that path's repository.
 */
function scanText(text: string): { cited: Cited[]; idle: string[] } {
  const { paths, rest } = quotedPaths(text);
  const out: Cited[] = paths.flatMap((span): Cited[] => {
    const qualified = QUALIFIED_SPAN.exec(span);
    const name = (qualified ? (qualified[2] as string) : span).replace(
      SUFFIX,
      "",
    );
    if (!name) return [];
    return [{ repository: qualified?.[1], kind: "path", name }];
  });
  const qualifiedAt = new Map<number, string>();
  const blanked = rest.replace(
    QUALIFIER,
    (match: string, name: string, offset: number) => {
      qualifiedAt.set(offset + match.length, name);
      return `${name} `;
    },
  );
  const used = new Set<number>();
  const qualifierAt = (start: number) => {
    used.add(start);
    return qualifiedAt.get(start);
  };
  const pathRanges: {
    start: number;
    end: number;
    repository?: string | undefined;
  }[] = [];
  for (const pattern of [PATH_TOKEN, SLASHED_TOKEN])
    for (const m of blanked.matchAll(pattern)) {
      const name = m[1] as string;
      const start = (m.index ?? 0) + m[0].length - name.length;
      const repository = qualifierAt(start);
      out.push({ repository, kind: "path", name });
      pathRanges.push({ start, end: start + name.length, repository });
    }
  for (const m of blanked.matchAll(ADR_TOKEN)) {
    const start = m.index ?? 0;
    const within = pathRanges.find((r) => r.start <= start && start < r.end);
    out.push({
      repository: within ? within.repository : qualifierAt(start),
      kind: "adr",
      name: m[0],
    });
  }
  const idle = [...qualifiedAt]
    .filter(([at]) => !used.has(at))
    .map(([, name]) => `${name}:`);
  return { cited: out, idle };
}

const scan = (text: string): Cited[] => scanText(text).cited;

const scanAll = (citations: readonly string[]): Cited[] =>
  citations.flatMap(scan);

const qualify = (repository: string | undefined, name: string) =>
  repository === undefined ? name : `${repository}:${name}`;

/**
 * Every repository path the citations name, sorted and without repeats. A
 * path of another repository keeps its qualifier (`other:apps/api/auth.ts`).
 */
export const citedPaths = (citations: readonly string[]): string[] =>
  [
    ...new Set(
      scanAll(citations)
        .filter((c) => c.kind === "path")
        .map((c) => qualify(c.repository, c.name)),
    ),
  ].sort();

/** The names of the other repositories the citations qualify, sorted and without repeats. */
export const citedRepositories = (citations: readonly string[]): string[] =>
  [
    ...new Set(
      scanAll(citations).flatMap((c) =>
        c.repository === undefined ? [] : [c.repository],
      ),
    ),
  ].sort();

/**
 * A `name:` placed the way a qualifier is: directly before a backtick or
 * anything `QUALIFIED_START` accepts, so the detector and the reader share one
 * notion of what may follow a qualifier. Every such `name:` is either a
 * qualifier the scanner reads (`QUALIFIER` matches at the same place) or named
 * as malformed (`Beta:ADR-0002`, `1beta:ENG-123`, `see:beta:ADR-0002`, `beta:`
 * outside the backticks): read as an ordinary citation it would resolve in the
 * consumer repository or not at all. A name with a `.` or `/` is a path, and
 * `auth.ts:check` cites a symbol in it; such a name is named only before an
 * ADR, a backtick or a path (`PATH_AFTER`), where it can only be a misplaced
 * qualifier.
 */
const NEAR_QUALIFIER = new RegExp(
  String.raw`([^\s:\`(['",;]+):(?:(?=\`)|${QUALIFIED_START})`,
  "g",
);
const PATH_AFTER = /^(?:ADR-\d{3,4}\b|`|[\w.@$-]+\/|[\w@$-]*\.[A-Za-z])/;

const STICKY_QUALIFIER = new RegExp(QUALIFIER.source, "y");

/** Whether the `name:` that `NEAR_QUALIFIER` matched at `m` is a qualifier the scanner does not read. */
function isMalformed(text: string, m: RegExpExecArray): boolean {
  const at = m.index;
  const after = text.slice(at + m[0].length);
  if (/[./]/.test(m[1] as string) && !PATH_AFTER.test(after)) return false;
  STICKY_QUALIFIER.lastIndex = at;
  return STICKY_QUALIFIER.exec(text)?.[0] !== m[0] || after.startsWith("`");
}

function malformedQualifiers(citations: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of citations)
    for (const m of text.matchAll(NEAR_QUALIFIER))
      if (isMalformed(text, m)) found.add(`${m[1]}:`);
  for (const text of citations)
    for (const name of scanText(text).idle) found.add(name);
  return [...found].sort();
}

/**
 * What stops a sheet's qualified citations from being checked: a repository
 * whose commit `verifiedAt.repositories` does not record, and, when
 * `configured` is given, one with no configured clone, and a qualifier the
 * grammar does not accept. Every one is a
 * problem, never skipped: a citation the guard does not check must not read
 * as one it did.
 */
export function repositoryProblems(
  citations: readonly string[],
  recorded: Readonly<Record<string, string>> | undefined,
  configured?: Iterable<string>,
): string[] {
  const clones = configured === undefined ? undefined : new Set(configured);
  const problems = malformedQualifiers(citations).map(
    (token) =>
      `"${token}" is placed like a repository qualifier but is not one: a qualifier is a lowercase repository name (letters, digits, - and _) directly before the ADR or path, and inside the backticks of a quoted path`,
  );
  for (const name of citedRepositories(citations)) {
    if (recorded === undefined || !Object.hasOwn(recorded, name))
      problems.push(
        `a citation names repository "${name}", but verifiedAt.repositories records no commit for it`,
      );
    if (clones !== undefined && !clones.has(name))
      problems.push(
        `a citation names repository "${name}", which has no clone configured: set sheets.repositories.${name} in .config/jig.yaml`,
      );
  }
  return problems;
}

export interface Freshness {
  commit: string;
  /** Cited paths that exist in their repository at its verified commit. Those of another repository carry its qualifier. */
  checked: string[];
  /** Cited path-shaped tokens absent at the verified commit; not compared. */
  unresolved: string[];
  /** Checked paths whose content differs between the verified commit and the working tree. */
  changed: string[];
}

/** A clone of another repository a sheet cites. */
export interface Clone {
  root: string;
  /** Where that repository keeps its ADRs. */
  adrDirectory: string;
}

/** What the guard needs to check the citations that name another repository. */
export interface OtherRepositories {
  /** The commit each repository's facts were verified at, by name (`verifiedAt.repositories`). */
  verified: Readonly<Record<string, string>>;
  /** The configured clone of each repository, by name. */
  clones: Readonly<Record<string, Clone>>;
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

/** The guard could not compare what a sheet cites; nothing was checked, and "no change" would be a guess. */
export class FreshnessError extends Error {
  override name = "FreshnessError";
}

/** The top of the git clone at `root`, or a reason it is not one. */
function cloneProblem(name: string, root: string): string | undefined {
  try {
    if (!statSync(root).isDirectory())
      return `repository "${name}" is configured at ${root}, which is not a directory`;
  } catch {
    return `repository "${name}" is configured at ${root}, which does not exist`;
  }
  const top = git(["rev-parse", "--show-toplevel"], root);
  // A folder inside another repository would answer for that repository.
  if (
    top.status !== 0 ||
    realpathSync(top.stdout.trim()) !== realpathSync(root)
  )
    return `repository "${name}" is configured at ${root}, which is not the top of a git clone`;
  return undefined;
}

/** The ADR directory's file for each ADR cited, and the cited paths that exist at `commit`; the rest is unresolved. */
function resolveCited(
  cited: { paths: string[]; adrs: string[] },
  commit: string,
  root: string,
  adrDir: string,
): { checked: Set<string>; unresolved: string[] } {
  const checked = new Set<string>();
  const unresolved: string[] = [];
  for (const path of cited.paths)
    if (git(["cat-file", "-e", `${commit}:${path}`], root).status === 0)
      checked.add(path);
    else unresolved.push(path);
  if (cited.adrs.length === 0) return { checked, unresolved };
  const listing = git(
    ["ls-tree", "--name-only", `${commit}:${adrDir.replace(/\/$/, "")}`],
    root,
  );
  const files = listing.status === 0 ? listing.stdout.split("\n") : [];
  for (const adr of cited.adrs) {
    const file = files.find(
      (f) => f.startsWith(`${adr}-`) || f === `${adr}.md`,
    );
    if (file) checked.add(`${adrDir}${file}`);
    else unresolved.push(adr);
  }
  return { checked, unresolved };
}

/** The checked paths that differ from `commit` in the working tree, or are untracked there. */
function changedSince(commit: string, root: string, checked: string[]) {
  const changed = new Set<string>();
  if (checked.length === 0) return changed;
  const diff = git(["diff", "--name-only", commit, "--", ...checked], root);
  if (diff.status !== 0)
    throw new FreshnessError(`git diff failed: ${diff.stderr.trim()}`);
  // `git diff` never lists an untracked file, so a new file under a cited
  // directory would leave a claim about "all of it" looking fresh.
  const added = git(
    ["ls-files", "--others", "--exclude-standard", "--", ...checked],
    root,
  );
  if (added.status !== 0)
    throw new FreshnessError(`git ls-files failed: ${added.stderr.trim()}`);
  for (const out of [diff.stdout, added.stdout])
    for (const line of out.split("\n")) if (line) changed.add(line);
  return changed;
}

/** Cited paths and ADRs of one repository, compared at its verified commit. */
function inspect(
  cited: { paths: string[]; adrs: string[] },
  commit: string,
  root: string,
  adrDirectory: string,
  label: (path: string) => string,
): Freshness {
  const adrDir = `${adrDirectory.replace(/\/+$/, "")}/`;
  const resolved = resolveCited(cited, commit, root, adrDir);
  const checked = [...resolved.checked].sort();
  return {
    commit,
    checked: checked.map(label),
    unresolved: resolved.unresolved.map(label),
    changed: [...changedSince(commit, root, checked)].map(label),
  };
}

/** The distinct paths and ADRs cited in `repository` (undefined: the consumer repository), sorted. */
function citedIn(cited: readonly Cited[], repository: string | undefined) {
  const names = (kind: Cited["kind"]) =>
    [
      ...new Set(
        cited
          .filter((c) => c.kind === kind && c.repository === repository)
          .map((c) => c.name),
      ),
    ].sort();
  return { paths: names("path"), adrs: names("adr") };
}

/**
 * Why the clone configured for `name` cannot be compared at `commit`: it is
 * not the top of a git clone, or it lacks the commit. Undefined when it can.
 */
export function cloneCommitProblem(
  name: string,
  root: string,
  commit: string,
): string | undefined {
  const problem = cloneProblem(name, root);
  if (problem) return problem;
  if (git(["cat-file", "-e", `${commit}^{commit}`], root).status !== 0)
    return `verifiedAt.repositories.${name} ${commit} is not in the clone of "${name}" at ${root}. Fetch it, or re-verify the facts and set a commit that exists.`;
  return undefined;
}

/** One other repository's cited files, compared at the commit recorded for it. */
function inspectClone(
  name: string,
  clone: Clone,
  commit: string,
  cited: { paths: string[]; adrs: string[] },
): Freshness {
  const problem = cloneCommitProblem(name, clone.root, commit);
  if (problem) throw new FreshnessError(problem);
  return inspect(cited, commit, clone.root, clone.adrDirectory, (path) =>
    qualify(name, path),
  );
}

/**
 * Throws when a verified commit is unknown to its clone: then nothing was
 * compared, and "no change" would be a guess. It throws as well for a
 * qualified citation whose repository has no recorded commit or no usable
 * clone, for the same reason.
 */
export function checkFreshness(
  citations: readonly string[],
  commit: string,
  repoRoot: string,
  adrDirectory = DEFAULT_ADR_DIR,
  others: OtherRepositories = { verified: {}, clones: {} },
): Freshness {
  const known = git(["cat-file", "-e", `${commit}^{commit}`], repoRoot);
  if (known.status !== 0)
    throw new Error(
      `verifiedAt.commit ${commit} is not in this clone. Fetch it, or re-verify the facts and set a commit that exists.`,
    );
  const problems = repositoryProblems(
    citations,
    others.verified,
    Object.keys(others.clones),
  );
  if (problems.length > 0) throw new FreshnessError(problems.join("\n"));
  const cited = scanAll(citations);
  const results = [
    inspect(
      citedIn(cited, undefined),
      commit,
      repoRoot,
      adrDirectory,
      (path) => path,
    ),
    ...citedRepositories(citations).map((name) =>
      inspectClone(
        name,
        others.clones[name] as Clone,
        others.verified[name] as string,
        citedIn(cited, name),
      ),
    ),
  ];
  const merged = (pick: (r: Freshness) => string[]) =>
    results.flatMap(pick).sort();
  return {
    commit,
    checked: merged((r) => r.checked),
    unresolved: merged((r) => r.unresolved),
    changed: merged((r) => r.changed),
  };
}

/**
 * Why a sheet must not be rendered for posting, or undefined when it may: the
 * guard could not run, a cited file changed, or a citation could not be
 * resolved. An unresolved citation is one the guard did not check, so it
 * refuses like a changed one.
 */
export function refusalToPost(
  freshness: Freshness | { error: string },
): string | undefined {
  if ("error" in freshness) return freshness.error;
  if (freshness.changed.length > 0)
    return `cited files changed since ${freshness.commit}:\n- ${freshness.changed.join("\n- ")}\nRe-verify the claims that cite them, update verifiedAt, and render again.`;
  if (freshness.unresolved.length > 0)
    return `these cited paths do not exist at the verified commit, so the guard cannot check them:\n- ${freshness.unresolved.join("\n- ")}\nCite repository-rooted paths, then render again.`;
  return undefined;
}
