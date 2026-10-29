import { GcError } from "../shared/gc-error.ts";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gcConfiguration } from "./config.ts";
import { baseDeclaration, gcGit as git } from "./git.ts";
import { dump, load } from "../shared/yaml.ts";
import { isMapping } from "../shared/config-layers.ts";
import { worktreePolicy } from "./kinds/worktree-proof.ts";
import { exclusiveGcLock } from "../shared/gc-lock.ts";
import {
  installedScript,
  previousMachineText,
  restoreScheduler,
  type SchedulerSnapshot,
  checkLauncherResolves,
  schedulerPreview,
  snapshotScheduler,
  updateScheduler,
} from "./scheduler.ts";

export async function install(options: {
  repository: string;
  script: string;
  confirm: boolean;
  uninstall: boolean;
  machine: boolean;
}): Promise<number> {
  const root = resolve(options.repository);
  // Removal needs only machine policy: a broken checkout cannot obstruct it.
  const repositoryText = options.uninstall ? null : undefined;
  const { machine, machinePath, repositoryValues } = gcConfiguration(
    root,
    repositoryText,
  );
  const repositories = options.uninstall
    ? options.machine
      ? []
      : machine.repositories.filter((entry) => entry.path !== root)
    : [
        ...machine.repositories.filter((old) => old.path !== root),
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
      : schedulerPreview(next, noEntries),
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
    const previousJob = await snapshotScheduler();
    mkdirSync(dirname(machinePath), { recursive: true, mode: 0o700 });
    writeMachine(machinePath, dump({ ...values, gc: next }));
    let job: string;
    try {
      job = await updateScheduler(next, noEntries);
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
 * The entry install proposes for the repository at `root`: the remote and
 * integration branch collection reads its worktrees against
 * (`worktreePolicy`), and that remote's URL, shown for confirmation.
 */
async function proposedEntry(root: string, repository: unknown) {
  const policy = await worktreePolicy(root);
  const base =
    isMapping(repository) && typeof repository.base_branch === "string"
      ? repository.base_branch
      : policy.base;
  const entry = {
    path: root,
    remote: policy.remote,
    remote_url: (await git(root, ["remote", "get-url", policy.remote])).trim(),
    base_branch: base,
    bounds: { kinds: [], worktree_roots: [], scratch_prefixes: [] },
  };
  const current = await baseDeclaration(entry);
  return { ...entry, bounds: current.declaration };
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
