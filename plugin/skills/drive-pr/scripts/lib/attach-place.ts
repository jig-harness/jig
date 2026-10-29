/**
 * Decide which working tree drives a pull request, and prepare it: the arm
 * step's half of the attach (`attach-pr.ts --place`).
 *
 * A session in a working tree other than the clone's primary checkout drives
 * from that tree. The primary checkout stays on its own branch, so a session
 * there drives from the tree that already holds the pull request (its head
 * branch checked out, or an earlier attach's record), and otherwise from a new
 * one: `git worktree add --detach` under the first of the roots
 * `gc.worktree_roots` names, recorded as created by the drive. Resource
 * collection finds its pull request through the tree's record and reports it
 * once that pull request merges or closes.
 *
 * A pull request in another repository (`owner/repo#N`, or its URL) is placed
 * the same way in that repository's clone, which the user file's `clones` map
 * names; with none mapped, the caller is given the command to run there.
 */
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clonePath, isMapping } from "../../../../shared/config-layers.ts";
import { layeredConfig } from "../../../../shared/consumer.ts";
import {
  detachedTreeRecord,
  writeDrivenTree,
} from "../../../../shared/driven-tree.ts";
import { isRecord } from "../../../../shared/guards.ts";
import {
  canonical,
  driveRemote,
  g,
  out,
  refuse,
  requireOrigin,
} from "./attach.ts";
import { fetchTimeoutSeconds } from "./base-drift.ts";
import { peekCloneKey } from "./state/clone-key.ts";
import { defaultStateRoot } from "./state/store.ts";
import {
  ghCall,
  ghRepoEnv,
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  helperTimeoutSeconds,
  run,
  tsArgv,
} from "./proc.ts";

export interface PrRef {
  pr: string;
  /** `owner/name` when the reference names a repository. */
  slug: string | null;
  /** The forge's host when the reference is a URL. */
  host: string | null;
}

/** `N`, `owner/name#N` or a pull request URL; `null` for anything else. */
export function parsePrRef(ref: string): PrRef | null {
  if (/^[0-9]+$/.test(ref))
    return { pr: String(Number(ref)), slug: null, host: null };
  const short = /^([^/\s#]+\/[^/\s#]+)#([0-9]+)$/.exec(ref);
  if (short)
    return {
      pr: String(Number(short[2])),
      slug: short[1] as string,
      host: null,
    };
  const url =
    /^https?:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+)\/pull\/([0-9]+)\/?$/.exec(ref);
  if (url)
    return {
      pr: String(Number(url[3])),
      slug: url[2] as string,
      host: (url[1] as string).toLowerCase(),
    };
  return null;
}

export type Placement =
  | {
      kind: "placed";
      pr: string;
      slug: string | null;
      tree: string;
      created: boolean;
      /** The tree is in another clone than the caller's checkout. */
      otherClone: boolean;
      /** How a process run in `tree` must change this environment. */
      env: EnvChange;
    }
  | { kind: "elsewhere"; pr: string; slug: string; message: string };

/**
 * The repository `gh` resolves for the checkout at `cwd`, as `host/owner/name`
 * in lower case, or `null`. The host is kept: one `owner/name` on two forges
 * is two repositories.
 */
async function repoId(cwd: string): Promise<string | null> {
  const r = await ghCall(["repo", "view", "--json", "url", "-q", ".url"], {
    cwd,
    stderr: "pipe",
    env: ghRepoEnv(),
  });
  const url = /^https?:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+?)\/?$/.exec(
    r.stdout.trim(),
  );
  return r.code === 0 && url ? `${url[1]}/${url[2]}`.toLowerCase() : null;
}

/** Does the repository `id` (`repoId`) match `ref`'s, host included if named? */
function sameRepo(id: string | null, ref: PrRef): boolean {
  if (id === null || ref.slug === null) return false;
  const slug = ref.slug.toLowerCase();
  return ref.host === null
    ? id.endsWith(`/${slug}`)
    : id === `${ref.host}/${slug}`;
}

interface Tree {
  path: string;
  branch: string | null;
}

/** Every working tree of the clone at `cwd`, the primary checkout first. */
async function trees(cwd: string): Promise<Tree[]> {
  // NUL-separated: a path is printed as is, never quoted or escaped.
  const list = await out(
    cwd,
    ["worktree", "list", "--porcelain", "-z"],
    "the clone's working trees",
  );
  const found: Tree[] = [];
  for (const field of list.split("\0")) {
    if (field.startsWith("worktree "))
      found.push({ path: canonical(field.slice(9)), branch: null });
    else if (field.startsWith("branch refs/heads/") && found.length > 0)
      (found.at(-1) as Tree).branch = field.slice("branch refs/heads/".length);
  }
  if (found.length === 0) refuse(1, "the clone listed no working trees");
  return found;
}

/** The tree whose attach record still names `pr`, if any. */
async function recordedTree(all: Tree[], pr: string): Promise<string | null> {
  for (const tree of all) {
    if (tree.branch !== null || !existsSync(tree.path)) continue;
    const record = await detachedTreeRecord((args) =>
      git(args, {
        cwd: tree.path,
        stderr: "pipe",
        timeoutSec: gitCallTimeoutSeconds(),
        env: gitIdentityEnv(),
      }),
    );
    if (record?.pr === Number(pr)) return tree.path;
  }
  return null;
}

/**
 * The PR's head branch, refusing before anything is created for a PR the
 * attach would refuse anyway: one that is not open, one from a fork, or one
 * whose repository the drive's remote is not, for any URL it fetches from or
 * pushes to.
 */
async function headBranch(
  cwd: string,
  pr: string,
  remote: string,
): Promise<string> {
  const r = await ghCall(
    [
      "pr",
      "view",
      pr,
      "--json",
      "state,headRefName,isCrossRepository,headRepository,headRepositoryOwner",
    ],
    { cwd, stderr: "pipe", env: ghRepoEnv() },
  );
  if (r.code !== 0) refuse(1, `cannot read PR #${pr}: ${r.stderr.trim()}`);
  let meta: unknown;
  try {
    meta = JSON.parse(r.stdout);
  } catch (err) {
    refuse(1, `cannot read PR #${pr}: ${String(err)}`);
  }
  if (!isRecord(meta) || typeof meta.headRefName !== "string")
    refuse(1, `cannot read PR #${pr}: ${r.stderr.trim()}`);
  if (meta.state !== "OPEN")
    refuse(
      5,
      `PR #${pr} is ${String(meta.state)}, not OPEN — nothing to drive`,
    );
  if (meta.isCrossRepository !== false)
    refuse(2, `PR #${pr} comes from a fork: the drive cannot push its head`);
  const owner = isRecord(meta.headRepositoryOwner)
    ? meta.headRepositoryOwner.login
    : undefined;
  const name = isRecord(meta.headRepository)
    ? meta.headRepository.name
    : undefined;
  if (typeof owner !== "string" || typeof name !== "string")
    refuse(1, `PR #${pr} did not report its head repository`);
  await requireOrigin(cwd, { repo: `${owner}/${name}` }, pr, remote);
  return meta.headRefName;
}

/** Create a detached tree for `pr` under the clone's first worktree root. */
async function createTree(
  primary: string,
  pr: string,
  branch: string,
  remote: string,
  env: EnvChange,
): Promise<string> {
  // The destination clone's configuration, not the one this session selects.
  const gc = layeredConfig(primary, applyEnv(process.env, env)).values.gc;
  const roots = isMapping(gc) ? gc.worktree_roots : undefined;
  const root = Array.isArray(roots) ? roots[0] : undefined;
  if (typeof root !== "string" || root === "")
    refuse(
      2,
      `PR #${pr} has no working tree, and gc.worktree_roots names no root to create one under — set it in ${join(primary, ".config/jig.yaml")}, or check the PR out in a working tree and arm there`,
    );
  const dir = isAbsolute(root) ? root : resolve(primary, root);
  const path = join(dir, `${basename(primary)}-pr-${pr}`);
  if (existsSync(path))
    refuse(
      2,
      `${path} already exists and is not a working tree attached to PR #${pr} — remove it, or arm from it`,
    );
  const timeout = fetchTimeoutSeconds();
  if (!timeout.ok)
    refuse(1, `DRIVE_PR_FETCH_TIMEOUT='${timeout.raw}' is invalid`);
  const fetched = await git(
    [
      "fetch",
      "--quiet",
      remote,
      `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
    ],
    {
      cwd: primary,
      stderr: "pipe",
      timeoutSec: timeout.seconds,
      env: gitIdentityEnv(),
    },
  );
  if (fetched.code !== 0)
    refuse(1, `cannot fetch '${branch}': ${fetched.stderr.trim()}`);
  mkdirSync(dir, { recursive: true });
  // Checking out a large repository can outlast a local git call's deadline;
  // it is bounded like the fetch before it.
  const added = await g(
    primary,
    [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      path,
      `refs/remotes/${remote}/${branch}`,
    ],
    timeout.seconds,
  );
  if (added.code !== 0)
    refuse(1, `cannot add a working tree at ${path}: ${added.stderr.trim()}`);
  // Recorded at once, as created for the drive: an attach there that fails
  // or is interrupted leaves a tree the next placement finds and reuses
  // (`recordedTree`), and resource collection can reap.
  const tree = canonical(path);
  writeDrivenTree(
    await out(
      tree,
      ["rev-parse", "--absolute-git-dir"],
      "the new tree's git directory",
    ),
    {
      pr: Number(pr),
      branch,
      remote,
      created: true,
      head: await out(tree, ["rev-parse", "HEAD"], "the new tree's head"),
    },
  );
  return tree;
}

/**
 * The clone that holds `ref`: `cwd`'s own, or the one `clones` maps another
 * repository to; `null` when another repository has none mapped.
 */
async function cloneFor(ref: PrRef, cwd: string): Promise<string | null> {
  if (ref.slug === null) return cwd;
  if (sameRepo(await repoId(cwd), ref)) return cwd;
  const mapped = clonePath(layeredConfig(cwd).values, ref.slug);
  if (mapped === undefined) return null;
  if (!existsSync(mapped))
    refuse(2, `clones.${ref.slug} names ${mapped}, which does not exist`);
  const theirs = await repoId(mapped);
  if (!sameRepo(theirs, ref))
    refuse(
      2,
      `clones.${ref.slug} names ${mapped}, which is a checkout of ${theirs ?? "no repository gh can read"}`,
    );
  return mapped;
}

/** Choose (or create) the tree that drives `ref` from the checkout at `cwd`. */
export async function placePr(ref: PrRef, cwd: string): Promise<Placement> {
  const clone = await cloneFor(ref, cwd);
  if (clone === null)
    return {
      kind: "elsewhere",
      pr: ref.pr,
      slug: ref.slug as string,
      message: elsewhere(ref.slug as string, ref.pr),
    };
  const otherClone = clone !== cwd;
  const key = otherClone ? await cloneKeyOf(clone) : null;
  const here = canonical(
    await out(clone, ["rev-parse", "--show-toplevel"], "this working tree"),
  );
  // A tree placement creates is never this session's own, so it moves at
  // least to another tree; its configuration is read with that same move.
  const away: Move = otherClone ? "clone" : "tree";
  const moveTo = (tree: string): Move =>
    !otherClone && canonical(tree) === here ? "none" : away;
  const placed = (tree: string, created: boolean): Placement => ({
    kind: "placed",
    pr: ref.pr,
    slug: ref.slug,
    tree,
    created,
    otherClone,
    env: destinationEnv(tree, moveTo(tree), process.env, key),
  });
  const all = await trees(clone);
  const primary = (all[0] as Tree).path;
  if (clone === cwd && here !== primary) return placed(here, false);
  const primaryEnv = destinationEnv(primary, away, process.env, key);
  // The destination clone's remote, read as its configuration is.
  const remote = driveRemote(primary, applyEnv(process.env, primaryEnv));
  const branch = await headBranch(clone, ref.pr, remote);
  const holder = all.find((tree) => tree.branch === branch);
  if (holder !== undefined) return placed(holder.path, false);
  const recorded = await recordedTree(all, ref.pr);
  if (recorded !== null) return placed(recorded, false);
  return placed(
    await createTree(primary, ref.pr, branch, remote, primaryEnv),
    true,
  );
}

function elsewhere(slug: string, pr: string): string {
  return [
    `PR ${slug}#${pr} is in another repository, and the user file maps no clone of it (clones in ~/.jig/jig.yaml).`,
    `Run this in a checkout of ${slug}:`,
    `  /jig:drive-pr ${pr}`,
    `or map a clone, then arm again:`,
    `  clones:`,
    `    ${slug}: /path/to/a/clone`,
  ].join("\n");
}

const ATTACH_PR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "attach-pr.ts",
);

/** The variables a running drive exports for the tree it drives. */
const DRIVE_CONTEXT = [
  "DRIVE_PR_WORKTREE",
  "DRIVE_PR_TARGET",
  "DRIVE_PR_SESSION",
  "DRIVE_PR_SESSION_STARTED",
];

/**
 * The variables that override a location otherwise derived from the working
 * tree: its configuration (`consumerRoot()`, the overlay) and the `.context/`
 * directories of the handoff file, the mailbox and the intent-chain pin.
 */
const TREE_SELECTORS = [
  "JIG_CONSUMER_ROOT",
  "JIG_OVERLAY",
  "DRIVE_PR_HANDOFF_DIR",
  "DRIVE_PR_MAILBOX_DIR",
  "DRIVE_PR_INTENT_CHAIN_DIR",
];

/**
 * Where a placed tree is from this session: its own tree, another tree of
 * the same clone, or a tree of another clone.
 */
export type Move = "none" | "tree" | "clone";

/** What `destinationEnv` changes, so the arm step can make the same change. */
export interface EnvChange {
  /** Variable names to remove, upper case. */
  unset: string[];
}

/**
 * How the environment of a process run in `tree` differs from this one's:
 * nothing that selects a repository, configuration, working tree or drive
 * state survives unless it names `tree`. Every process placement starts
 * there (the configuration read, the attach) and every one the arm step
 * starts (the checkpoint lookup, the driver) takes this one change.
 *
 * - `GH_REPO` is removed always: placement reads `gh` without it, and the
 *   attach, the checkpoint and the driver must read the same repository.
 * - A running drive's own variables (`DRIVE_PR_WORKTREE` and its session)
 *   are removed when they name another tree, and always in another clone.
 * - Placed in any tree other than this session's own, every location
 *   override (`TREE_SELECTORS`) is removed, so the destination derives each
 *   from itself.
 * - In another clone, the state directory a driver exports
 *   (`DRIVE_PR_STATE_DIR` with its identity) is its own clone's leaf: kept
 *   when it is the destination's too (`destinationKey`), removed with its
 *   identity when it is under the default root, so the destination resolves
 *   its own leaf there. A leaf under a relocated root is refused: the state
 *   fence accepts that root only with an identity a driver captured, so no
 *   setting here reaches the destination's leaf under it. Within one clone
 *   the leaf is shared by every tree, so it stays.
 */
export function destinationEnv(
  tree: string,
  move: Move,
  env: Record<string, string | undefined> = process.env,
  destinationKey: string | null = null,
): EnvChange {
  const unset = ["GH_REPO"];
  const anchor = env.DRIVE_PR_WORKTREE;
  if (move === "clone" || (anchor !== undefined && canonical(anchor) !== tree))
    unset.push(...DRIVE_CONTEXT);
  if (move !== "none") unset.push(...TREE_SELECTORS);
  const leaf = env.DRIVE_PR_STATE_DIR ?? "";
  if (move === "clone") {
    const exported = (env.DRIVE_PR_STATE_DIR_IDENTITY ?? "") !== "";
    if (exported && leaf !== "" && basename(leaf) !== destinationKey) {
      if (canonical(dirname(leaf)) !== canonical(defaultStateRoot()))
        refuse(
          2,
          `this session runs inside a drive whose state is under the relocated root ${dirname(leaf)}, and ${tree} is in another clone: arm it from a session outside the drive`,
        );
      unset.push("DRIVE_PR_STATE_DIR", "DRIVE_PR_STATE_DIR_IDENTITY");
    }
  }
  const present = (name: string) =>
    Object.keys(env).some((key) => key.toUpperCase() === name);
  return { unset: unset.filter(present) };
}

/** The clone key of the clone `tree` is in, if it has one yet. */
async function cloneKeyOf(tree: string): Promise<string | null> {
  const common = await out(
    tree,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "the clone's common git directory",
  );
  return peekCloneKey(common);
}

/** `env` with `change` applied. */
export function applyEnv(
  env: Record<string, string | undefined>,
  change: EnvChange,
): Record<string, string | undefined> {
  const next = { ...env };
  for (const key of Object.keys(next))
    if (change.unset.includes(key.toUpperCase())) delete next[key];
  return next;
}

/** Attach `pr` in `tree` as its own process, so the state is that clone's. */
export async function attachIn(
  tree: string,
  pr: string,
  created: boolean,
  change: EnvChange,
): Promise<{ code: number; stdout: string; stderr: string }> {
  // Its fetch has a deadline of its own; the rest is a helper's.
  const fetch = fetchTimeoutSeconds();
  const env = applyEnv(gitIdentityEnv(), change);
  const r = await run(
    tsArgv(ATTACH_PR, [pr, ...(created ? ["--created"] : [])]),
    {
      cwd: tree,
      stderr: "pipe",
      timeoutSec: helperTimeoutSeconds() + (fetch.ok ? fetch.seconds : 0),
      env,
    },
  );
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}
