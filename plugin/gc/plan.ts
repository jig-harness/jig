import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Failure, failed, ok, type Outcome } from "../shared/outcome.ts";
import {
  type ConfigurationCode,
  gcConfiguration,
  boundDeclaration,
  type Declaration,
  type MachineConfig,
  type RepositoryEntry,
} from "./config.ts";
import { canonicalPath, cloneCheckouts, primaryCheckout } from "./checkout.ts";
import { orcaCommand } from "../shared/orca.ts";
import { baseDeclaration } from "./git.ts";
import { receiptsKind } from "./kinds/receipts.ts";
import { scratchKind } from "./kinds/scratch.ts";
import { toolStateKind } from "./kinds/tool-state.ts";
import { worktreesKind } from "./kinds/worktrees.ts";
import type { CollectionKind, KindName } from "./types.ts";

function finding(
  repository: string,
  reason: string,
  name: KindName,
  declaration: string,
  unavailable = false,
): CollectionKind {
  return {
    name,
    repository,
    declaration,
    inventory: async () =>
      unavailable
        ? failed("unavailable", reason)
        : ok([{ id: "registration" }]),
    prove: async () => ({ state: "finding", reason }),
    collect: async () => ({ outcome: "refused", reason }),
    describe: (resource) => resource.id,
    exclusive: (body) => body(),
  };
}
function repositoryKinds(
  repository: string,
  declaration: Declaration,
  source: string,
  machine: MachineConfig,
  policy?: { remote: string; base: string },
): CollectionKind[] {
  return declaration.kinds
    .filter((name) => !machine.disabled.includes(name))
    .map((name) => {
      const days = machine.idle_days[name] ?? 7;
      if (name === "scratch")
        return scratchKind(
          repository,
          declaration.scratch_prefixes,
          source,
          days,
        );
      if (name === "tool-state") return toolStateKind(repository, source, days);
      return worktreesKind(
        repository,
        declaration.worktree_roots,
        source,
        days,
        policy,
        machineOrca(machine),
      );
    });
}
/**
 * Orca's command as the machine entry names it. The environment never names
 * it here, an Orca terminal's included: it cannot widen deletion authority.
 */
function machineOrca(machine: MachineConfig): string | undefined {
  return orcaCommand({}, process.platform, machine.orca?.command) ?? undefined;
}
type Entry = RepositoryEntry | { path: string };
interface PlanOptions {
  collect: boolean;
  repository?: string;
  kind?: KindName;
}
/** A refused configuration, which stops the whole run (exit 2). */
type Refused = { ok: false; failure: Failure<"configuration"> };
function refusedConfiguration(outcome: {
  ok: false;
  failure: Failure;
}): outcome is Refused {
  return outcome.failure.code === "configuration";
}
async function confirmedPlan(
  entry: RepositoryEntry,
  name: KindName,
  machine: MachineConfig,
): Promise<Outcome<CollectionKind[]>> {
  const kinds: CollectionKind[] = [];

  const current = await baseDeclaration(entry);
  if (!current.ok) return current;
  const { declaration, widened } = boundDeclaration(
    current.value.declaration,
    entry.bounds,
  );
  if (widened)
    kinds.push(
      finding(
        entry.path,
        "base declaration exceeds installed bounds; reinstall to confirm the widened authority",
        name,
        current.value.source,
      ),
    );
  kinds.push(
    ...repositoryKinds(entry.path, declaration, current.value.source, machine, {
      remote: entry.remote,
      base: entry.base_branch,
    }),
  );
  return ok(kinds);
}
function checkoutPlan(
  entry: Entry,
  machine: MachineConfig,
): Outcome<CollectionKind[]> {
  const current = gcConfiguration(entry.path);
  if (!current.ok) return current;
  return ok(
    repositoryKinds(
      entry.path,
      current.value.declaration,
      `${entry.path}/.config/jig.yaml (checkout; report only)`,
      machine,
    ),
  );
}
/**
 * The kinds one entry plans. A repository whose declaration cannot be read
 * plans one failed inventory naming why; a refused declaration fails the
 * whole plan.
 */
async function entryPlan(
  entry: Entry,
  options: PlanOptions,
  machine: MachineConfig,
): Promise<Outcome<CollectionKind[], "configuration">> {
  const name = options.kind ?? "worktrees";
  if (options.collect && !("bounds" in entry))
    return ok([
      finding(
        entry.path,
        "repository has no confirmed machine entry; run gc install",
        name,
        "none",
      ),
    ]);
  let planned: Outcome<CollectionKind[]>;
  try {
    planned =
      options.collect && "bounds" in entry
        ? await confirmedPlan(entry, name, machine)
        : checkoutPlan(entry, machine);
  } catch (error) {
    planned = failed(
      "thrown",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  if (planned.ok) return planned;
  if (refusedConfiguration(planned)) return planned;
  return ok([
    finding(entry.path, planned.failure.reason, name, "unavailable", true),
  ]);
}
/**
 * Whether `path` is confirmed to hold no `.git`: only a lookup that reports
 * the entry or a parent missing proves it. A `.git` that cannot be read (a
 * denied search permission, a dangling link) is a checkout whose identity is
 * unknown, not an absent one.
 */
function holdsNoGit(path: string): boolean {
  try {
    lstatSync(join(path, ".git"));
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}
/**
 * The entries `--repo` selects, or why its clone cannot be identified. The
 * entry names the clone's primary checkout; collecting from a linked worktree
 * of it selects that entry. A report reads the selected checkout's own
 * declaration instead. A path holding no `.git`, or a directory inside a
 * checkout, is no checkout and selects no entry; a checkout Git fails to
 * read leaves its clone unidentified, an unverified inventory rather than a
 * missing entry.
 */
async function selection(
  selected: string,
  collect: boolean,
  machine: MachineConfig,
): Promise<Entry[] | string> {
  const matching = (path: string) =>
    machine.repositories.filter(
      (entry) => canonicalPath(entry.path) === canonicalPath(path),
    );
  const own = matching(selected);
  if (own.length > 0) return own;
  if (!collect) return [{ path: selected }];
  let checkouts: Awaited<ReturnType<typeof cloneCheckouts>>;
  try {
    checkouts = await cloneCheckouts(selected);
  } catch (error) {
    checkouts = failed(
      "git-failed",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  if (checkouts.ok) {
    const primary = matching(primaryCheckout(selected, checkouts.value));
    return primary.length > 0 ? primary : [{ path: selected }];
  }
  if (checkouts.failure.code === "not-a-checkout" || holdsNoGit(selected))
    return [{ path: selected }];
  return `Cannot identify the clone at ${selected}: ${checkouts.failure.reason}`;
}
/**
 * The kinds a run evaluates, or why it plans none: the machine's
 * configuration cannot be read, or a repository's declaration is refused.
 */
export async function collectionPlan(options: {
  collect: boolean;
  repository?: string;
  kind?: KindName;
}): Promise<Outcome<CollectionKind[], ConfigurationCode>> {
  const configuration = gcConfiguration(process.cwd(), null);
  if (!configuration.ok) return configuration;
  const { machine } = configuration.value;
  const selected = options.repository ? resolve(options.repository) : undefined;
  // Receipts are machine-local: planning them must not fetch any base.
  const chosen =
    options.kind === "receipts"
      ? []
      : selected
        ? await selection(selected, options.collect, machine)
        : machine.repositories;
  const kinds: CollectionKind[] = [];
  if (typeof chosen === "string")
    kinds.push(
      finding(
        selected ?? "",
        chosen,
        options.kind ?? "worktrees",
        "unavailable",
        true,
      ),
    );
  else
    for (const entry of chosen) {
      const planned = await entryPlan(entry, options, machine);
      if (!planned.ok) return planned;
      kinds.push(...planned.value);
    }
  if (!selected && machine.receipts && !machine.disabled.includes("receipts"))
    kinds.push(receiptsKind(machine.receipts_days));
  return ok(
    kinds.filter((kind) => !options.kind || kind.name === options.kind),
  );
}
