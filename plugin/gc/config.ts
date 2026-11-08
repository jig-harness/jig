/** GC keeps repository authority separate from machine policy and overrides. */
import { isAbsolute, resolve } from "node:path";
import { layeredConfig } from "../shared/consumer.ts";
import {
  type ConfigLayer,
  isMapping,
  userConfigPath,
} from "../shared/config-layers.ts";
import { failed, type Failure, ok, type Outcome } from "../shared/outcome.ts";
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
/** A configuration gc refuses: the run collects nothing and exits 2. */
type Configured<T> = Outcome<T, "configuration">;
function refused(reason: string): {
  ok: false;
  failure: Failure<"configuration">;
} {
  return failed("configuration", reason);
}
/** An absent section: a mapping with no fields. */
function empty(): Record<string, unknown> {
  return {};
}
function mapping(
  value: unknown,
  field: string,
): Configured<Record<string, unknown>> {
  return isMapping(value) ? ok(value) : refused(`${field} must be a mapping`);
}
function keys(
  value: Record<string, unknown>,
  allowed: string[],
  field: string,
): Configured<undefined> {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  return unknown === undefined
    ? ok(undefined)
    : refused(`Unknown ${field}.${unknown}`);
}
function list(value: unknown, field: string): Configured<string[]> {
  if (
    !Array.isArray(value) ||
    value.some((x) => typeof x !== "string" || !x.trim()) ||
    new Set(value).size !== value.length
  )
    return refused(`${field} must be a list of distinct nonempty strings`);
  return ok(value as string[]);
}
function integer(
  value: unknown,
  field: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): Configured<number> {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    return refused(`${field} must be an integer from ${min} to ${max}`);
  return ok(value);
}
function kindList(value: unknown, machine: boolean): Configured<KindName[]> {
  const result = list(value, "gc.kinds");
  if (!result.ok) return result;
  const allowed: readonly string[] = machine
    ? [...REPOSITORY_KINDS, "receipts"]
    : REPOSITORY_KINDS;
  if (result.value.some((kind) => !allowed.includes(kind)))
    return refused(`gc.kinds supports ${allowed.join(", ")}`);
  return ok(result.value as KindName[]);
}
export function parseDeclaration(
  value: unknown,
  root: string,
): Configured<Declaration> {
  const gc = value === undefined ? ok(empty()) : mapping(value, "gc");
  if (!gc.ok) return gc;
  const known = keys(
    gc.value,
    ["kinds", "worktree_roots", "scratch_prefixes"],
    "gc",
  );
  if (!known.ok) return known;
  const paths = (
    field: "worktree_roots" | "scratch_prefixes",
  ): Configured<string[]> => {
    const listed = list(gc.value[field] ?? [], `gc.${field}`);
    if (!listed.ok) return listed;
    const absolute = listed.value.map((path) => resolve(root, path));
    if (absolute.some((path) => path === resolve(path, "..")))
      return refused(`gc.${field} cannot name the filesystem root`);
    return ok(absolute);
  };
  const kinds = kindList(gc.value.kinds ?? [], false);
  if (!kinds.ok) return kinds;
  const worktree_roots = paths("worktree_roots");
  if (!worktree_roots.ok) return worktree_roots;
  const scratch_prefixes = paths("scratch_prefixes");
  if (!scratch_prefixes.ok) return scratch_prefixes;
  return ok({
    kinds: kinds.value as Declaration["kinds"],
    worktree_roots: worktree_roots.value,
    scratch_prefixes: scratch_prefixes.value,
  });
}
function repositoryEntry(item: unknown): Configured<RepositoryEntry> {
  const entry = mapping(item, "gc.repositories entry");
  if (!entry.ok) return entry;
  const known = keys(
    entry.value,
    ["path", "remote", "remote_url", "base_branch", "bounds"],
    "gc.repositories entry",
  );
  if (!known.ok) return known;
  const values = entry.value;
  for (const field of ["path", "remote", "remote_url", "base_branch"])
    if (
      typeof values[field] !== "string" ||
      !(values[field] as string).trim() ||
      (values[field] as string).startsWith("-")
    )
      return refused(
        `gc.repositories.${field} must be a nonempty value without a leading dash`,
      );
  const path = values.path as string;
  if (!isAbsolute(path))
    return refused("gc.repositories.path must be absolute");
  const bounds = parseDeclaration(values.bounds, path);
  if (!bounds.ok) return bounds;
  return ok({
    path,
    remote: values.remote as string,
    remote_url: values.remote_url as string,
    base_branch: values.base_branch as string,
    bounds: bounds.value,
  });
}
function idleDays(value: unknown): Configured<MachineConfig["idle_days"]> {
  const idle = mapping(value, "gc.idle_days");
  if (!idle.ok) return idle;
  const known = keys(idle.value, [...REPOSITORY_KINDS], "gc.idle_days");
  if (!known.ok) return known;
  const idle_days: MachineConfig["idle_days"] = {};
  for (const [kind, days] of Object.entries(idle.value)) {
    const parsed = integer(days, `gc.idle_days.${kind}`, 7, 365);
    if (!parsed.ok) return parsed;
    idle_days[kind as KindName] = parsed.value;
  }
  return ok(idle_days);
}
/** `gc.repositories`: each entry valid, each path listed once. */
function repositoryEntries(value: unknown): Configured<RepositoryEntry[]> {
  if (!Array.isArray(value)) return refused("gc.repositories must be a list");
  const repositories: RepositoryEntry[] = [];
  for (const item of value) {
    const entry = repositoryEntry(item);
    if (!entry.ok) return entry;
    repositories.push(entry.value);
  }
  if (
    new Set(repositories.map((entry) => entry.path)).size !==
    repositories.length
  )
    return refused("Duplicate gc.repositories.path");
  return ok(repositories);
}
/** The machine's schedule and limits, with their defaults. */
function schedule(
  gc: Record<string, unknown>,
): Configured<
  Pick<
    MachineConfig,
    "receipts_days" | "hour" | "collect_day" | "min_free_bytes"
  >
> {
  const receipts_days = integer(gc.receipts_days ?? 30, "gc.receipts_days", 1);
  if (!receipts_days.ok) return receipts_days;
  const hour = integer(gc.hour ?? 4, "gc.hour", 0, 23);
  if (!hour.ok) return hour;
  const collect_day = integer(gc.collect_day ?? 0, "gc.collect_day", 0, 6);
  if (!collect_day.ok) return collect_day;
  const min_free_bytes = integer(
    gc.min_free_bytes ?? 0,
    "gc.min_free_bytes",
    0,
  );
  if (!min_free_bytes.ok) return min_free_bytes;
  return ok({
    receipts_days: receipts_days.value,
    hour: hour.value,
    collect_day: collect_day.value,
    min_free_bytes: min_free_bytes.value,
  });
}
export function parseMachine(value: unknown): Configured<MachineConfig> {
  const read = value === undefined ? ok(empty()) : mapping(value, "machine gc");
  if (!read.ok) return read;
  const gc = read.value;
  const known = keys(
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
  if (!known.ok) return known;
  const repositories = repositoryEntries(gc.repositories ?? []);
  if (!repositories.ok) return repositories;
  const idle_days = idleDays(gc.idle_days ?? {});
  if (!idle_days.ok) return idle_days;
  if (gc.receipts !== undefined && typeof gc.receipts !== "boolean")
    return refused("gc.receipts must be boolean");
  const orca = gc.orca === undefined ? ok(undefined) : orcaEntry(gc.orca);
  if (!orca.ok) return orca;
  const disabled = kindList(gc.disabled ?? [], true);
  if (!disabled.ok) return disabled;
  const times = schedule(gc);
  if (!times.ok) return times;
  return ok({
    repositories: repositories.value,
    disabled: disabled.value,
    idle_days: idle_days.value,
    receipts_days: times.value.receipts_days,
    receipts: gc.receipts === true,
    hour: times.value.hour,
    collect_day: times.value.collect_day,
    min_free_bytes: times.value.min_free_bytes,
    ...(orca.value === undefined ? {} : { orca: orca.value }),
  });
}
/**
 * Orca's command as an absolute path: the scheduler's `PATH` is not the
 * shell's, so a bare name could find another program or none.
 */
function orcaEntry(value: unknown): Configured<{ command: string }> {
  const orca = mapping(value, "gc.orca");
  if (!orca.ok) return orca;
  const known = keys(orca.value, ["command"], "gc.orca");
  if (!known.ok) return known;
  const command = orca.value.command;
  if (typeof command !== "string" || !isAbsolute(command))
    return refused("gc.orca.command must be an absolute path");
  return ok({ command });
}
/** The configuration gc runs with: the machine's policy and the repository's declaration. */
export interface GcConfiguration {
  machine: MachineConfig;
  declaration: Declaration;
  repositoryValues: Record<string, unknown>;
  machinePath: string;
}
/**
 * Why gc's configuration cannot be used: `configuration` when a gc field is
 * refused (a run exits 2), `unreadable` when a configuration file cannot be
 * read or parsed at all (a run exits 1).
 */
export type ConfigurationCode = "configuration" | "unreadable";
export function gcConfiguration(
  root: string,
  repositoryText?: string | null,
): Outcome<GcConfiguration, ConfigurationCode> {
  let layers: ConfigLayer[];
  try {
    layers = layeredConfig(root, process.env, repositoryText).layers;
  } catch (error) {
    return failed(
      "unreadable",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  const user = layers.find((layer) => layer.name === "user")?.values ?? {};
  const repositoryValues =
    layers.find((layer) => layer.name === "repository")?.values ?? {};
  // Environment and repository fields cannot widen deletion authority or alter
  // the machine's scheduler and retention policy. Report the two sources.
  const machine = parseMachine(user.gc);
  if (!machine.ok) return machine;
  const declaration = parseDeclaration(repositoryValues.gc, root);
  if (!declaration.ok) return declaration;
  return ok({
    machine: machine.value,
    declaration: declaration.value,
    repositoryValues,
    machinePath: userConfigPath(),
  });
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
