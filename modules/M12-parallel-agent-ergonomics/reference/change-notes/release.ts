// The release step: after a merge, write every change note into the
// changelog, move the version when a note asks for a release, and delete the
// notes. It runs on the integration branch, one run at a time, so no two
// pull requests ever pick the same version or edit the same lines. It writes
// files only; committing, tagging and pushing are the caller's.
//
// With --per-merge it writes the notes of one merge, the earliest still
// waiting, and reports how many notes remain, so a caller that runs it until
// none do releases each merge as its own version even when several merged
// before it ran. It needs the branch's whole history, so it refuses a
// shallow clone, history git cannot read, and a note not committed yet.
//
// A file that must name the version a change ships in (a "since" field, say)
// names a placeholder instead, which the step replaces with the version it
// releases: a branch cannot know that version before it merges. With
// --per-merge, only the placeholders on lines that landed by the merge it
// releases are replaced; a later merge's placeholders wait for its own release.
//
// Usage: bun release.ts --notes <dir> --changelog <file>
//          --version-file <json> [--version-file <json> …]
//          [--stamp <glob> --stamp-from <text> --stamp-to <text with {version}>]
//          [--root <dir>] [--tag-prefix v] [--date YYYY-MM-DD] [--per-merge]
//          [--dry-run] [--json]
// Prints what it released (with --json, `{ version, previous, notes, stamped,
// remaining }`, where `version` is null when no note asked for a release).
// Exit: 0 written, or nothing to write; 1 a note is malformed; 2 a usage
// error or an unreadable file.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cli } from "../../../../lib/cli.ts";
import {
  applyNotes,
  type ChangeNote,
  nextVersion,
  rebaseLinks,
} from "./change-notes.ts";
import {
  currentVersion,
  isShallow,
  lineLandings,
  mergeOrder,
  type NotesConfig,
  readNotes,
  versionOf,
} from "./notes-dir.ts";

/** A placeholder for the released version, replaced in every file a glob matches. */
export interface Stamp {
  /** Globs relative to the root. */
  files: string[];
  /** The placeholder as written, on one line, such as `since: next`. */
  from: string;
  /** What replaces it; `{version}` stands for the released version. */
  to: string;
}

export interface ReleaseOptions extends NotesConfig {
  tagPrefix: string;
  stamps?: Stamp[];
  /** The release date; today in UTC by default. */
  date?: string | undefined;
  /** Report what would be written without writing it. */
  dryRun?: boolean;
  /** Write only the notes of the earliest merge still waiting. */
  perMerge?: boolean;
}

export interface ReleaseResult {
  /** The version released; null when no note asked for one. */
  version: string | null;
  previous: string;
  /** The notes written in, in the order they merged. */
  notes: string[];
  /** The files whose placeholder now names the version. */
  stamped: string[];
  /** How many notes are left for a later run (only with `perMerge`). */
  remaining: number;
  /** The changelog as written (or as it would be, on a dry run). */
  changelog: string;
}

/**
 * Write the notes in and delete them; throws on a malformed note. Every file
 * is computed and checked before the first is written, so a refusal leaves
 * the repository as it was.
 */
export function release(options: ReleaseOptions): ReleaseResult {
  requireHistory(options);
  const read = readNotes(options);
  const { errors } = read;
  if (errors.length)
    throw new MalformedNotes(
      `change notes the release cannot read:\n  ${errors.join("\n  ")}`,
    );
  const notes = options.perMerge ? firstMerge(options.root, read) : read.notes;
  const remaining = read.notes.length - notes.length;
  const previous = currentVersion(options);
  const changelogPath = join(options.root, options.changelog);
  const before = readFileSync(changelogPath, "utf8");
  if (!notes.length)
    return {
      version: null,
      previous,
      notes: [],
      stamped: [],
      remaining,
      changelog: before,
    };
  const version = nextVersion(
    previous,
    notes.flatMap((n) => (n.release ? [n.release] : [])),
  );
  const toChangelog = notes.map((n) =>
    rebaseLinks(n, options.notes, dirname(options.changelog)),
  );
  const changelog = applyNotes(before, toChangelog, {
    version,
    previous,
    date: options.date ?? new Date().toISOString().slice(0, 10),
    tagPrefix: options.tagPrefix,
  });
  const stamped = version
    ? stamp(
        options.root,
        options.stamps ?? [],
        version,
        options.perMerge
          ? landedBy(
              options.root,
              read.landedIn.get(notes[0]?.file ?? "") ?? null,
            )
          : undefined,
      )
    : new Map<string, string>();
  const writes = new Map<string, string>([
    ...(version ? versionWrites(options, previous, version) : []),
    ...[...stamped].map(
      ([file, text]) => [join(options.root, file), text] as [string, string],
    ),
    [changelogPath, changelog],
  ]);
  if (!options.dryRun) {
    for (const [path, text] of writes) writeFileSync(path, text);
    for (const note of notes) rmSync(join(options.root, note.file));
  }
  return {
    version,
    previous,
    notes: notes.map((n) => n.file),
    stamped: [...stamped.keys()],
    remaining,
    changelog,
  };
}

/**
 * Refuses, for `perMerge`, a root whose whole history git cannot read: a
 * shallow clone, or no repository at all. The merge order needs it.
 */
function requireHistory(options: ReleaseOptions): void {
  if (!options.perMerge) return;
  const shallow = isShallow(options.root);
  if (shallow === null)
    throw new Error(
      `${options.root}: git cannot read its history, so the merge each note landed in cannot be told`,
    );
  if (shallow)
    throw new Error(
      `${options.root} is a shallow clone, so the merge each note landed in cannot be told: run \`git fetch --unshallow\` first`,
    );
}

/**
 * The notes of the earliest merge still waiting. Every note must have landed
 * on the branch's first-parent history: one that has not belongs to no merge,
 * so it cannot be released as one.
 */
function firstMerge(
  root: string,
  read: ReturnType<typeof readNotes>,
): ChangeNote[] {
  const order = mergeOrder(root);
  const unplaced = read.notes.filter(
    (n) => !order.has(read.landedIn.get(n.file) ?? ""),
  );
  if (unplaced.length)
    throw new Error(
      `per merge, every note must be committed on the branch first: ${unplaced.map((n) => n.file).join(", ")}`,
    );
  const first = read.notes[0];
  if (!first) return [];
  const merge = read.landedIn.get(first.file);
  return read.notes.filter((n) => read.landedIn.get(n.file) === merge);
}

/** Each version file's path with its text moved from `previous` to `version`. */
function versionWrites(
  options: ReleaseOptions,
  previous: string,
  version: string,
): [string, string][] {
  return options.versionFiles.map((file) => {
    const path = join(options.root, file);
    return [path, withVersion(path, previous, version)];
  });
}

/**
 * For each file, whether its line at an index had landed by `merge` (null for
 * changes not committed yet): blamed to a first-parent commit no later than
 * it. A line git cannot place counts as landing last.
 */
function landedBy(
  root: string,
  merge: string | null,
): (file: string) => (line: number) => boolean {
  const order = mergeOrder(root);
  const at = (commit: string | null | undefined) =>
    order.get(commit ?? "") ?? Number.POSITIVE_INFINITY;
  const limit = at(merge);
  return (file) => {
    const lines = lineLandings(root, file);
    if (!lines)
      throw new Error(
        `${file}: git cannot blame it, so its placeholders cannot be placed in a merge`,
      );
    return (line) => at(lines[line]) <= limit;
  };
}

/**
 * Each file holding a stamp's placeholder, with the placeholder replaced by
 * `version` on every line `ships` admits (every line without it).
 */
function stamp(
  root: string,
  stamps: Stamp[],
  version: string,
  ships?: (file: string) => (line: number) => boolean,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const { files, from, to } of stamps)
    for (const pattern of files)
      for (const file of new Bun.Glob(pattern).scanSync({ cwd: root })) {
        const text = out.get(file) ?? readFileSync(join(root, file), "utf8");
        if (!text.includes(from)) continue;
        const admits = ships?.(file);
        const replaced = text
          .split("\n")
          .map((line, i) =>
            line.includes(from) && (admits?.(i) ?? true)
              ? line.replaceAll(from, to.replaceAll("{version}", version))
              : line,
          )
          .join("\n");
        if (replaced !== text) out.set(file, replaced);
      }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

export class MalformedNotes extends Error {}

/**
 * A JSON file's text with its top-level `version` set, editing only that
 * value so the file's formatting and key order stay as they are; throws when
 * it cannot be set exactly.
 */
function withVersion(path: string, from: string, to: string): string {
  const text = readFileSync(path, "utf8");
  const pattern = new RegExp(
    `("version"\\s*:\\s*")${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(")`,
    "g",
  );
  const matches = text.match(pattern)?.length ?? 0;
  if (matches !== 1)
    throw new Error(
      `${path}: expected one "version": "${from}", found ${matches}`,
    );
  const updated = text.replace(pattern, `$1${to}$2`);
  if (versionOf(updated) !== to)
    throw new Error(`${path}: "${from}" is not its top-level version`);
  return updated;
}

if (import.meta.main)
  cli(() => {
    const { values } = parseArgs({
      options: {
        root: { type: "string", default: "." },
        notes: { type: "string" },
        changelog: { type: "string" },
        "version-file": { type: "string", multiple: true },
        "tag-prefix": { type: "string", default: "v" },
        stamp: { type: "string", multiple: true },
        "stamp-from": { type: "string" },
        "stamp-to": { type: "string" },
        date: { type: "string" },
        "per-merge": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
    });
    if (!values.notes || !values.changelog || !values["version-file"]?.length)
      throw new Error(
        "usage: release.ts --notes <dir> --changelog <file> --version-file <json> […]",
      );
    return runRelease(
      {
        root: resolve(values.root),
        notes: values.notes,
        changelog: values.changelog,
        versionFiles: values["version-file"],
        tagPrefix: values["tag-prefix"],
        stamps: stampsFrom(values),
        date: values.date,
        perMerge: values["per-merge"],
        dryRun: values["dry-run"],
      },
      values.json,
    );
  });

/** The one stamp the command line can give. */
function stampsFrom(values: {
  stamp?: string[] | undefined;
  "stamp-from"?: string | undefined;
  "stamp-to"?: string | undefined;
}): Stamp[] {
  const { stamp: files, "stamp-from": from, "stamp-to": to } = values;
  if (!files?.length) return [];
  if (!(from && to))
    throw new Error("--stamp needs --stamp-from and --stamp-to");
  return [{ files, from, to }];
}

/** Run the release step and report it; the exit status for the command line. */
export function runRelease(options: ReleaseOptions, json: boolean): number {
  let result: ReleaseResult;
  try {
    result = release(options);
  } catch (error) {
    if (!(error instanceof MalformedNotes)) throw error;
    console.error(error.message);
    return 1;
  }
  const { version, previous, notes, stamped, remaining } = result;
  if (json)
    console.log(
      JSON.stringify({ version, previous, notes, stamped, remaining }),
    );
  else if (!notes.length) console.log("release: no change notes to write");
  else
    console.log(
      `release: ${options.dryRun ? "would write" : "wrote"} ${notes.length} change note(s) into ${options.changelog}${version ? ` as ${version} (from ${previous})` : " under Unreleased"}`,
    );
  return 0;
}
