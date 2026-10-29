import { GcError } from "../shared/gc-error.ts";
import { resolve } from "node:path";
import { GcConfigurationError } from "../shared/gc-error.ts";
import {
  gcConfiguration,
  boundDeclaration,
  type Declaration,
  type MachineConfig,
  type RepositoryEntry,
} from "./config.ts";
import { cloneCheckouts, primaryCheckout } from "./checkout.ts";
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
  failed = false,
): CollectionKind {
  return {
    name,
    repository,
    declaration,
    inventory: async () => {
      if (failed) throw new GcError(reason);
      return [{ id: "registration" }];
    },
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
      );
    });
}
type Entry = RepositoryEntry | { path: string };
interface PlanOptions {
  collect: boolean;
  repository?: string;
  kind?: KindName;
}
async function confirmedPlan(
  entry: RepositoryEntry,
  name: KindName,
  machine: MachineConfig,
): Promise<CollectionKind[]> {
  const kinds: CollectionKind[] = [];

  const current = await baseDeclaration(entry);
  const { declaration, widened } = boundDeclaration(
    current.declaration,
    entry.bounds,
  );
  if (widened)
    kinds.push(
      finding(
        entry.path,
        "base declaration exceeds installed bounds; reinstall to confirm the widened authority",
        name,
        current.source,
      ),
    );
  kinds.push(
    ...repositoryKinds(entry.path, declaration, current.source, machine, {
      remote: entry.remote,
      base: entry.base_branch,
    }),
  );
  return kinds;
}
async function entryPlan(
  entry: Entry,
  options: PlanOptions,
  machine: MachineConfig,
): Promise<CollectionKind[]> {
  const kinds: CollectionKind[] = [];
  const name = options.kind ?? "worktrees";
  if (options.collect && !("bounds" in entry)) {
    kinds.push(
      finding(
        entry.path,
        "repository has no confirmed machine entry; run gc install",
        name,
        "none",
      ),
    );
    return kinds;
  }
  try {
    if (options.collect && "bounds" in entry) {
      kinds.push(...(await confirmedPlan(entry, name, machine)));
    } else {
      const current = gcConfiguration(entry.path);
      kinds.push(
        ...repositoryKinds(
          entry.path,
          current.declaration,
          `${entry.path}/.config/jig.yaml (checkout; report only)`,
          machine,
        ),
      );
    }
  } catch (error) {
    if (error instanceof GcConfigurationError) throw error;
    kinds.push(
      finding(
        entry.path,
        error instanceof Error ? error.message : String(error),
        name,
        "unavailable",
        true,
      ),
    );
  }
  return kinds;
}
export async function collectionPlan(options: {
  collect: boolean;
  repository?: string;
  kind?: KindName;
}): Promise<CollectionKind[]> {
  const { machine } = gcConfiguration(process.cwd(), null);
  const selected = options.repository ? resolve(options.repository) : undefined;
  const matching = (path: string) =>
    machine.repositories.filter((entry) => resolve(entry.path) === path);
  let entries: (RepositoryEntry | { path: string })[] = selected
    ? matching(selected)
    : machine.repositories;
  // The entry names the clone's primary checkout; a linked worktree of it
  // selects that entry. A checkout Git cannot read selects none.
  if (selected && entries.length === 0) {
    const primary = await cloneCheckouts(selected)
      .then((checkouts) => primaryCheckout(selected, checkouts))
      .catch(() => null);
    if (primary !== null) entries = matching(primary);
  }
  if (selected && entries.length === 0) entries = [{ path: selected }];
  // Receipts are machine-local: planning them must not fetch any base.
  if (options.kind === "receipts") entries = [];
  const kinds: CollectionKind[] = [];
  for (const entry of entries)
    kinds.push(...(await entryPlan(entry, options, machine)));
  if (!selected && machine.receipts && !machine.disabled.includes("receipts"))
    kinds.push(receiptsKind(machine.receipts_days));
  return kinds.filter((kind) => !options.kind || kind.name === options.kind);
}
