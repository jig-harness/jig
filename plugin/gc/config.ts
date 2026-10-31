import { GcConfigurationError } from "../shared/gc-error.ts";
/** GC keeps repository authority separate from machine policy and overrides. */
import { isAbsolute, resolve } from "node:path";
import { layeredConfig } from "../shared/consumer.ts";
import { isMapping, userConfigPath } from "../shared/config-layers.ts";
import type { KindName } from "./types.ts";

const REPOSITORY_KINDS = ["worktrees", "tool-state", "scratch"] as const;
export interface Declaration {
  kinds: Exclude<KindName, "receipts">[];
  worktree_roots: string[];
  scratch_prefixes: string[];
}
export interface RepositoryEntry {
  path: string;
  remote: string;
  remote_url: string;
  base_branch: string;
  bounds: Declaration;
}
export interface MachineConfig {
  repositories: RepositoryEntry[];
  disabled: KindName[];
  idle_days: Partial<Record<KindName, number>>;
  receipts_days: number;
  receipts: boolean;
  hour: number;
  collect_day: number;
  min_free_bytes: number;
  /** Orca's command, for a run no Orca terminal started (the scheduler's). */
  orca?: { command: string };
}
function mapping(value: unknown, field: string): Record<string, unknown> {
  if (!isMapping(value))
    throw new GcConfigurationError(`${field} must be a mapping`);
  return value;
}
function keys(
  value: Record<string, unknown>,
  allowed: string[],
  field: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new GcConfigurationError(`Unknown ${field}.${key}`);
}
function list(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((x) => typeof x !== "string" || !x.trim()) ||
    new Set(value).size !== value.length
  )
    throw new GcConfigurationError(
      `${field} must be a list of distinct nonempty strings`,
    );
  return value as string[];
}
function integer(
  value: unknown,
  field: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new GcConfigurationError(
      `${field} must be an integer from ${min} to ${max}`,
    );
  return value;
}
function kindList(value: unknown, machine: boolean): KindName[] {
  const result = list(value, "gc.kinds");
  const allowed: readonly string[] = machine
    ? [...REPOSITORY_KINDS, "receipts"]
    : REPOSITORY_KINDS;
  if (result.some((kind) => !allowed.includes(kind)))
    throw new GcConfigurationError(`gc.kinds supports ${allowed.join(", ")}`);
  return result as KindName[];
}
export function parseDeclaration(value: unknown, root: string): Declaration {
  const gc = value === undefined ? {} : mapping(value, "gc");
  keys(gc, ["kinds", "worktree_roots", "scratch_prefixes"], "gc");
  const paths = (field: "worktree_roots" | "scratch_prefixes"): string[] =>
    list(gc[field] ?? [], `gc.${field}`).map((path) => {
      const absolute = resolve(root, path);
      if (absolute === resolve(absolute, ".."))
        throw new GcConfigurationError(
          `gc.${field} cannot name the filesystem root`,
        );
      return absolute;
    });
  return {
    kinds: kindList(gc.kinds ?? [], false) as Declaration["kinds"],
    worktree_roots: paths("worktree_roots"),
    scratch_prefixes: paths("scratch_prefixes"),
  };
}
export function parseMachine(value: unknown): MachineConfig {
  const gc = value === undefined ? {} : mapping(value, "machine gc");
  keys(
    gc,
    [
      "repositories",
      "disabled",
      "idle_days",
      "receipts_days",
      "receipts",
      "hour",
      "collect_day",
      "min_free_bytes",
      "orca",
    ],
    "machine gc",
  );
  const repos = gc.repositories ?? [];
  if (!Array.isArray(repos))
    throw new GcConfigurationError("gc.repositories must be a list");
  const repositories = repos.map((item): RepositoryEntry => {
    const entry = mapping(item, "gc.repositories entry");
    keys(
      entry,
      ["path", "remote", "remote_url", "base_branch", "bounds"],
      "gc.repositories entry",
    );
    for (const field of ["path", "remote", "remote_url", "base_branch"])
      if (
        typeof entry[field] !== "string" ||
        !(entry[field] as string).trim() ||
        (entry[field] as string).startsWith("-")
      )
        throw new GcConfigurationError(
          `gc.repositories.${field} must be a nonempty value without a leading dash`,
        );
    const path = entry.path as string;
    if (!isAbsolute(path))
      throw new GcConfigurationError("gc.repositories.path must be absolute");
    return {
      path,
      remote: entry.remote as string,
      remote_url: entry.remote_url as string,
      base_branch: entry.base_branch as string,
      bounds: parseDeclaration(entry.bounds, path),
    };
  });
  if (
    new Set(repositories.map((entry) => entry.path)).size !==
    repositories.length
  )
    throw new GcConfigurationError("Duplicate gc.repositories.path");
  const idle = mapping(gc.idle_days ?? {}, "gc.idle_days");
  keys(idle, [...REPOSITORY_KINDS], "gc.idle_days");
  const idle_days: MachineConfig["idle_days"] = {};
  for (const [kind, days] of Object.entries(idle))
    idle_days[kind as KindName] = integer(days, `gc.idle_days.${kind}`, 7, 365);
  if (gc.receipts !== undefined && typeof gc.receipts !== "boolean")
    throw new GcConfigurationError("gc.receipts must be boolean");
  const orca = gc.orca === undefined ? undefined : orcaEntry(gc.orca);
  return {
    repositories,
    disabled: kindList(gc.disabled ?? [], true),
    idle_days,
    receipts_days: integer(gc.receipts_days ?? 30, "gc.receipts_days", 1),
    receipts: gc.receipts === true,
    hour: integer(gc.hour ?? 4, "gc.hour", 0, 23),
    collect_day: integer(gc.collect_day ?? 0, "gc.collect_day", 0, 6),
    min_free_bytes: integer(gc.min_free_bytes ?? 0, "gc.min_free_bytes", 0),
    ...(orca === undefined ? {} : { orca }),
  };
}
/**
 * Orca's command as an absolute path: the scheduler's `PATH` is not the
 * shell's, so a bare name could find another program or none.
 */
function orcaEntry(value: unknown): { command: string } {
  const orca = mapping(value, "gc.orca");
  keys(orca, ["command"], "gc.orca");
  const command = orca.command;
  if (typeof command !== "string" || !isAbsolute(command))
    throw new GcConfigurationError("gc.orca.command must be an absolute path");
  return { command };
}
export function gcConfiguration(
  root: string,
  repositoryText?: string | null,
): {
  machine: MachineConfig;
  declaration: Declaration;
  repositoryValues: Record<string, unknown>;
  machinePath: string;
} {
  const layers = layeredConfig(root, process.env, repositoryText).layers;
  const user = layers.find((layer) => layer.name === "user")?.values ?? {};
  const repositoryValues =
    layers.find((layer) => layer.name === "repository")?.values ?? {};
  // Environment and repository fields cannot widen deletion authority or alter
  // the machine's scheduler and retention policy. Report the two sources.
  return {
    machine: parseMachine(user.gc),
    declaration: parseDeclaration(repositoryValues.gc, root),
    repositoryValues,
    machinePath: userConfigPath(),
  };
}
export function boundDeclaration(
  current: Declaration,
  bounds: Declaration,
): { declaration: Declaration; widened: boolean } {
  const kinds = current.kinds.filter((kind) => bounds.kinds.includes(kind));
  const worktree_roots = current.worktree_roots.filter((path) =>
    bounds.worktree_roots.includes(path),
  );
  const scratch_prefixes = current.scratch_prefixes.filter((path) =>
    bounds.scratch_prefixes.includes(path),
  );
  return {
    declaration: { kinds, worktree_roots, scratch_prefixes },
    widened:
      kinds.length !== current.kinds.length ||
      worktree_roots.length !== current.worktree_roots.length ||
      scratch_prefixes.length !== current.scratch_prefixes.length,
  };
}
