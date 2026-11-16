/** Inventory is safe without the session opener's lifecycle and lock protocol. */
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import {
  orcaEnvelope,
  orcaFailure,
  orcaResult,
  runOrca,
} from "../../shared/orca.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { run } from "../../shared/proc.ts";
import { spawnSync } from "../../shared/guarded-git-spawn.ts";
import { HOOKS_DIR, hookPath } from "../../shared/worktree-hooks.ts";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from "node:path";
import { gcGit as git, gitEnvironment } from "../git.ts";
import {
  localSteps,
  removalUnsettled,
  removeThroughOrca,
  removeWithGit,
} from "../worktree-removal.ts";
import { processHolder } from "./worktree-git.ts";
import {
  type Collected,
  goneClaims,
  isUnreadableClaim,
  onDisk,
  proveUnreadable,
  standingClaims,
  unreadableClaims,
  guardedCollection,
  type GuardedRemoval,
  isGoneClaim,
  isSupersededClaim,
  LAUNCH_VETO,
  proveGone,
  proveSuperseded,
  releaseGone,
  releaseSupersededClaim,
  supersededClaims,
} from "./worktree-guard.ts";
import {
  markingSince,
  type Archived,
  type ArchivePolicy,
  type LegacyPolicy,
} from "../legacy-archive.ts";
import {
  canonicalWorktree,
  orcaLiveness,
  preserveLegacyContent,
  runtimeWorktreeProof,
  unchangedSinceProof,
  worktreeIdentity,
  worktreePolicy,
  worktreeProof,
  type WorktreeIdentity,
  type WorktreePolicy,
} from "./worktree-proof.ts";
import {
  keepHolds,
  releaseHolds,
  unchangedAndHeld,
  holdableIdentity,
  type HeadHold,
} from "./worktree-head-hold.ts";
import type { CollectionKind, Proof, Resource } from "../types.ts";
import { DEFAULT_REGENERABLE_PATHS } from "../regenerable-paths.ts";
import { currentMs } from "../../shared/time.ts";
import { shellQuote } from "../../shared/cli.ts";

/** Seconds `orca worktree rm` may take: it deletes the checkout's files. */
const ORCA_REMOVE_TIMEOUT_SEC = 300;
/** The time a removal through Orca may take: the remove hook, the park and the removal. */
const ORCA_REMOVAL_LIMIT_MS = 30 * 60_000;
/**
 * Where Claude Code's agent tool makes a worktree for each isolated subagent,
 * under the clone's primary checkout, and the `runtime` the inventory marks
 * its worktrees with.
 */
const AGENT_TOOL_DIR = [".claude", "worktrees"];
const AGENT_TOOL = "agent-tool";
/** Seconds `git worktree remove` may take: it deletes the checkout's files, dependency directories included. */
const GIT_REMOVE_TIMEOUT_SEC = 300;
/** The time the one-time archive of a worktree's ignored content may take. */
const ARCHIVE_LIMIT_MS = 5 * 60_000;

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}
/** A worktree Orca manages: its id, and its path exactly as Orca reports it. */
interface OrcaWorktree {
  id: string;
  path: string;
}
/**
 * The worktrees Orca manages in `repository`, by path as git spells it, with
 * Orca's id and path of each; empty when Orca has no such repository. A list
 * Orca cannot give in full fails the inventory: a checkout it manages must
 * not pass for a plain one.
 */
async function orcaWorktrees(
  command: string,
  repository: string,
): Promise<Outcome<Map<string, OrcaWorktree>>> {
  const done = await runOrca(command, [
    "worktree",
    "list",
    "--repo",
    `path:${repository}`,
    "--json",
  ]);
  const envelope = orcaEnvelope(done.stdout);
  if (envelope?.ok === false && envelope.code === "repo_not_found")
    return ok(new Map());
  const result = orcaResult(done);
  if (result === null)
    return failed(
      "orca-unreadable",
      `Orca's worktree list could not be read ${orcaFailure(done)}`,
    );
  if (result.truncated !== false || !Array.isArray(result.worktrees))
    return failed(
      "malformed",
      "Orca's worktree list was incomplete or malformed",
    );
  const managed = new Map<string, OrcaWorktree>();
  for (const row of result.worktrees) {
    if (
      !isMapping(row) ||
      typeof row.id !== "string" ||
      typeof row.path !== "string"
    )
      return failed("malformed", "Malformed Orca worktree record");
    managed.set(canonicalWorktree(row.path), { id: row.id, path: row.path });
  }
  return ok(managed);
}
/** Whether Orca's list `managed` holds the worktree at `path`, as Orca spells it or as git does. */
function listedIn(
  managed: Map<string, OrcaWorktree>,
): (path: string) => boolean {
  const paths = new Set([...managed.values()].map((row) => row.path));
  return (path) => paths.has(path) || managed.has(normalize(path));
}
/**
 * The selected worktrees, each marked with the runtime that manages it, and
 * a line for each claim a collector of `repository` that ended left on a
 * worktree under `roots` that is gone from Orca's list and from the disk, or
 * was made again since: no worktree is listed to settle it with.
 */
async function orcaInventory(
  command: string,
  repository: string,
  selected: { id: string; details: Record<string, unknown> }[],
  roots: string[],
): Promise<Outcome<Resource[]>> {
  const mine = (path: string) =>
    roots.some(
      (root) => within(normalize(path), root) || underRoot(path, root),
    );
  const stale = goneClaims(mine, repository);
  // Claims settled, or reported, without Orca's list.
  const unlisted = [...unreadableClaims(), ...supersededClaims(mine)];
  if (selected.length === 0 && stale.length === 0)
    return ok([...selected, ...unlisted]);
  const managed = await orcaWorktrees(command, repository);
  if (!managed.ok) return managed;
  const listed = listedIn(managed.value);
  // A checkout gone from the disk can still be registered with Git: the claim
  // is then the resource, not the registration.
  const known = new Set(
    selected
      .filter((entry) => onDisk(entry.id))
      .map((entry) => resolvedPath(entry.id)),
  );
  const gone = stale.filter(
    (claim) => !listed(claim.id) && !known.has(resolvedPath(claim.id)),
  );
  const replaced = new Set(gone.map((claim) => resolvedPath(claim.id)));
  const standing = standingClaims();
  const kept = selected.filter(
    (entry) => !replaced.has(resolvedPath(entry.id)),
  );
  markManaged(kept, managed.value);
  for (const entry of kept) {
    const row = managed.value.get(canonicalWorktree(entry.id));
    const path = row?.path ?? entry.id;
    if (standing.has(path)) {
      const submitted = standing.get(path);
      entry.details.claim = "standing";
      entry.details.claimNote = `a dead collection's launch guard claim stands on this worktree${submitted ? ` (orca worktree rm was called under it at ${submitted})` : ""} and keeps launches out; it is settled by a collection that removes the worktree, or inspect and remove its admission by hand`;
    }
  }
  return ok([...kept, ...gone, ...unlisted]);
}
/** The path with its nearest existing ancestor resolved, the spelling git and the disk agree on. */
function resolvedPath(path: string): string {
  let ancestor = normalize(path);
  let suffix = "";
  for (;;) {
    try {
      return join(realpathSync.native(ancestor), suffix);
    } catch (error) {
      swallow(error, "the ancestor is gone: the next one up is tried");
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return normalize(path);
    suffix = join(basename(ancestor), suffix);
    ancestor = parent;
  }
}
/** Whether the claim's `path` lies under `root` once its nearest existing ancestor is resolved. */
function underRoot(path: string, root: string): boolean {
  return within(resolvedPath(path), root);
}
function orcaId(resource: Resource): string | null {
  return isMapping(resource.details) &&
    resource.details.runtime === "orca" &&
    typeof resource.details.orca === "string"
    ? resource.details.orca
    : null;
}
/** The worktree's path exactly as Orca reports it: what its guard key is taken of. */
function orcaPath(resource: Resource): string | null {
  return isMapping(resource.details) &&
    typeof resource.details.orcaPath === "string"
    ? resource.details.orcaPath
    : null;
}
/**
 * The base-branch commit's hooks directory, extracted to a directory of its
 * own: collection runs that copy, never the retiring branch's, so the hook and
 * the files beside it are the bytes the base branch holds, which a branch
 * cannot change. A helper a hook starts from the checkout, and the checkout's
 * Bun startup file, are the branch's own: a `bunfig.toml` that differs from the
 * base branch's is refused, since it could preload code into the hook's Bun.
 * The base commit decides whether a hook exists: null when neither it nor the
 * checkout holds one.
 */
async function snapshotBaseHooks(
  repository: string,
  declaration: string,
  worktree: string,
): Promise<Outcome<{ hook: string; dir: string } | null>> {
  const tip = / @ ([0-9a-f]{40,64})$/.exec(declaration)?.[1];
  if (tip === undefined)
    return failed(
      "unknown-base",
      "the base-branch commit of the declaration is unknown",
    );
  const held = await git(repository, [
    "ls-tree",
    "--name-only",
    tip,
    "--",
    `${HOOKS_DIR}/remove`,
  ]);
  if (!held.ok) return held;
  if (held.value === "") {
    // The base branch decides whether a teardown is required; a checkout that
    // brings a hook of its own the base never reviewed is still refused.
    if (hookPath(worktree, "remove") === null) return ok(null);
    return failed(
      "unreviewed-hook",
      `kept: ${HOOKS_DIR}/remove is not in the base branch, so its code was never reviewed there`,
    );
  }
  const startup = await requireBaseBunfig(repository, tip, worktree);
  if (!startup.ok) return startup;
  const dir = mkdtempSync(join(tmpdir(), "jig-gc-hooks-"));
  const hook = join(dir, HOOKS_DIR, "remove");
  let extracted: Outcome<undefined>;
  try {
    extracted = await extractBaseHooks(repository, tip, dir);
    if (extracted.ok) accessSync(hook, constants.X_OK);
  } catch (error) {
    extracted = failed(
      "hook-unrunnable",
      `kept: the base branch's ${HOOKS_DIR}/remove cannot run (${error instanceof Error ? error.message : String(error)})`,
      error,
    );
  }
  if (!extracted.ok) {
    rmSync(dir, { recursive: true, force: true });
    return extracted;
  }
  return ok({ hook, dir });
}
/** Refuse a checkout whose Bun startup file is not the base branch's. */
async function requireBaseBunfig(
  repository: string,
  tip: string,
  worktree: string,
): Promise<Outcome<undefined>> {
  const startup = join(worktree, "bunfig.toml");
  if (!existsSync(startup)) return ok(undefined);
  const local = await git(repository, ["hash-object", "--no-filters", startup]);
  if (!local.ok) return local;
  // A base branch without the file, or one git cannot read, holds no match.
  const base = await git(repository, ["rev-parse", `${tip}:bunfig.toml`]).then(
    (read) => (read.ok ? read.value : ""),
    () => "",
  );
  if (local.value !== base)
    return failed(
      "startup-differs",
      "kept: bunfig.toml differs from the base branch's; remove the worktree by hand",
    );
  return ok(undefined);
}
/**
 * Extract the commit's hooks directory into `dir`, then check every committed
 * file as extracted: `git archive` honours export-ignore and export-subst, and
 * what runs must be the committed bytes.
 */
async function extractBaseHooks(
  repository: string,
  tip: string,
  dir: string,
): Promise<Outcome<undefined>> {
  const env = gitEnvironment() as Record<string, string>;
  const archive = join(dir, "hooks.tar");
  const spawned: [string, string[]][] = [
    [
      "git",
      [
        "--no-replace-objects",
        "-C",
        repository,
        "archive",
        "--format=tar",
        "-o",
        archive,
        tip,
        "--",
        HOOKS_DIR,
      ],
    ],
    ["tar", ["-xf", archive, "-C", dir]],
  ];
  for (const [file, args] of spawned) {
    const done = spawnSync(file, args, { env, timeout: 60_000 });
    if (done.status !== 0)
      return failed(
        "hook-unrunnable",
        `could not extract ${HOOKS_DIR} from the base branch`,
      );
  }
  const listed = await git(repository, [
    "ls-tree",
    "-r",
    "-z",
    tip,
    "--",
    HOOKS_DIR,
  ]);
  if (!listed.ok) return listed;
  for (const row of listed.value.split("\0").filter((entry) => entry !== "")) {
    const match = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/s.exec(row);
    if (match === null)
      return failed(
        "hook-unrunnable",
        `kept: ${HOOKS_DIR} in the base branch holds an entry that is not a plain file`,
      );
    const [, , oid, path] = match;
    const extracted = join(dir, path ?? "");
    if (!existsSync(extracted))
      return failed(
        "hook-unrunnable",
        `kept: ${path} was changed or left out by git archive's export attributes`,
      );
    const hashed = await git(repository, [
      "hash-object",
      "--no-filters",
      extracted,
    ]);
    if (!hashed.ok) return hashed;
    if (hashed.value !== oid)
      return failed(
        "hook-unrunnable",
        `kept: ${path} was changed or left out by git archive's export attributes`,
      );
  }
  return ok(undefined);
}
/** The answer with what a hold left appended to its reason, when one did. */
function withKept(collected: Collected, left: string | null): Collected {
  return left === null
    ? collected
    : { ...collected, reason: `${collected.reason}; ${left}` };
}

/**
 * Collect a worktree Orca manages through Orca: the repository's remove hook
 * inside it, its reflection findings parked, then `orca worktree rm`, so its
 * card, terminals and agent records go with it. Never `git worktree remove`.
 * Its head is held from the final comparison with `identity`, what the
 * runner's final proof saw, through that call.
 */
async function collectThroughOrca(
  command: string,
  resource: Resource,
  orcaWorktree: { id: string; guard: GuardedRemoval },
  repository: string,
  declaration: string,
  legacy: LegacyPolicy | undefined,
  regenerablePaths: readonly string[],
  identity: WorktreeIdentity | undefined,
): Promise<Collected> {
  const { id, guard } = orcaWorktree;
  const { launched } = guard;
  let archived: Archived | null = null;
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const holds: HeadHold[] = [];
  // Every answer releases the hold, and says so when the release failed.
  const released = (collected: Collected): Collected =>
    withKept(collected, releaseHolds(holds, log));
  const failure = (outcome: { failure: { code: string; reason: string } }) =>
    released({
      outcome: outcome.failure.code === LAUNCH_VETO ? "refused" : "failed",
      reason: outcome.failure.reason,
    });
  let snapshot: { hook: string; dir: string } | null = null;
  try {
    const holdable = await holdableIdentity(resource.id, identity);
    if ("stop" in holdable) return holdable.stop;
    // The retiring branch supplies the hook, and this runs unattended, so the
    // hook that runs is the declared base-branch commit's, never the branch's.
    const taken = await snapshotBaseHooks(repository, declaration, resource.id);
    if (!taken.ok) return failure(taken);
    snapshot = taken.value;
    const base = snapshot;
    const removed = await removeThroughOrca({
      worktree: resource.id,
      id,
      force: false,
      orca: (args) =>
        run([command, ...args, "--json"], {
          timeoutSec: ORCA_REMOVE_TIMEOUT_SEC,
        }),
      log,
      steps: {
        ...localSteps(currentMs() + ORCA_REMOVAL_LIMIT_MS, log),
        hook: () => base?.hook ?? null,
        // The hook may run for minutes: Orca can start an agent meanwhile, and
        // the hook can leave a process in the checkout that outlives it.
        admit: (worktree) =>
          admitAfterHook(
            worktree,
            legacy,
            async (final) => {
              const live = await orcaLiveness(command, worktree);
              if (live !== null)
                return failed("live", `kept after the hook: ${live.reason}`);
              // Read after the registry and after gc's admission: a launch the
              // plugin let through meanwhile left its marker first.
              const launch = launched();
              if (launch !== null)
                return failed(LAUNCH_VETO, `kept after the hook: ${launch}`);
              const held = await unheld(worktree);
              if (!held.ok) return held;
              // Last, as on an agent tool's tree: nothing slow follows it.
              return unchangedAndHeld(
                worktree,
                holdable.identity,
                final,
                holds,
              );
            },
            (written) => {
              archived = written;
            },
            regenerablePaths,
          ),
        // The last step before the call: an unanswered call keeps the claim.
        submit: () => guard.submit(),
      },
    });
    guard.settle(removed);
    // An archive written before a step that then failed stays, named in the
    // receipt, and expires with the receipts.
    if (!removed.ok) {
      // Orca may be deleting the worktree still, by this call or by the dead
      // run's whose admission was taken over: the hold stays, as the claim.
      const left =
        removalUnsettled(removed) || guard.unsettled()
          ? keepHolds(holds)
          : null;
      return withArchiveOf(withKept(failure(removed), left), archived);
    }
    return released({
      outcome: "collected",
      reason: `removed through Orca: ${removed.value.hook === null ? `no ${HOOKS_DIR}/remove` : `ran ${HOOKS_DIR}/remove`}, parked reflection findings,${archiveNote(archived)} orca worktree rm`,
      details: {
        ...(isMapping(resource.details) ? resource.details : {}),
        hook: removed.value.hook,
        parked: true,
        ...(archived === null ? {} : { archive: archived }),
      },
    });
  } catch (error) {
    // A step that throws (a platform error, or a defect) fails the removal.
    const failed = withArchiveOf(
      {
        outcome: "failed",
        reason: error instanceof Error ? error.message : String(error),
      },
      archived,
    );
    // A submitted admission, this run's or a dead run's taken over, may still
    // be removing the worktree: the hold stays, as the claim does.
    if (!guard.unsettled()) return released(failed);
    return withKept(failed, keepHolds(holds));
  } finally {
    releaseHolds(holds, log);
    if (snapshot !== null)
      rmSync(snapshot.dir, { recursive: true, force: true });
  }
}
/** Kept when a process holds the worktree, or holders could not be read. */
async function unheld(worktree: string): Promise<Outcome<undefined, string>> {
  if ((await processHolder(worktree)) !== false)
    return failed(
      "held",
      "kept after the hook: a process holds the worktree, or holders could not be read",
    );
  return ok(undefined);
}
/**
 * The last admission before a worktree goes, after its hook and park: what
 * removal relies on (`checks`), the one-time archive of its ignored content,
 * then `checks` again, since the archive may have run for minutes and an
 * agent or process can have started meanwhile; that second run is told it is
 * the `final` one, the last before removal. `archived` is told of an
 * archive as soon as it is written, so every failure after it names it.
 */
async function admitAfterHook(
  worktree: string,
  legacy: LegacyPolicy | undefined,
  checks: (final: boolean) => Promise<Outcome<undefined, string>>,
  archived: (written: Archived | null) => void,
  regenerablePaths: readonly string[],
): Promise<Outcome<undefined, string>> {
  const before = await checks(false);
  if (!before.ok) return before;
  // Last, so the archive holds the content as the removal finds it.
  const preserved = await preserveLegacyContent(
    worktree,
    legacy,
    currentMs() + ARCHIVE_LIMIT_MS,
    regenerablePaths,
  );
  if (!preserved.ok) return preserved;
  archived(preserved.value);
  const after = await checks(true);
  if (!after.ok) return after;
  return ok(undefined);
}
/**
 * Collect a worktree an agent tool made: the base branch's remove hook inside
 * it, its reflection findings parked, then `git worktree remove` without
 * `--force`, so git itself refuses a checkout that gained changes. No runtime
 * keeps records of it, so there is nothing else to remove.
 */
async function collectAgentWorktree(
  resource: Resource,
  repository: string,
  declaration: string,
  legacy: LegacyPolicy | undefined,
  identity: WorktreeIdentity | undefined,
  regenerablePaths: readonly string[],
): Promise<Collected> {
  let archived: Archived | null = null;
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  // The head held from the final comparison through the removal.
  const holds: HeadHold[] = [];
  // Every answer once the hold may be taken releases it, and says so when
  // the release failed, since the lock then keeps git from moving the head.
  const withArchive = (collected: Collected): Collected =>
    withKept(withArchiveOf(collected, archived), releaseHolds(holds, log));
  let snapshot: { hook: string; dir: string } | null = null;
  try {
    // The commit and branch the runner's final proof saw: every check before
    // removal holds the tree to them.
    const holdable = await holdableIdentity(resource.id, identity);
    if ("stop" in holdable) return holdable.stop;
    const taken = await snapshotBaseHooks(repository, declaration, resource.id);
    if (!taken.ok) return { outcome: "failed", reason: taken.failure.reason };
    snapshot = taken.value;
    const base = snapshot;
    const removed = await removeWithGit({
      worktree: resource.id,
      log,
      steps: {
        ...localSteps(currentMs() + ORCA_REMOVAL_LIMIT_MS, log),
        hook: () => base?.hook ?? null,
        // The hook and the park may run for minutes, a subagent can commit
        // meanwhile, and the hook can leave a process that outlives it.
        admit: (worktree) =>
          admitAfterHook(
            worktree,
            legacy,
            // The holder read can take half a minute, so the identity
            // comparison goes last: nothing slow stands between it and removal.
            async (final) => {
              const held = await unheld(worktree);
              if (!held.ok) return held;
              return unchangedAndHeld(
                worktree,
                holdable.identity,
                final,
                holds,
              );
            },
            (written) => {
              archived = written;
            },
            regenerablePaths,
          ),
      },
      remove: (worktree) => gitRemove(repository, worktree),
    });
    if (!removed.ok)
      return withArchive({ outcome: "failed", reason: removed.failure.reason });
    return withArchive({
      outcome: "collected",
      reason: `removed with git: ${removed.value.hook === null ? `no ${HOOKS_DIR}/remove` : `ran ${HOOKS_DIR}/remove`}, parked reflection findings,${archiveNote(archived)} git worktree remove`,
      details: {
        ...(isMapping(resource.details) ? resource.details : {}),
        hook: removed.value.hook,
        parked: true,
      },
    });
  } catch (error) {
    // A step that throws (a platform error, or a defect) fails the removal;
    // its stack goes to the log, since the receipt keeps the message only.
    log(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return withArchive({
      outcome: "failed",
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    releaseHolds(holds, log);
    if (snapshot !== null)
      rmSync(snapshot.dir, { recursive: true, force: true });
  }
}
/** `collected` naming the archive written before removal, when there is one. */
function withArchiveOf(
  collected: Collected,
  archived: Archived | null,
): Collected {
  if (archived === null) return collected;
  return {
    ...collected,
    details: {
      ...(isMapping(collected.details) ? collected.details : {}),
      archive: archived,
    },
  };
}
/**
 * `git worktree remove` without `--force`, under its own deadline: it deletes
 * the checkout's files, dependency directories included.
 */
async function gitRemove(
  repository: string,
  worktree: string,
): Promise<Outcome<undefined>> {
  const done = await git(
    repository,
    ["worktree", "remove", worktree],
    GIT_REMOVE_TIMEOUT_SEC,
  );
  return done.ok
    ? ok(undefined)
    : failed(
        "git-refused",
        `${done.failure.reason}; a removal cut short leaves the tree partly deleted: inspect it, then run git worktree remove --force on it`,
      );
}
/** Whether the inventory found the worktree in the agent tool's directory. */
function isAgentTool(resource: Resource): boolean {
  return isMapping(resource.details) && resource.details.runtime === AGENT_TOOL;
}
/**
 * What a kept agent tool's worktree on a branch adds to its reason: the
 * branch it holds, which no other worktree can then check out (a workspace
 * manager makes a `<branch>-2` one instead), and the command that releases it
 * while keeping every file and commit.
 */
async function heldBranch(path: string): Promise<string | null> {
  const name = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!name.ok)
    return `the branch it holds could not be read (${name.failure.reason})`;
  if (name.value === "HEAD" || name.value === "") return null;
  return `it holds branch ${name.value}; \`git -C ${shellQuote(path)} switch --detach\` releases the branch and keeps the worktree as it is`;
}
/** A kept agent tool's worktree's proof, with the branch it holds named. */
async function withHeldBranch(
  resource: Resource,
  proof: Proof,
): Promise<Proof> {
  if (!isAgentTool(resource) || proof.state === "dead") return proof;
  const held = await heldBranch(resource.id);
  return held === null
    ? proof
    : { ...proof, reason: `${proof.reason}; ${held}` };
}
/** What the receipt's reason says of an archive written before removal. */
function archiveNote(archived: Archived | null): string {
  return archived === null
    ? ""
    : ` archived ${archived.paths.length} ignored path(s), ${archived.bytes} bytes, to ${archived.path},`;
}
/**
 * The archive policy with the instant marking began on this host, read once
 * per run; undefined, so nothing is archived, without a policy or when the
 * instant cannot be read or recorded.
 */
function legacyPolicy(
  archive: ArchivePolicy | undefined,
): () => LegacyPolicy | undefined {
  let read: { value: LegacyPolicy | undefined } | undefined;
  return () => {
    if (read === undefined) {
      // Stamped even while archiving is off, so enabling it later does not
      // date the worktrees made meanwhile as older than marking.
      const since =
        archive === undefined ? undefined : markingSince(archive.root);
      read = {
        value:
          archive !== undefined && archive.maxBytes > 0 && since?.ok
            ? { ...archive, since: since.value }
            : undefined,
      };
    }
    return read.value;
  };
}
/** A worktree as the inventory lists it, before any proof. */
type Listed = { id: string; details: Record<string, unknown> };
/** A root as git spells a worktree: links resolved and, on Windows, 8.3 short names expanded. */
function canonicalRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return root;
    throw error;
  }
}
/**
 * The linked worktrees in a declared root, and those in the agent tool's
 * directory, marked `runtime: agent-tool`. That directory is derived, not
 * declared: it sits in the primary checkout git lists first, whatever roots
 * the clone declares.
 */
function selectWorktrees(
  entries: Listed[],
  roots: string[],
  repository: string,
): Listed[] {
  const canonical = roots.map(canonicalRoot);
  const primary = entries[0]?.id ?? repository;
  const agentRoot = canonicalRoot(join(primary, ...AGENT_TOOL_DIR));
  return entries.slice(1).filter((entry) => {
    if (within(entry.id, agentRoot)) {
      entry.details.runtime = AGENT_TOOL;
      return true;
    }
    return canonical.some((root) => within(entry.id, root));
  });
}
/** Mark each worktree Orca manages `runtime: orca`, with its id and path; the rest `none`, an agent tool's left as it is. */
function markManaged(
  selected: Listed[],
  managed: Map<string, OrcaWorktree>,
): void {
  for (const entry of selected) {
    const row = managed.get(canonicalWorktree(entry.id));
    if (row === undefined) {
      if (entry.details.runtime !== AGENT_TOOL) entry.details.runtime = "none";
      continue;
    }
    entry.details.runtime = "orca";
    entry.details.orca = row.id;
    entry.details.orcaPath = row.path;
  }
}
/** The proof of a claim resource (an admission with no worktree to prove), or null for a worktree. */
function proveClaim(
  orca: string,
  resource: Resource,
  repository: string,
): Proof | Promise<Proof> | null {
  if (isUnreadableClaim(resource)) return proveUnreadable(resource);
  if (isSupersededClaim(resource)) return proveSuperseded();
  if (!isGoneClaim(resource)) return null;
  return proveGone(resource, async () => {
    const managed = await orcaWorktrees(orca, repository);
    return managed.ok ? ok(listedIn(managed.value)) : managed;
  });
}
/** The proof that needs no policy: a claim resource, or a locked worktree; null otherwise. */
function proveEarly(
  orca: string | undefined,
  resource: Resource,
  repository: string,
): Proof | Promise<Proof> | null {
  const claim =
    orca === undefined ? null : proveClaim(orca, resource, repository);
  if (claim !== null) return claim;
  if (!isMapping(resource.details) || resource.details.locked !== true)
    return null;
  return withHeldBranch(resource, {
    state: "live",
    reason: "worktree is locked",
  });
}
export function worktreesKind(
  repository: string,
  roots: string[],
  declaration: string,
  idleDays = 7,
  policy?: WorktreePolicy,
  orca?: string,
  archive?: ArchivePolicy,
  regenerablePaths: readonly string[] = DEFAULT_REGENERABLE_PATHS,
): CollectionKind {
  const legacy = legacyPolicy(archive);
  // What each agent tool or Orca tree's latest proof saw, for its collection.
  const proved = new Map<string, WorktreeIdentity>();
  return {
    name: "worktrees",
    repository,
    declaration,
    inventory: async () => {
      // The marking boundary is this run's, whether or not a worktree reaches proof.
      legacy();
      const output = await git(repository, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]);
      if (!output.ok) return output;
      const entries: Listed[] = [];
      for (const block of output.value.split("\0\0").filter(Boolean)) {
        const fields = block.split("\0");
        const path = fields.find((field) => field.startsWith("worktree "));
        if (!path) return failed("malformed", "Malformed Git worktree record");
        entries.push({
          // Native separators: Git for Windows prints forward slashes.
          id: normalize(path.slice(9)),
          details: {
            locked: fields.some(
              (field) => field === "locked" || field.startsWith("locked "),
            ),
          },
        });
      }
      if (entries.length === 0)
        return failed(
          "malformed",
          "Git worktree inventory was empty or malformed",
        );
      const selected = selectWorktrees(entries, roots, repository);
      if (orca === undefined) return ok(selected);
      return orcaInventory(orca, repository, selected, [
        ...roots.map(canonicalRoot),
        canonicalRoot(join(entries[0]?.id ?? repository, ...AGENT_TOOL_DIR)),
      ]);
    },
    prove: async (resource) => {
      const early = proveEarly(orca, resource, repository);
      if (early !== null) return early;
      const resolved =
        policy === undefined ? await worktreePolicy(repository) : ok(policy);
      if (!resolved.ok)
        return { state: "unverified", reason: resolved.failure.reason };
      const proving = { ...resolved.value, regenerablePaths, legacy: legacy() };
      const agentTool = isAgentTool(resource);
      const managed = orca !== undefined && orcaId(resource) !== null;
      proved.delete(resource.id);
      // Read before the proof, so the proof's own reads run inside it.
      const seen =
        agentTool || managed ? await worktreeIdentity(resource.id) : null;
      if (seen !== null && !seen.ok)
        return { state: "unverified", reason: seen.failure.reason };
      const result =
        orca !== undefined && managed
          ? await runtimeWorktreeProof(resource.id, proving, idleDays, {
              orca,
            })
          : await worktreeProof(
              resource.id,
              proving,
              idleDays,
              false,
              agentTool,
            );
      if (!result.ok)
        return { state: "unverified", reason: result.failure.reason };
      if (seen !== null && result.value.state === "dead") {
        const same = await unchangedSinceProof(resource.id, seen.value);
        if (!same.ok)
          return { state: "unverified", reason: same.failure.reason };
        proved.set(resource.id, seen.value);
      }
      return withHeldBranch(resource, result.value);
    },
    collect: async (resource) => {
      if (orca !== undefined && isUnreadableClaim(resource))
        return {
          outcome: "refused",
          reason:
            "kept: an admission gc cannot read is for a person to inspect",
        };
      if (orca !== undefined && isGoneClaim(resource))
        return releaseGone(resource, repository);
      if (orca !== undefined && isSupersededClaim(resource))
        return releaseSupersededClaim(resource);
      // What the tree's latest proof saw, taken once.
      const final = proved.get(resource.id);
      proved.delete(resource.id);
      if (isAgentTool(resource))
        return collectAgentWorktree(
          resource,
          repository,
          declaration,
          legacy(),
          final,
          regenerablePaths,
        );
      const id = orcaId(resource);
      if (orca !== undefined && id !== null)
        return guardedCollection(
          resource,
          orcaPath(resource),
          repository,
          (guard) =>
            collectThroughOrca(
              orca,
              resource,
              { id, guard },
              repository,
              declaration,
              legacy(),
              regenerablePaths,
              final,
            ),
        );
      return {
        outcome: "refused",
        reason: "uncoordinated worktrees are report-only",
      };
    },
    describe: (resource) => resource.id,
    exclusive: (body) => body(),
  };
}
