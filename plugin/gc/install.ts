import { GcError } from "../shared/gc-error.ts";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gcConfiguration } from "./config.ts";
import { baseDeclaration, gcGit as git } from "./git.ts";
import { dump, load } from "../shared/yaml.ts";
import { isMapping } from "../shared/config-layers.ts";
import { exclusiveGcLock } from "../shared/gc-lock.ts";
import {
  installedScript,
  previousMachineText,
  restoreScheduler,
  type SchedulerSnapshot,
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
  let repositories = [...machine.repositories];
  if (options.uninstall)
    repositories = options.machine
      ? []
      : repositories.filter((entry) => entry.path !== root);
  else {
    const repository = repositoryValues.repository;
    let base: string;
    if (isMapping(repository) && typeof repository.base_branch === "string")
      base = repository.base_branch;
    else {
      const head = await git(root, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
      ]);
      base = head.replace(/^refs\/remotes\/origin\//, "");
    }
    const entry = {
      path: root,
      remote: "origin",
      remote_url: (await git(root, ["remote", "get-url", "origin"])).trim(),
      base_branch: base,
      bounds: { kinds: [], worktree_roots: [], scratch_prefixes: [] },
    };
    const current = await baseDeclaration(entry);
    const proposed = { ...entry, bounds: current.declaration };
    repositories = [
      ...repositories.filter((old) => old.path !== root),
      proposed,
    ];
  }
  const next = {
    ...machine,
    repositories,
    ...(options.machine ? { receipts: false } : {}),
  };
  const noEntries = next.repositories.length === 0 && !next.receipts;
  console.log(`Machine entry preview (${machinePath}):\n${dump({ gc: next })}`);
  console.log(schedulerPreview(next, options.script, noEntries));
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
    // Captured before anything changes, so a failure can put back the job
    // that was actually running rather than one rebuilt from this copy.
    const previousJob = await snapshotScheduler();
    mkdirSync(dirname(machinePath), { recursive: true, mode: 0o700 });
    writeMachine(machinePath, dump({ ...values, gc: next }));
    let job: string;
    try {
      job = await updateScheduler(next, options.script, noEntries);
    } catch (error) {
      throw new GcError(
        `${message(error)}; ${await rollBack(machinePath, original, previousJob)}`,
      );
    }
    console.log(`Scheduler ${noEntries ? "removed" : "updated"}: ${job}`);
    return 0;
  });
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
