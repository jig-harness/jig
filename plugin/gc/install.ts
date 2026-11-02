import { GcError } from "../shared/gc-error.ts";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalPath, cloneCheckouts, primaryCheckout } from "./checkout.ts";
import { gcConfiguration, type MachineConfig } from "./config.ts";
import { baseDeclaration, gcGit as git } from "./git.ts";
import { dump, load } from "../shared/yaml.ts";
import { isMapping } from "../shared/config-layers.ts";
import { remoteHeadBranch, worktreeRemote } from "./kinds/worktree-proof.ts";
import { exclusiveGcLock } from "../shared/gc-lock.ts";
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
  // Machine-wide removal names no clone, so it never identifies one.
  const { root, clone } = options.machine
    ? { root: supplied, clone: new Set<string>() }
    : await registration(
        supplied,
        options.uninstall
          ? gcConfiguration(supplied, repositoryText).machine
          : undefined,
      );
  const { machine, machinePath, repositoryValues } = gcConfiguration(
    root,
    repositoryText,
  );
  const repositories = options.machine
    ? []
    : options.uninstall
      ? otherClones(machine, root, clone)
      : [
          ...otherClones(machine, root, clone),
          await proposedEntry(root, repositoryValues.repository),
        ];
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
    throw new GcError(
      "Scheduler installation requires the installed plugin copy, outside every worktree",
    );
  // Removing an entry withdraws authority, so it never waits on plugin
  // discovery.
  if (!options.uninstall) await checkLauncherResolves();
  return exclusiveGcLock("install", async () => {
    const original = previousMachineText(machinePath);
    // Refuse a concurrent edit after the preview rather than overwrite it.
    const current = gcConfiguration(root, repositoryText).machine;
    if (JSON.stringify(current) !== JSON.stringify(machine))
      throw new GcError(
        "Machine configuration changed during preview; retry install",
      );
    const values: unknown = original ? load(original) : {};
    if (!isMapping(values))
      throw new GcError("Machine configuration must be a mapping");
    if (keepJob) {
      writeMachine(machinePath, dump({ ...values, gc: next }));
      console.log("Scheduler unchanged: the job still serves the others");
      return 0;
    }
    // Captured before anything changes, so a failure can put back the job
    // that was actually running rather than one rebuilt from this copy.
    const previousJob = await snapshotScheduler(detectScheduler(), gcJobSpec());
    mkdirSync(dirname(machinePath), { recursive: true, mode: 0o700 });
    writeMachine(machinePath, dump({ ...values, gc: next }));
    let job: string;
    try {
      job = await updateJob(gcJobSpec(next.hour), noEntries);
    } catch (error) {
      throw new GcError(
        `${message(error)}; ${await rollBack(machinePath, original, previousJob)}`,
      );
    }
    console.log(`Scheduler ${noEntries ? "removed" : "updated"}: ${job}`);
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
): Promise<{ root: string; clone: Set<string> }> {
  try {
    const checkouts = await cloneCheckouts(supplied);
    const root = primaryCheckout(supplied, checkouts);
    return {
      root,
      clone: new Set(
        [root, supplied, ...checkouts.worktrees].map(canonicalPath),
      ),
    };
  } catch (error) {
    const own = canonicalPath(supplied);
    if (
      machine?.repositories.some((entry) => canonicalPath(entry.path) === own)
    )
      return { root: supplied, clone: new Set([own]) };
    throw new GcError(
      `Cannot identify the clone at ${supplied}: ${message(error)}`,
    );
  }
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
async function proposedEntry(root: string, repository: unknown) {
  const remote = worktreeRemote(root);
  const base =
    isMapping(repository) && typeof repository.base_branch === "string"
      ? repository.base_branch
      : await remoteHeadBranch(root, remote);
  const entry = {
    path: root,
    remote,
    remote_url: (await git(root, ["remote", "get-url", remote])).trim(),
    base_branch: base,
    bounds: { kinds: [], worktree_roots: [], scratch_prefixes: [] },
  };
  const current = await baseDeclaration(entry);
  return { ...entry, bounds: current.declaration };
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
  try {
    await restoreScheduler(previousJob);
    return "machine configuration and previous scheduler job restored";
  } catch (error) {
    return `machine configuration restored; previous scheduler job not restored: ${message(error)}`;
  }
}
