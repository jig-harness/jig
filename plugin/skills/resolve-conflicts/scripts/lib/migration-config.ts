import { posix } from "node:path";
import { isRecord } from "../../../../shared/guards.ts";

export interface MigrationGroup {
  directory: string;
  journal: string;
  snapshots: string[];
  command: string | null;
}

export const RESOLVE_CONFLICTS_KEYS = [
  "generated",
  "hotspot_min_merges",
  "obligations",
  "sequenced_migrations",
];

const fields = ["directory", "journal", "snapshots", "command"];

function literalPath(value: unknown): value is string {
  if (typeof value !== "string" || /[\\*:?"<>|]/.test(value)) return false;
  if (
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return false;
  return value
    .split("/")
    .every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        part.toLowerCase() !== ".git",
    );
}

function snapshotTemplate(value: unknown): value is string {
  return (
    literalPath(value) &&
    /\{(?:sequence|tag)\}/.test(value) &&
    !/[{}]/.test(value.replaceAll(/\{(?:sequence|tag)\}/g, ""))
  );
}

function group(
  value: unknown,
  at: string,
  bad: (reason: string) => never,
): MigrationGroup {
  if (!isRecord(value)) return bad(`${at} must be a mapping`);
  for (const field of Object.keys(value))
    if (!fields.includes(field))
      bad(`${at}.${field} is not a known key (known: ${fields.join(", ")})`);
  const { directory, journal, snapshots = [], command } = value;
  if (directory !== "." && !literalPath(directory))
    return bad(
      `${at}.directory must be a literal repository-relative directory`,
    );
  if (!literalPath(journal))
    return bad(`${at}.journal must be a literal repository-relative file path`);
  if (!Array.isArray(snapshots) || !snapshots.every(snapshotTemplate))
    return bad(
      `${at}.snapshots must be a list of repository-relative paths containing {sequence} or {tag}`,
    );
  if (typeof command !== "string" || command.trim() === "")
    return bad(`${at}.command must be a nonempty string`);
  return { directory, journal, snapshots, command };
}

export function readMigrationGroups(
  value: unknown,
  at: string,
  bad: (reason: string) => never,
): MigrationGroup[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return bad(`${at} must be a list`);
  const groups = value.map((entry, index) =>
    group(entry, `${at}[${index}]`, bad),
  );
  for (const key of ["directory", "journal"] as const)
    if (new Set(groups.map((entry) => entry[key])).size !== groups.length)
      bad(`${at} must use each ${key} once`);
  return groups;
}

/** Legacy Drizzle identifies its migration directory by its tracked journal. */
export function detectMigrationGroups(
  configured: MigrationGroup[],
  paths: Iterable<string>,
): MigrationGroup[] {
  const byDirectory = new Map(
    configured.map((group) => [group.directory, group]),
  );
  for (const journal of paths) {
    if (!/(^|\/)meta\/_journal\.json$/.test(journal)) continue;
    const directory = posix.dirname(posix.dirname(journal));
    if (!byDirectory.has(directory))
      byDirectory.set(directory, {
        directory,
        journal,
        snapshots: [posix.join(directory, "meta/{sequence}_snapshot.json")],
        // The legacy generator cannot rebuild snapshots from existing SQL.
        command: null,
      });
  }
  return [...byDirectory.values()];
}

export interface MigrationName {
  ordinal: bigint;
  sequence: string;
  suffix: string;
  tag: string;
}

export function migrationName(
  group: MigrationGroup,
  path: string,
): MigrationName | null {
  if (posix.dirname(path) !== group.directory) return null;
  const tag = posix.basename(path, ".sql");
  const match = posix.basename(path).match(/^(\d+)((?:[_.-].*)?)\.sql$/);
  if (!match) return null;
  const [, sequence = "", suffix = ""] = match;
  return { ordinal: BigInt(sequence), sequence, suffix, tag };
}

export function snapshotPaths(
  group: MigrationGroup,
  name: MigrationName,
): string[] {
  return group.snapshots.map((path) =>
    path
      .replaceAll("{sequence}", () => name.sequence)
      .replaceAll("{tag}", () => name.tag),
  );
}

export function isMigrationMetadata(
  group: MigrationGroup,
  path: string,
): boolean {
  if (path === group.journal) return true;
  return group.snapshots.some((template) => {
    const pattern = template
      .split(/(\{sequence\}|\{tag\})/)
      .map((part) => {
        if (part === "{sequence}") return "\\d+";
        if (part === "{tag}") return "\\d+(?:[_.-][^/]*)?";
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    return new RegExp(`^${pattern}$`).test(path);
  });
}
