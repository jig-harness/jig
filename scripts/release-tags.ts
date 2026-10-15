// Scope: the plugin's release tags (plugin/README.md § Release a new version).
// Every version with a section in CHANGELOG.md is owed an annotated tag
// `v<version>` on the commit of the default branch that first set
// `plugin/.claude-plugin/plugin.json` to that version. Lists every version
// origin has no tag for and prints the commands that create and push the
// tags; never runs them. A tag that exists only in this clone (its push
// failed) is still owed: the release links on the site point at origin's.
// A version is settled only by an annotated tag on origin at that commit. A
// tag of its name on origin that is lightweight or points elsewhere is owed
// too, as an ask-first replacement: a plain push cannot replace it, and
// deleting a tag on origin is not a step to take unattended.
// Both the releases and the commits are read from the branch, never from the
// working tree, so a checkout of another branch answers the same. A shallow
// clone is refused: its oldest commit would read as the one that introduced
// every version it already names, and a correct tag on origin as misplaced.
//
// Usage: bun release-tags.ts [--branch <ref>] [--json]
//   --branch  the integration branch to search (default origin/main); fetch
//             it first: `git fetch --no-tags origin main`. Tags are read from
//             origin itself, so this clone's tags are left as they are.
// Exit: 0 no tag can be made yet, 1 a merged version is owed its tag, 2 a
// usage error or a git failure.
import { cli } from "../lib/cli.ts";
import { LEAKY_GIT_ENV, spawnSync } from "../lib/guarded-git-spawn.ts";

export const MANIFEST = "plugin/.claude-plugin/plugin.json";
const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/gm;

export interface OwedTag {
  version: string;
  tag: string;
  /** The commit that first set the manifest to this version; null when none on the branch did. */
  commit: string | null;
  /** A tag of this name in this clone; null when there is none. */
  localTag: TagRef | null;
  /** A tag of this name on origin that is lightweight or at another commit, which must be replaced; null when origin has none. */
  originTag: TagRef | null;
}

/** A tag, in this clone or on origin. */
export interface TagRef {
  /** The commit it points at. */
  commit: string;
  /** False for a lightweight tag, which is not the annotated tag a release is owed. */
  annotated: boolean;
}

/** The released versions CHANGELOG.md has a section for, `Unreleased` aside. */
export function changelogVersions(changelog: string): string[] {
  return [...changelog.matchAll(RELEASE_HEADING)].flatMap((m) =>
    m[1] ? [m[1]] : [],
  );
}

/**
 * The versions owed a tag, oldest first: every one origin has no annotated
 * `v<version>` for at the commit that introduced it. A version no commit on
 * the branch introduced (a release older than the manifest, or one not merged
 * yet) has no commit to check a tag against, so any annotated tag settles it.
 */
export function owedTags(
  versions: string[],
  introduced: Map<string, string>,
  origin: Map<string, TagRef>,
  local: Map<string, TagRef>,
): OwedTag[] {
  return versions
    .map((version) => {
      const tag = `v${version}`;
      return {
        version,
        tag,
        commit: introduced.get(version) ?? null,
        localTag: local.get(tag) ?? null,
        originTag: origin.get(tag) ?? null,
      };
    })
    .filter(
      (o) =>
        !(
          o.originTag?.annotated &&
          (o.commit === null || o.originTag.commit === o.commit)
        ),
    )
    .sort((a, b) => Bun.semver.order(a.version, b.version));
}

/** A manifest's `version`; null when the file or the field is absent. Throws when it does not parse. */
export function manifestVersion(text: string | null): string | null {
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);
  const version =
    parsed && typeof parsed === "object"
      ? (parsed as { version?: unknown }).version
      : undefined;
  return typeof version === "string" ? version : null;
}

/**
 * The first commit, oldest first, whose parsed manifest names each version.
 * Reformatting the file or naming the version again later keeps the first;
 * a manifest that does not parse stops the search rather than being skipped.
 */
export function introducingCommits(
  history: { commit: string; manifest: string | null }[],
): Map<string, string> {
  const first = new Map<string, string>();
  for (const { commit, manifest } of history) {
    let version: string | null;
    try {
      version = manifestVersion(manifest);
    } catch (error) {
      throw new Error(`${MANIFEST} at ${commit} does not parse`, {
        cause: error,
      });
    }
    if (version && !first.has(version)) first.set(version, commit);
  }
  return first;
}

/** The local commands that make one owed tag as the earlier tags were made, keeping a right one. */
function makeCommands(o: OwedTag): string[] {
  return o.localTag?.annotated && o.localTag.commit === o.commit
    ? []
    : [
        ...(o.localTag ? [`git tag -d ${o.tag}`] : []),
        `git tag -a ${o.tag} ${o.commit} -m ${o.tag}`,
      ];
}

/** The shell commands that create the owed tags origin has none of and push them. */
export function tagCommands(owed: OwedTag[]): string[] {
  const ready = owed.filter((o) => o.commit && !o.originTag);
  if (!ready.length) return [];
  return [
    ...ready.flatMap(makeCommands),
    `git push origin ${ready.map((o) => o.tag).join(" ")}`,
  ];
}

/** The ask-first commands that replace origin's lightweight or misplaced tags with annotated ones at the right commit. */
export function replaceCommands(owed: OwedTag[]): string[] {
  const ready = owed.filter((o) => o.commit && o.originTag);
  if (!ready.length) return [];
  return [
    ...ready.flatMap(makeCommands),
    ...ready.map((o) => `git push origin :refs/tags/${o.tag}`),
    `git push origin ${ready.map((o) => o.tag).join(" ")}`,
  ];
}

/**
 * The tags of a `git ls-remote --tags` listing (without `--refs`): an
 * annotated tag carries a peeled `^{}` record naming its commit, a
 * lightweight one does not.
 */
export function remoteTags(listing: string): Map<string, TagRef> {
  const tags = new Map<string, TagRef>();
  for (const line of listing.split("\n")) {
    const match = /^(\S+)\trefs\/tags\/(\S+?)(\^\{\})?$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const [, object, name, peeled] = match;
    if (peeled) tags.set(name, { commit: object, annotated: true });
    else if (!tags.has(name))
      tags.set(name, { commit: object, annotated: false });
  }
  return tags;
}

/** This clone's `v*` tags, the commits they point at, and which are annotated. */
function localTags(root: string): Map<string, TagRef> {
  const listing = git(root, [
    "for-each-ref",
    "refs/tags/v*",
    "--format=%(refname:short) %(objecttype) %(*objectname) %(objectname)",
  ]);
  const tags = new Map<string, TagRef>();
  for (const line of listing.split("\n").filter(Boolean)) {
    const [name = "", type = "", peeled = "", object = ""] = line.split(" ");
    tags.set(name, { commit: peeled || object, annotated: type === "tag" });
  }
  return tags;
}

function gitEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
    ),
  );
}

/** How long a call to origin may take, credential helper included. */
const REMOTE_TIMEOUT_MS = 60_000;

/** git's output; throws when it fails or outlives `timeout` milliseconds. */
function git(root: string, args: string[], timeout?: number): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    env: { ...gitEnv(), GIT_TERMINAL_PROMPT: "0" },
    timeout,
  });
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.error ? `${result.error.message}; ` : ""}${result.stderr?.toString().trim() ?? ""}`,
    );
  return result.stdout.toString();
}

/**
 * A file at a commit; null when the commit has no such file. Absence is read
 * from the commit's tree, so any other failure to read the file (a missing or
 * corrupt object) throws rather than passing for a deletion.
 */
function fileAt(root: string, commit: string, path: string): string | null {
  if (!git(root, ["ls-tree", "--name-only", commit, "--", path]).trim())
    return null;
  return git(root, ["show", `${commit}:${path}`]);
}

/**
 * The manifest at every commit on `branch`'s first-parent line that changed
 * it. Throws in a shallow clone, whose history does not reach the commits
 * that introduced the older versions.
 */
export function manifestHistory(
  root: string,
  branch: string,
): { commit: string; manifest: string | null }[] {
  if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() !== "false")
    throw new Error(
      `${root} is a shallow clone, so the commit that introduced each version cannot be told: run \`git fetch --unshallow origin\` first`,
    );
  return git(root, [
    "log",
    branch,
    "--first-parent",
    "--reverse",
    "--format=%H",
    "--",
    MANIFEST,
  ])
    .split("\n")
    .filter(Boolean)
    .map((commit) => ({ commit, manifest: fileAt(root, commit, MANIFEST) }));
}

/** The `--branch` to search, or null when the command line is not a valid one. */
export function parseArgs(args: string[]): string | null {
  const at = args.indexOf("--branch");
  const branch = at === -1 ? "origin/main" : args[at + 1];
  const known = new Set(["--json", "--branch"]);
  const stray = args.some(
    (a, i) => !known.has(a) && !(at !== -1 && i === at + 1),
  );
  return !branch || branch.startsWith("--") || stray ? null : branch;
}

/** The owed tags as a reader sees them, with the commands that make them. */
function render(branch: string, owed: OwedTag[]): string {
  if (!owed.length) return `release-tags: none owed on ${branch}`;
  const rows = owed.map(
    (o) =>
      `${o.tag}  ${o.commit ?? `not on ${branch} yet (an unmerged pull request's version)`}${o.originTag ? ` (${o.originTag.annotated ? "annotated" : "lightweight"} on origin, at ${o.originTag.commit})` : o.localTag ? ` (tagged in this clone only, at ${o.localTag.commit}${o.localTag.annotated ? "" : ", lightweight"})` : ""}`,
  );
  const commands = tagCommands(owed);
  const replace = replaceCommands(owed);
  return [
    ...rows,
    ...(commands.length ? ["", ...commands] : []),
    ...(replace.length
      ? ["", "Ask first: these delete and replace tags on origin.", ...replace]
      : []),
  ].join("\n");
}

if (import.meta.main)
  cli(() => {
    const args = process.argv.slice(2);
    const branch = parseArgs(args);
    if (!branch) {
      console.error("usage: release-tags.ts [--branch <ref>] [--json]");
      return 2;
    }
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    const changelog = git(root, ["show", `${branch}:CHANGELOG.md`]);
    const origin = remoteTags(
      git(root, ["ls-remote", "--tags", "origin", "v*"], REMOTE_TIMEOUT_MS),
    );
    const owed = owedTags(
      changelogVersions(changelog),
      introducingCommits(manifestHistory(root, branch)),
      origin,
      localTags(root),
    );
    console.log(
      args.includes("--json")
        ? JSON.stringify({ branch, owed }, null, 2)
        : render(branch, owed),
    );
    return owed.some((o) => o.commit) ? 1 : 0;
  });
