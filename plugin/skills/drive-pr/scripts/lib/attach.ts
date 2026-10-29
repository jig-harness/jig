/**
 * Attach a pull request to the working tree a drive runs in.
 *
 * The drive pushes to exactly one branch, the pull request's head, by explicit
 * refspec from a resolved commit (`guarded-push.ts`). That is what lets any
 * working tree of the clone drive it: the tree checks the head branch out when
 * no other tree of the clone holds it, and checks out the head commit
 * **detached** when one does, since git allows one checkout per branch. A
 * second branch with a suffixed name is never created; it would push nowhere.
 *
 * A detached tree records which pull request it drives in its own git
 * directory (`shared/driven-tree.ts`), the record every reader uses; an
 * attach by name removes it. The drive state's `drivenBranch` keeps a copy
 * for the handoff file.
 *
 * It refuses, naming the state, when this tree has uncommitted changes or an
 * unfinished git operation; when the tree holding the branch has uncommitted
 * changes or commits the pull request's head does not have (its unpushed work
 * would be driven around); when a local commit would be orphaned by moving
 * this tree; when the tree is the clone's primary checkout on another branch
 * (`attach-pr.ts --place` creates a tree for the drive instead); when the
 * pull request comes from a fork, whose head the drive cannot push to; and
 * when `origin` is not the repository `gh` read the pull request from.
 *
 * Nothing moves without ownership. `drive.ts` attaches after it takes the
 * tree's driver lock and before the pull request's; on its own the attach
 * moves nothing while a live driver holds this tree or the pull request
 * (exit 11 from `attach-pr.ts`), and takes both driver locks itself, in the
 * same order, until it is done. It holds the tree's session-lease fence
 * (`lib/state/lease.ts`) across reading the tree, the checkout and the
 * tree's record, so an interactive session working this tree refuses it too.
 *
 * Every git and `gh` call is bounded; the fetch by `DRIVE_PR_FETCH_TIMEOUT`.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type DrivenTree,
  detachedTreeRecord,
  readDrivenTree,
  removeDrivenTree,
  writeDrivenTree,
} from "../../../../shared/driven-tree.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { fetchTimeoutSeconds } from "./base-drift.ts";
import { fail } from "./cli.ts";
import { setDrivenRemoteRef } from "./driven-branch.ts";
import {
  acquire,
  type DriveLock,
  liveHolder,
  release,
} from "./driver/locks.ts";
import {
  ghCall,
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  unconcludedGitOpMarker,
} from "./proc.ts";
import { repoOfUrl } from "./repo-url.ts";
import {
  assertTreeMutationAllowed,
  resolveFenceContext,
} from "./state/lease.ts";
import { openStore, resolveStateDir, worktreeLockName } from "./state/store.ts";

/**
 * The remote the drive pushes to. `guarded-push.ts` pushes to `origin` and
 * refuses when `origin` is not the pull request's repository; no
 * configuration names another, so the attach fetches from the same one.
 */
export const DRIVE_REMOTE = "origin";

/** Why the attach did not happen: the exit code and the message. */
export class AttachRefusal extends Error {
  /** 1 unreadable, 2 refused for the state named, 5 not open. */
  readonly code: 1 | 2 | 5;
  constructor(code: 1 | 2 | 5, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Attached {
  pr: string;
  branch: string;
  remote: string;
  /** The pull request's head commit, as `gh` reported it. */
  head: string;
  worktree: string;
  detached: boolean;
  created: boolean;
  /** Set when a live driver holds this tree or the PR: nothing moved. */
  skipped?: string;
}

interface Options {
  /** The attach created this tree for the drive (`--place`). */
  created?: boolean;
  /** The caller holds this tree's driver lock (`drive.ts`). */
  treeLockHeld?: boolean;
}

interface PrHead {
  branch: string;
  head: string;
  /** `owner/name` of the repository the head branch lives in. */
  repo: string;
}

export function refuse(code: 1 | 2 | 5, message: string): never {
  throw new AttachRefusal(code, message);
}

/** Bounded local git in `cwd`, scrubbed of an inherited GIT_DIR. */
export async function g(
  cwd: string,
  args: string[],
  timeoutSec = gitCallTimeoutSeconds(),
): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await git(args, {
    cwd,
    stderr: "pipe",
    timeoutSec,
    env: gitIdentityEnv(),
  });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

/** `g`'s trimmed output, or a refusal naming `what` could not be read. */
export async function out(
  cwd: string,
  args: string[],
  what: string,
): Promise<string> {
  const r = await g(cwd, args);
  if (r.code !== 0) refuse(1, `cannot read ${what}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** `path` with its links resolved, as git spells a worktree. */
export function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The pull request, read as every later call of the drive reads it: `gh`
 * from the tree, honouring an inherited `GH_REPO` like the rest of the drive
 * does, so the attach and the rounds select one repository. `requireOrigin`
 * then binds that repository to `origin` before anything is fetched.
 */
async function readPr(pr: string, cwd: string): Promise<PrHead> {
  const view = await ghCall(
    [
      "pr",
      "view",
      pr,
      "--json",
      "state,headRefName,headRefOid,isCrossRepository,headRepository,headRepositoryOwner",
    ],
    { cwd, stderr: "pipe" },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(view.stdout);
  } catch (err) {
    refuse(1, `cannot read PR #${pr}: ${String(err)}`);
  }
  const meta = isRecord(parsed) ? parsed : {};
  if (view.code !== 0 || typeof meta.state !== "string")
    refuse(1, `cannot read PR #${pr}: ${view.stderr.trim()}`);
  if (meta.state !== "OPEN")
    refuse(5, `PR #${pr} is ${meta.state}, not OPEN — nothing to drive`);
  if (meta.isCrossRepository !== false)
    refuse(
      2,
      `PR #${pr} comes from a fork: the drive pushes only to '${DRIVE_REMOTE}', so it cannot push its head`,
    );
  const branch = typeof meta.headRefName === "string" ? meta.headRefName : "";
  const head = typeof meta.headRefOid === "string" ? meta.headRefOid : "";
  if (branch === "" || !/^[0-9a-f]{40,64}$/.test(head))
    refuse(1, `PR #${pr} did not report its head branch and commit`);
  const owner = isRecord(meta.headRepositoryOwner)
    ? meta.headRepositoryOwner.login
    : undefined;
  const name = isRecord(meta.headRepository)
    ? meta.headRepository.name
    : undefined;
  if (typeof owner !== "string" || typeof name !== "string")
    refuse(1, `PR #${pr} did not report its head repository`);
  return { branch, head, repo: `${owner}/${name}` };
}

/**
 * `origin` must be the repository the pull request was read from, for every
 * URL it fetches from and pushes to: a fork or a related repository shares
 * commit objects, so a fetched head commit proves nothing about which
 * repository it came from. Owner and name are compared, as `guarded-push.ts`
 * compares them, never the host (`lib/repo-url.ts` says why).
 */
export async function requireOrigin(
  tree: string,
  pr: { repo: string },
  number: string,
): Promise<void> {
  const urls: string[] = [];
  for (const args of [
    ["remote", "get-url", "--all", DRIVE_REMOTE],
    ["remote", "get-url", "--push", "--all", DRIVE_REMOTE],
  ]) {
    const r = await g(tree, args);
    if (r.code !== 0)
      refuse(1, `cannot read the URL of '${DRIVE_REMOTE}': ${r.stderr.trim()}`);
    urls.push(...r.stdout.split("\n").filter((u) => u !== ""));
  }
  for (const url of urls) {
    const repo = repoOfUrl(url);
    if (repo.toLowerCase() !== pr.repo.toLowerCase())
      refuse(
        2,
        `PR #${number}'s head is in ${pr.repo}, but '${DRIVE_REMOTE}' is ${repo === "" ? "a URL with no owner/name" : repo} (${url}) — gh read the pull request from another repository than this clone's (GH_REPO, gh repo set-default); drive it from a clone of ${pr.repo}`,
      );
  }
}

/** Refuse a tree with uncommitted changes or an unfinished operation. */
async function requireSettled(tree: string, which: string): Promise<void> {
  const status = await g(tree, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
    "--ignore-submodules=none",
  ]);
  if (status.code !== 0) refuse(1, `cannot read ${which}'s status`);
  if (status.stdout.trim() !== "")
    refuse(
      2,
      `${which} (${tree}) has uncommitted changes — commit or discard them first:\n${status.stdout.trimEnd()}`,
    );
  const op = await unconcludedGitOpMarker(gitCallTimeoutSeconds(), {
    cwd: tree,
    env: gitIdentityEnv(),
  });
  if (!op.ok) refuse(1, `cannot read whether ${which} is mid-operation`);
  if (op.marker !== null)
    refuse(
      2,
      `${which} (${tree}) is in an unfinished git operation (${op.marker}) — conclude or abort it first`,
    );
}

/** Is `a` an ancestor of (or equal to) `b`? */
async function ancestor(tree: string, a: string, b: string): Promise<boolean> {
  return (await g(tree, ["merge-base", "--is-ancestor", a, b])).code === 0;
}

/** The working tree of this clone that has `branch` checked out, if any. */
async function holderOf(tree: string, branch: string): Promise<string | null> {
  // NUL-separated: a path is printed as is, never quoted or escaped.
  const list = await out(
    tree,
    ["worktree", "list", "--porcelain", "-z"],
    "the clone's working trees",
  );
  let path: string | null = null;
  for (const field of list.split("\0")) {
    if (field.startsWith("worktree ")) path = field.slice("worktree ".length);
    else if (field === `branch refs/heads/${branch}` && path !== null)
      return canonical(path);
  }
  return null;
}

/** Where the drive's attach record lives for the tree at `tree`. */
async function gitDirOf(tree: string): Promise<string> {
  return out(tree, ["rev-parse", "--absolute-git-dir"], "the git directory");
}

/** Is `tree` the clone's primary checkout (its git dir is the common dir)? */
async function isPrimary(tree: string, gitDir: string): Promise<boolean> {
  const common = await out(
    tree,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "the common git directory",
  );
  return canonical(common) === canonical(gitDir);
}

/**
 * Move this tree onto the head: the branch by name when `byName`, else the
 * head commit detached. Refuses when that would orphan a commit of a detached
 * head, or move the primary checkout off the branch it is on.
 */
async function moveTree(
  tree: string,
  pr: PrHead & { number: string },
  current: { branch: string; sha: string; primary: boolean },
  byName: boolean,
): Promise<void> {
  if (current.primary)
    refuse(
      2,
      `this is the clone's primary checkout, on ${current.branch === "" ? "a detached head" : `'${current.branch}'`}: the drive does not move it.\nArm from here with /jig:drive-pr ${pr.number}, which creates a working tree for the PR (attach-pr.ts ${pr.number} --place).`,
    );
  if (current.branch === "") await requireReachable(tree, current.sha);
  if (!byName) {
    await must(tree, ["checkout", "--quiet", "--detach", pr.head]);
    return;
  }
  const local = await g(tree, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${pr.branch}^{commit}`,
  ]);
  if (local.code !== 0) {
    await must(tree, ["switch", "--quiet", "--create", pr.branch, pr.head]);
    await must(tree, [
      "branch",
      "--quiet",
      `--set-upstream-to=${DRIVE_REMOTE}/${pr.branch}`,
    ]);
    return;
  }
  const tip = local.stdout.trim();
  if (!(await ancestor(tree, tip, pr.head)))
    refuse(
      2,
      `the local branch '${pr.branch}' has commits PR #${pr.number}'s head does not — push or drop them first`,
    );
  await must(tree, ["switch", "--quiet", pr.branch]);
  await must(tree, ["merge", "--quiet", "--ff-only", pr.head]);
}

/** Refuse to leave a detached head whose commits no branch or remote holds. */
async function requireReachable(tree: string, sha: string): Promise<void> {
  const loose = await out(
    tree,
    ["rev-list", "--count", sha, "--not", "--branches", "--remotes"],
    "which of this tree's commits a branch holds",
  );
  if (loose !== "0")
    refuse(
      2,
      `this tree's detached head ${sha.slice(0, 12)} has ${loose} commit(s) no branch or remote holds; moving would orphan them — put them on a branch first`,
    );
}

async function must(tree: string, args: string[]): Promise<void> {
  const r = await g(tree, args);
  if (r.code !== 0)
    refuse(1, `git ${args.join(" ")} failed: ${r.stderr.trim()}`);
}

/** Bring a tree already on the head (by name or recorded) up to it. */
async function catchUp(
  tree: string,
  pr: PrHead & { number: string },
  sha: string,
  detached: boolean,
): Promise<void> {
  if (await ancestor(tree, pr.head, sha)) return;
  if (!(await ancestor(tree, sha, pr.head)))
    refuse(
      2,
      `this tree's ${detached ? "head" : `branch '${pr.branch}'`} has diverged from PR #${pr.number}'s head ${pr.head.slice(0, 12)} — reconcile them first`,
    );
  await must(
    tree,
    detached
      ? ["checkout", "--quiet", "--detach", pr.head]
      : ["merge", "--quiet", "--ff-only", pr.head],
  );
}

interface Current {
  branch: string;
  sha: string;
  primary: boolean;
  gitDir: string;
}

async function currentOf(tree: string): Promise<Current> {
  const gitDir = await gitDirOf(tree);
  const symbolic = await g(tree, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  return {
    branch: symbolic.code === 0 ? symbolic.stdout.trim() : "",
    sha: await out(tree, ["rev-parse", "HEAD"], "this tree's head"),
    primary: await isPrimary(tree, gitDir),
    gitDir,
  };
}

/** Why a live driver keeps the attach from moving this tree, or `null`. */
async function liveDriver(
  pr: string,
  treeLockHeld: boolean,
): Promise<string | null> {
  const stateDir = await resolveStateDir();
  if (!treeLockHeld) {
    const tree = liveHolder(join(stateDir, await worktreeLockName()));
    if (tree !== null)
      return `a live driver${tree.diag ? ` of PR #${tree.diag.pr}` : ""} holds this working tree`;
  }
  const holder = liveHolder(join(stateDir, `pr-drive-${pr}.lock`));
  return holder === null
    ? null
    : `a live driver already holds PR #${pr}${holder.diag?.worktree ? ` in ${holder.diag.worktree}` : ""}`;
}

/** This tree's session-lease fence, held while the attach moves it. */
async function treeFence(pr: string): Promise<{ release(): void } | null> {
  // The fence reads the state directory, which a first drive has not made yet.
  mkdirSync(await resolveStateDir(), { recursive: true });
  const ctx = await resolveFenceContext("attach-pr.ts");
  if (ctx === null) return null;
  const lock = await assertTreeMutationAllowed(ctx, pr, "attach-pr.ts");
  return {
    release: () => {
      lock.release();
      lock.dispose();
    },
  };
}

/**
 * Put the tree on the head; whether it ended detached. A detached tree this
 * PR was attached to keeps its own commits on top of the head, and takes the
 * branch by name once no other tree holds it and it has none of its own.
 */
async function move(
  tree: string,
  target: PrHead & { number: string },
  current: Current,
): Promise<boolean> {
  const holder = await holderOf(tree, target.branch);
  if (current.branch === target.branch) {
    await catchUp(tree, target, current.sha, false);
    return false;
  }
  const recorded = await detachedTreeRecord((args) => g(tree, args));
  if (
    current.branch === "" &&
    recorded?.pr === Number(target.number) &&
    (holder !== null || !(await ancestor(tree, current.sha, target.head)))
  ) {
    if (holder !== null) await requireHolderBehind(holder, target);
    await catchUp(tree, target, current.sha, true);
    return true;
  }
  if (holder !== null) await requireHolderBehind(holder, target);
  await moveTree(tree, target, current, holder === null);
  return holder !== null;
}

/**
 * The driver locks a standalone attach takes, in `drive.ts`'s order (the
 * tree's, then the pull request's), so no driver starts on this tree or the
 * pull request while it moves the tree; released by the caller.
 */
async function takeDriverLocks(pr: string): Promise<DriveLock[]> {
  const stateDir = await resolveStateDir();
  const locks: DriveLock[] = [
    { dir: join(stateDir, await worktreeLockName()), what: "worktree" },
    { dir: join(stateDir, `pr-drive-${pr}.lock`), what: `PR #${pr}` },
  ];
  const taken: DriveLock[] = [];
  try {
    for (const lock of locks) {
      acquire(lock, pr);
      taken.push(lock);
    }
  } catch (e) {
    for (const lock of taken.reverse()) release(lock);
    throw e;
  }
  return taken;
}

/**
 * Attach PR `pr` to the working tree the process runs in. A live driver of
 * this tree (unless the caller holds its lock) or of the PR leaves it as it
 * is and says so in `skipped`.
 *
 * The tree is read only once it is owned: alone, the attach takes both driver
 * locks; then, after the fetch, the tree's session-lease fence; and only then
 * reads the tree's head, cleanliness and reachable commits it moves on, so
 * nothing that commits in between is moved around. The drive state is
 * written after the fence is released, because a state write takes the
 * store's lock before a tree fence, and the attach must not take them in the
 * opposite order.
 */
export async function attachPr(
  pr: string,
  opts: Options = {},
): Promise<Attached> {
  const tree = canonical(
    await out(
      process.cwd(),
      ["rev-parse", "--show-toplevel"],
      "this working tree",
    ),
  );
  const head = await readPr(pr, tree);
  const number = String(Number.parseInt(pr, 10));
  const base = {
    pr: number,
    branch: head.branch,
    remote: DRIVE_REMOTE,
    head: head.head,
    worktree: tree,
    created: opts.created === true,
  };
  const live = await liveDriver(number, opts.treeLockHeld === true);
  if (live !== null) {
    const symbolic = await g(tree, ["symbolic-ref", "--quiet", "HEAD"]);
    return { ...base, detached: symbolic.code !== 0, skipped: live };
  }
  const locks = opts.treeLockHeld === true ? [] : await takeDriverLocks(number);
  try {
    await requireOrigin(tree, head, number);
    const fetched = await fetchHead(tree, head.branch);
    if (fetched !== null) refuse(1, fetched);
    if ((await g(tree, ["cat-file", "-e", `${head.head}^{commit}`])).code !== 0)
      refuse(
        1,
        `the fetched '${head.branch}' does not hold PR #${number}'s head ${head.head.slice(0, 12)} (pushed again while attaching?) — run the attach again`,
      );
    const fence = await treeFence(number);
    let detached: boolean;
    let created: boolean;
    try {
      const current = await currentOf(tree);
      await requireSettled(tree, "this working tree");
      const old = readDrivenTree(current.gitDir);
      detached = await move(tree, { ...head, number }, current);
      created =
        opts.created === true ||
        (old?.pr === Number(number) && old.created === true);
      // The tree's record exists only while the tree is detached: on a
      // branch, the branch answers, and a stale record could only mislead.
      if (detached)
        writeDrivenTree(current.gitDir, {
          pr: Number(number),
          branch: head.branch,
          remote: DRIVE_REMOTE,
          created,
          head: head.head,
        });
      else removeDrivenTree(current.gitDir);
    } finally {
      fence?.release();
    }
    created = await recordState(number, tree, {
      branch: head.branch,
      remote: DRIVE_REMOTE,
      detached,
      created,
    });
    return { ...base, detached, created };
  } finally {
    for (const lock of locks.reverse()) release(lock);
  }
}

/** The tree holding the branch must hold nothing the PR's head lacks. */
async function requireHolderBehind(
  holder: string,
  pr: PrHead & { number: string },
): Promise<void> {
  await requireSettled(holder, "the working tree holding the branch");
  const ahead = await g(holder, [
    "rev-list",
    "--count",
    `${pr.head}..refs/heads/${pr.branch}`,
  ]);
  if (ahead.code !== 0)
    refuse(1, `cannot compare '${pr.branch}' in ${holder} with the PR's head`);
  if (ahead.stdout.trim() !== "0")
    refuse(
      2,
      `the working tree holding '${pr.branch}' (${holder}) has ${ahead.stdout.trim()} commit(s) PR #${pr.number}'s head does not — push them from there first, or the drive would work around them`,
    );
}

/** Fetch the head branch; the error, or `null` when it was fetched. */
async function fetchHead(tree: string, branch: string): Promise<string | null> {
  const timeout = fetchTimeoutSeconds();
  if (!timeout.ok) return `DRIVE_PR_FETCH_TIMEOUT='${timeout.raw}' is invalid`;
  const r = await g(
    tree,
    [
      "fetch",
      "--quiet",
      DRIVE_REMOTE,
      `+refs/heads/${branch}:refs/remotes/${DRIVE_REMOTE}/${branch}`,
    ],
    timeout.seconds,
  );
  return r.code === 0
    ? null
    : `cannot fetch '${branch}' from '${DRIVE_REMOTE}': ${r.stderr.trim()}`;
}

/**
 * Copy the attach into the drive state; whether the tree was created for the
 * drive. That provenance outlives an attach by name, which removes the tree's
 * record: a later attach of the same tree keeps what the state says of it.
 */
async function recordState(
  pr: string,
  tree: string,
  record: Pick<DrivenTree, "branch" | "remote" | "created"> & {
    detached: boolean;
  },
): Promise<boolean> {
  const store = await openStore(pr);
  let created = record.created;
  await store.update((s) => {
    created ||=
      s.drivenBranch?.worktree === tree && s.drivenBranch.created === true;
    return {
      ...s,
      drivenBranch: {
        branch: record.branch,
        remote: record.remote,
        worktree: tree,
        detached: record.detached,
        created,
        at: new Date().toISOString(),
      },
    };
  });
  return created;
}

/**
 * `drive.ts`'s attach, once it holds the tree's driver lock and before it
 * takes the pull request's. Skipped by a dry run, which moves nothing, and by
 * `DRIVE_PR_ATTACH=off`, which drives the tree as it stands (a harness that
 * prepares its trees itself). A live driver already holding the PR leaves
 * the tree alone: the PR lock refuses this drive next.
 */
export async function attachForDrive(
  pr: string,
  dryRun: boolean,
): Promise<void> {
  const mode = process.env.DRIVE_PR_ATTACH ?? "";
  if (mode !== "" && mode !== "on" && mode !== "off")
    fail(2, `drive.ts: DRIVE_PR_ATTACH must be on or off (got '${mode}')`);
  if (dryRun || mode === "off") return;
  let attached: Attached;
  try {
    attached = await attachPr(pr, { treeLockHeld: true });
  } catch (e) {
    if (e instanceof AttachRefusal) fail(e.code, `drive.ts: ${e.message}`);
    throw e;
  }
  setDrivenRemoteRef(attached.remote, attached.branch);
  console.error(
    attached.skipped !== undefined
      ? `attach: ${attached.skipped}; not attaching`
      : attached.detached
        ? `attach: PR #${pr} detached at ${attached.head.slice(0, 12)} in ${attached.worktree} (another working tree holds '${attached.branch}')`
        : `attach: PR #${pr} on '${attached.branch}' in ${attached.worktree}`,
  );
}
