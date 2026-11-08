import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalPath, cloneCheckouts, primaryCheckout } from "./checkout.ts";
import {
  gcConfiguration,
  type MachineConfig,
  type RepositoryEntry,
} from "./config.ts";
import { baseDeclaration, gcGit as git } from "./git.ts";
import { failed, ok, type Outcome } from "../shared/outcome.ts";
import { dump, load } from "../shared/yaml.ts";
import { isMapping } from "../shared/config-layers.ts";
import { remoteHeadBranch, worktreeRemote } from "./kinds/worktree-proof.ts";
import { exclusiveInstallLock } from "../shared/gc-lock.ts";
import {
  checkLauncherResolves,
  detectScheduler,
  installedScript,
  jobPreview,
  restoreScheduler,
  type SchedulerSnapshot,
  snapshotScheduler,
  updateJob,
} from "../runtime/scheduler.ts";
import { gcJobSpec } from "./job-spec.ts";
import { stopped } from "./runner.ts";

/**
 * `jig gc install`: preview the machine entry and the job, and with
 * `confirm` write them. A refused configuration exits 2 and any other
 * refusal 1, each with its reason on standard error (`stopped`).
 */
export async function install(options: {
  repository: string;
  script: string;
  confirm: boolean;
  uninstall: boolean;
  machine: boolean;
}): Promise<number> {
  const supplied = resolve(options.repository);
  // Removal needs only machine policy: a broken checkout cannot obstruct it.
  const repositoryText = options.uninstall ? null : undefined;
  let registered: Outcome<{ root: string; clone: Set<string> }>;
  // Machine-wide removal names no clone, so it never identifies one.
  if (options.machine)
    registered = ok({ root: supplied, clone: new Set<string>() });
  else if (options.uninstall) {
    const own = gcConfiguration(supplied, repositoryText);
    registered = own.ok ? await registration(supplied, own.value.machine) : own;
  } else registered = await registration(supplied, undefined);
  if (!registered.ok) return stopped(registered.failure);
  const { root, clone } = registered.value;
  const configuration = gcConfiguration(root, repositoryText);
  if (!configuration.ok) return stopped(configuration.failure);
  const { machine, machinePath, repositoryValues } = configuration.value;
  let repositories: MachineConfig["repositories"];
  if (options.machine) repositories = [];
  else if (options.uninstall) repositories = otherClones(machine, root, clone);
  else {
    const others = otherClones(machine, root, clone);
    const proposed = await proposedEntry(root, repositoryValues.repository);
    if (!proposed.ok) return stopped(proposed.failure);
    repositories = [...others, proposed.value];
  }
  const next = {
    ...machine,
    repositories,
    ...(options.machine ? { receipts: false } : {}),
  };
  const noEntries = next.repositories.length === 0 && !next.receipts;
  // The job names no repository: removing one while others remain changes
  // only the machine entry, and keeps the job and the programs it recorded.
  const keepJob = options.uninstall && !noEntries;
  console.log(`Machine entry preview (${machinePath}):\n${dump({ gc: next })}`);
  console.log(
    keepJob
      ? "Scheduler preview: the jig-gc job is unchanged"
      : jobPreview(gcJobSpec(next.hour), noEntries),
  );
  if (!options.confirm) {
    console.log(
      "Preview only. Repeat with --yes to confirm these bounds and update the scheduler.",
    );
    return 0;
  }
  if (!installedScript(options.script))
    return stopped({
      code: "refused",
      reason:
        "Scheduler installation requires the installed plugin copy, outside every worktree",
    });
  // Removing an entry withdraws authority, so it never waits on plugin
  // discovery.
  if (!options.uninstall) {
    const resolves = await checkLauncherResolves();
    if (!resolves.ok) return stopped(resolves.failure);
  }
  return exclusiveInstallLock(async () => {
    const original = previousMachineText(machinePath);
    // Refuse a concurrent edit after the preview rather than overwrite it.
    const reread = gcConfiguration(root, repositoryText);
    if (!reread.ok) return stopped(reread.failure);
    if (JSON.stringify(reread.value.machine) !== JSON.stringify(machine))
      return stopped({
        code: "changed",
        reason: "Machine configuration changed during preview; retry install",
      });
    const values: unknown = original ? load(original) : {};
    if (!isMapping(values))
      return stopped({
        code: "invalid",
        reason: "Machine configuration must be a mapping",
      });
    if (keepJob) {
      writeMachine(machinePath, dump({ ...values, gc: next }));
      console.log("Scheduler unchanged: the job still serves the others");
      return 0;
    }
    // Captured before anything changes, so a failure can put back the job
    // that was actually running rather than one rebuilt from this copy.
    const scheduler = detectScheduler();
    if (!scheduler.ok) return stopped(scheduler.failure);
    const previousJob = await snapshotScheduler(scheduler.value, gcJobSpec());
    if (!previousJob.ok) return stopped(previousJob.failure);
    mkdirSync(dirname(machinePath), { recursive: true, mode: 0o700 });
    writeMachine(machinePath, dump({ ...values, gc: next }));
    const job = await updateJob(gcJobSpec(next.hour), noEntries);
    if (!job.ok)
      return stopped({
        ...job.failure,
        reason: `${job.failure.reason}; ${await rollBack(machinePath, original, previousJob.value)}`,
      });
    console.log(`Scheduler ${noEntries ? "removed" : "updated"}: ${job.value}`);
    return 0;
  });
}
/**
 * The path the entry names, the clone's primary checkout, from which the
 * declaration's relative roots resolve whichever worktree install runs in;
 * and every worktree path of the clone, canonical (`canonicalPath`).
 * Removal (`machine` given) from a checkout Git cannot read falls back to the
 * supplied path only when an entry names the same path, so a failure never
 * removes nothing and succeeds.
 */
async function registration(
  supplied: string,
  machine?: MachineConfig,
): Promise<Outcome<{ root: string; clone: Set<string> }, "unidentified">> {
  let checkouts: Awaited<ReturnType<typeof cloneCheckouts>>;
  try {
    checkouts = await cloneCheckouts(supplied);
  } catch (error) {
    checkouts = failed("git-failed", message(error), error);
  }
  if (checkouts.ok) {
    const root = primaryCheckout(supplied, checkouts.value);
    return ok({
      root,
      clone: new Set(
        [root, supplied, ...checkouts.value.worktrees].map(canonicalPath),
      ),
    });
  }
  const own = canonicalPath(supplied);
  if (machine?.repositories.some((entry) => canonicalPath(entry.path) === own))
    return ok({ root: supplied, clone: new Set([own]) });
  return failed(
    "unidentified",
    `Cannot identify the clone at ${supplied}: ${checkouts.failure.reason}`,
  );
}
/**
 * The machine's entries for other clones. An entry naming another of this
 * clone's worktrees (an earlier installer registered the worktree it ran
 * in, or spelled the clone through another path) is this clone's too: the
 * new entry replaces it, with bounds confirmed afresh, and removal takes it
 * with it.
 */
function otherClones(
  machine: MachineConfig,
  root: string,
  clone: Set<string>,
): MachineConfig["repositories"] {
  const ours = (entry: { path: string }) =>
    clone.has(canonicalPath(entry.path));
  for (const entry of machine.repositories)
    if (entry.path !== root && ours(entry))
      console.log(
        `Replacing the entry for ${entry.path}, another path to this clone`,
      );
  return machine.repositories.filter((entry) => !ours(entry));
}
/**
 * The entry install proposes for the repository at `root`: the remote
 * collection reads its worktrees against (`worktreeRemote`), that remote's
 * URL, shown for confirmation, and the repository's declared base branch,
 * else the branch that remote's `HEAD` points at.
 */
async function proposedEntry(
  root: string,
  repository: unknown,
): Promise<Outcome<RepositoryEntry>> {
  const remote = worktreeRemote(root);
  if (!remote.ok) return remote;
  const base =
    isMapping(repository) && typeof repository.base_branch === "string"
      ? ok(repository.base_branch)
      : await remoteHeadBranch(root, remote.value);
  if (!base.ok) return base;
  const url = await git(root, ["remote", "get-url", remote.value]);
  if (!url.ok) return url;
  const entry: RepositoryEntry = {
    path: root,
    remote: remote.value,
    remote_url: url.value.trim(),
    base_branch: base.value,
    bounds: { kinds: [], worktree_roots: [], scratch_prefixes: [] },
  };
  const current = await baseDeclaration(entry);
  if (!current.ok) return current;
  return ok({ ...entry, bounds: current.value.declaration });
}
/** Preserve unrelated YAML settings when only the machine's gc entry changes. */
function previousMachineText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function writeMachine(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
/** A failed scheduler update restores the previous file and the previous job. */
async function rollBack(
  path: string,
  original: string,
  previousJob: SchedulerSnapshot,
): Promise<string> {
  if (original) writeMachine(path, original);
  else rmSync(path, { force: true });
  const restored = await restoreScheduler(previousJob);
  return restored.ok
    ? "machine configuration and previous scheduler job restored"
    : `machine configuration restored; previous scheduler job not restored: ${restored.failure.reason}`;
}
