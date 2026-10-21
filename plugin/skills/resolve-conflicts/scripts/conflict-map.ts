#!/usr/bin/env bun
/**
 * Map a merge, rebase, cherry-pick or revert that stopped on conflicts,
 * before anything is resolved.
 *
 * Usage: bun conflict-map.ts [--json] [--integration ours|theirs]
 *   Run from inside the repository. Prints which operation stopped, the role
 *   of each side ("ours" and "theirs" swap meaning in a rebase), and for every
 *   conflicted path: how it conflicts, its class (lockfile, generated, binary,
 *   text), its conflict regions, and the commits on each side that changed
 *   it. --json prints the map as JSON. --integration names the side that
 *   carries the base branch when the merge heuristic would guess wrong.
 *
 * Writes the map to `<git-dir>/jig/conflicts.json`, the snapshot that
 * record.ts fills in and check-resolution.ts verifies. Running it again for
 * the same operation classifies every mapped path afresh, keeps each path's
 * marker size (git wrote its markers when the operation stopped), and keeps
 * each decision recorded under the class and command the path still has; a
 * snapshot for a different operation is replaced. Reads nothing else into the
 * repository and changes nothing else.
 *
 * Reads `resolve_conflicts.generated` from `.config/jig.yaml`
 * (path globs and the command that regenerates them) and, when
 * `drive.change_areas_catalog` is set, the `generated[].outputs` and `command`
 * of the change-area catalog; the configuration wins over the catalog, the
 * catalog over the built-in lockfile table. JIG_OVERLAY points at another
 * configuration file.
 *
 * Exit codes: 0 mapped; 2 usage error, not in a git work tree, or invalid
 * configuration; 3 no merge, rebase, cherry-pick or revert is in progress, or
 * the stored snapshot is unreadable (it is never replaced: it holds what git
 * forgot about the paths already staged).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, runMain } from "../../../shared/cli.ts";
import {
  type CatalogGenerated,
  catalogGeneratedEntries,
  type GeneratedEntry,
  generatedEntries,
  type PathClass,
  type Regenerate,
  regenerateFor,
} from "./lib/classify.ts";
import { indexAttributesGit } from "./lib/attributes.ts";
import { git, isBinaryBlob, splitNul, topLevel } from "./lib/git.ts";
import {
  attributionOf,
  concludedCommit,
  keepPending,
  recordConcluded,
} from "./lib/events.ts";
import { parseHunks, writtenMarkerSize } from "./lib/markers.ts";
import {
  detectOperation,
  NoOperation,
  type Operation,
  type SideName,
} from "./lib/operation.ts";
import {
  describeOperation,
  emptyResolution,
  type Intent,
  type IntentCommit,
  isPullRequestNumber,
  type Kind,
  kindOf,
  loadSnapshot,
  type PathEntry,
  type Snapshot,
  type Stage,
  sameOperation,
  saveSnapshot,
} from "./lib/snapshot.ts";

/** At most this many commits per side and path; the rest is `truncated`. */
export const INTENT_CAP = 20;
const DEFAULT_MARKER_SIZE = 7;

export interface Unmerged {
  base: Stage | null;
  ours: Stage | null;
  theirs: Stage | null;
}

/** The index's unmerged entries, by path. */
export function unmergedPaths(root: string): Map<string, Unmerged> {
  const byPath = new Map<string, Unmerged>();
  for (const record of splitNul(git(root, ["ls-files", "-u", "-z"]))) {
    const match = record.match(/^(\d+) ([0-9a-f]+) ([123])\t(.*)$/s);
    if (!match) continue;
    const [, mode, blob, stage, path] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    const entry = byPath.get(path) ?? { base: null, ours: null, theirs: null };
    const slot = stage === "1" ? "base" : stage === "2" ? "ours" : "theirs";
    entry[slot] = { mode, blob };
    byPath.set(path, entry);
  }
  return byPath;
}

/** Where `attributes` reads `.gitattributes` from. */
type AttributeSource = "index" | "merge";

/**
 * `git check-attr` values for `names`, per path. From the `index`: the
 * attributes the commit carries and nothing else (lib/attributes.ts), which
 * classify a path.
 * As the `merge` read them: the working tree's files first, then the
 * index's, which is how git found the marker size it wrote.
 */
function attributes(
  root: string,
  paths: string[],
  source: AttributeSource,
  names: readonly string[],
): Map<string, Record<string, string>> {
  const result = new Map<string, Record<string, string>>();
  if (paths.length === 0) return result;
  const args = ["check-attr", "-z", "--stdin", ...names];
  const input = `${paths.join("\0")}\0`;
  const out = splitNul(
    source === "index"
      ? indexAttributesGit(root, (run) => {
          const r = run(args, input);
          if (r.code !== 0)
            throw new Error(
              `git --attr-source check-attr exited ${r.code} (Git 2.41 or newer is required): ${r.stderr.trim()}`,
            );
          return r.stdout;
        })
      : git(root, args, input),
  );
  for (let i = 0; i + 2 < out.length; i += 3) {
    const path = out[i] as string;
    const values = result.get(path) ?? {};
    values[out[i + 1] as string] = out[i + 2] as string;
    result.set(path, values);
  }
  return result;
}

/** A `conflict-marker-size` value as a size, the default when unset or invalid. */
function markerSizeOf(attrs: Record<string, string> | undefined): number {
  const size = Number(attrs?.["conflict-marker-size"]);
  return Number.isInteger(size) && size > 0 ? size : DEFAULT_MARKER_SIZE;
}

function isBinary(
  root: string,
  stages: Unmerged,
  attrs: Record<string, string>,
): boolean {
  if (attrs.diff === "unset" || ["unset", "binary"].includes(attrs.merge ?? ""))
    return true;
  for (const stage of [stages.base, stages.ours, stages.theirs]) {
    if (stage === null) continue;
    // A submodule entry is a commit, not file content.
    if (stage.mode === "160000") return true;
    if (isBinaryBlob(root, stage.blob)) return true;
  }
  return false;
}

export function prNumber(subject: string): number | null {
  const match =
    subject.match(/\(#(\d+)\)\s*$/) ??
    subject.match(/^Merge pull request #(\d+)/);
  const number = match ? Number(match[1]) : null;
  return isPullRequestNumber(number) ? number : null;
}

function commitsTouching(
  root: string,
  revisions: string[],
  path: string,
): { commits: IntentCommit[]; truncated: boolean } {
  const out = git(root, [
    "log",
    `--max-count=${INTENT_CAP + 1}`,
    "--format=%H%x1f%s",
    ...revisions,
    "--",
    path,
  ]);
  const commits = out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\x1f");
      return { sha, subject, pr: prNumber(subject) };
    });
  return {
    commits: commits.slice(0, INTENT_CAP),
    truncated: commits.length > INTENT_CAP,
  };
}

/** Old path → new path for every rename between two commits. */
function renames(root: string, from: string, to: string): Map<string, string> {
  const out = splitNul(
    git(root, ["diff", "--find-renames", "--name-status", "-z", from, to]),
  );
  const map = new Map<string, string>();
  for (let i = 0; i < out.length; ) {
    const status = out[i] as string;
    if (status.startsWith("R") || status.startsWith("C")) {
      if (status.startsWith("R"))
        map.set(out[i + 1] as string, out[i + 2] as string);
      i += 3;
    } else i += 2;
  }
  return map;
}

/** The intent of each side for every path: who changed it and why. */
function intentReader(root: string, op: Operation) {
  const renameCache = new Map<SideName, Map<string, string>>();
  const renamesOf = (side: SideName) => {
    let cached = renameCache.get(side);
    if (cached === undefined) {
      cached =
        op.base === null ? new Map() : renames(root, op.base, op[side].commit);
      renameCache.set(side, cached);
    }
    return cached;
  };
  return (path: string, kind: Kind): { ours: Intent; theirs: Intent } => {
    const range = (tip: string) =>
      op.base === null ? [tip] : [`${op.base}..${tip}`];
    const ours = commitsTouching(root, range(op.ours.commit), path);
    const theirs =
      op.kind === "merge"
        ? commitsTouching(root, range(op.theirs.commit), path)
        : {
            // The incoming side of a replayed, picked or reverted commit is
            // that one commit.
            commits: [
              {
                sha: op.incoming,
                subject: op.theirs.subject,
                pr: prNumber(op.theirs.subject),
              },
            ],
            truncated: false,
          };
    const renamedTo = (side: SideName) =>
      kind === `deleted-by-${side}`
        ? (renamesOf(side).get(path) ?? null)
        : null;
    return {
      ours: { ...ours, renamedTo: renamedTo("ours") },
      theirs: { ...theirs, renamedTo: renamedTo("theirs") },
    };
  };
}

/** The derived-file entries in precedence order: configuration, then the catalog. */
export function derivedEntries(catalog: CatalogGenerated): GeneratedEntry[] {
  return [...generatedEntries(), ...catalog.entries];
}

/** How a path is resolved, as the map derives it: its class, marker size and generator. */
export interface Classification {
  class: PathClass;
  markerSize: number;
  regenerate: Regenerate | null;
}

/**
 * Classify each path from its conflict stages, its attributes and the
 * derived-file entries. The stages are the index's for an unmerged path and
 * the snapshot's for one staged since, so a staged path is classified exactly
 * as it would be while still unmerged.
 */
export function classifyPaths(
  root: string,
  stagesByPath: ReadonlyMap<string, Unmerged>,
  entries: readonly GeneratedEntry[],
): Map<string, Classification> {
  const attrs = attributes(root, [...stagesByPath.keys()], "index", [
    "diff",
    "merge",
    "conflict-marker-size",
  ]);
  const result = new Map<string, Classification>();
  for (const [path, stages] of stagesByPath) {
    const pathAttrs = attrs.get(path) ?? {};
    const markerSize = markerSizeOf(pathAttrs);
    const derived = regenerateFor(path, entries);
    result.set(path, {
      class: derived
        ? derived.class
        : isBinary(root, stages, pathAttrs)
          ? "binary"
          : "text",
      markerSize,
      regenerate: derived?.regenerate ?? null,
    });
  }
  return result;
}

/**
 * The marker size git writes each path's markers with: the
 * `conflict-marker-size` a merge reads, the working tree's files before the
 * index's. It can differ from the size the index declares (an untracked
 * `.gitattributes`), and only finding the markers depends on it.
 */
export function writtenSizes(
  root: string,
  paths: string[],
): Map<string, number> {
  const attrs = attributes(root, paths, "merge", ["conflict-marker-size"]);
  return new Map(paths.map((path) => [path, markerSizeOf(attrs.get(path))]));
}

/** The `conflict-marker-size` the attributes the commit carries give each path. */
export function indexSizes(root: string, paths: string[]): Map<string, number> {
  const attrs = attributes(root, paths, "index", ["conflict-marker-size"]);
  return new Map(paths.map((path) => [path, markerSizeOf(attrs.get(path))]));
}

/**
 * Map every unmerged path of the operation in progress, or the paths given in
 * `unmerged` with their stages. A path's marker size is the one git wrote its
 * markers with: the size of the markers in the file, else the size an earlier
 * map of the same operation recorded (`recordedSizes`), else the size the
 * merge reads; a `conflict-marker-size` changed or removed since the
 * operation stopped does not describe them, and neither does a size recorded
 * before the operation was started again.
 */
export function mapConflicts(
  root: string,
  op: Operation,
  catalog: CatalogGenerated = catalogGeneratedEntries(),
  recordedSizes: ReadonlyMap<string, number> = new Map(),
  unmerged = unmergedPaths(root),
): Record<string, PathEntry> {
  const paths = [...unmerged.keys()].sort();
  const classes = classifyPaths(root, unmerged, derivedEntries(catalog));
  const written = writtenSizes(
    root,
    paths.filter((path) => !recordedSizes.has(path)),
  );
  const intent = intentReader(root, op);
  // Keyed by git paths, so `__proto__` is an ordinary path: no prototype.
  const mapped: Record<string, PathEntry> = Object.create(null);
  for (const path of paths) {
    const stages = unmerged.get(path) as Unmerged;
    const kind = kindOf(stages);
    const classified = classes.get(path) as Classification;
    const { class: cls, regenerate } = classified;
    const file = join(root, path);
    const content =
      cls !== "binary" && existsSync(file) ? readFileSync(file, "utf8") : null;
    const expected =
      recordedSizes.get(path) ?? written.get(path) ?? classified.markerSize;
    const markerSize =
      (content === null ? null : writtenMarkerSize(content, expected)) ??
      expected;
    const hunks =
      cls === "text" && content !== null ? parseHunks(content, markerSize) : [];
    mapped[path] = {
      kind,
      class: cls,
      markerSize,
      regenerate,
      stages,
      hunks,
      intent: intent(path, kind),
      resolution: emptyResolution(),
    };
  }
  return mapped;
}

/**
 * A staged path's entry under its new classification. Its marker size stays
 * the one its markers were written with; its conflict regions are a text
 * file's only.
 */
function restaged(
  before: PathEntry,
  now: Classification | undefined,
): PathEntry {
  if (now === undefined) return before;
  return {
    ...before,
    ...now,
    markerSize: before.markerSize,
    hunks: now.class === "text" ? before.hunks : [],
  };
}

/** Whether a decision recorded under `before` still answers what `after` requires. */
export function sameRequirement(
  before: Classification,
  after: Classification,
): boolean {
  return (
    before.class === after.class &&
    before.regenerate?.command === after.regenerate?.command &&
    before.regenerate?.cwd === after.regenerate?.cwd
  );
}

/**
 * Fold a fresh map into the stored snapshot. The same operation keeps every
 * path mapped earlier (a staged path is no longer unmerged, but its entry is
 * still what the check needs); a different operation's snapshot is replaced.
 * A staged path takes its class from `reclassified` (`classifyPaths` over its
 * stored stages), an unmerged one from the fresh map, so a declaration added,
 * changed or removed after the path was staged applies to it. A recorded
 * decision is kept only while the path's class and generator command are the
 * ones it was recorded under: a decision for another requirement, such as a
 * regeneration with a generator the catalog has since replaced, is cleared
 * and must be recorded again.
 */
export function mergeSnapshot(
  previous: Snapshot | null,
  fresh: Snapshot,
  reclassified: ReadonlyMap<string, Classification> = new Map(),
): { snapshot: Snapshot; note: string } {
  if (previous === null) return { snapshot: fresh, note: "new" };
  if (!sameOperation(previous, fresh.operation))
    return {
      snapshot: fresh,
      note: `replaced the snapshot of a different operation (${previous.operation.kind} of ${previous.operation.incoming.slice(0, 12)} onto ${previous.operation.head.slice(0, 12)})`,
    };
  const paths: Record<string, PathEntry> = Object.create(null);
  const cleared: string[] = [];
  for (const [path, before] of Object.entries(previous.paths)) {
    const after: PathEntry = Object.hasOwn(fresh.paths, path)
      ? (fresh.paths[path] as PathEntry)
      : restaged(before, reclassified.get(path));
    const keep = sameRequirement(before, after);
    if (!keep && before.resolution.decision) cleared.push(path);
    paths[path] = {
      ...after,
      resolution: keep ? before.resolution : emptyResolution(),
    };
  }
  for (const [path, entry] of Object.entries(fresh.paths))
    if (!Object.hasOwn(paths, path)) paths[path] = entry;
  const attribution = previous.attribution ?? fresh.attribution;
  return {
    snapshot: {
      ...fresh,
      ...(attribution === undefined ? {} : { attribution }),
      paths,
    },
    note: updateNote(paths, cleared),
  };
}

/** How many recorded decisions an update kept, and which it cleared. */
function updateNote(
  paths: Record<string, PathEntry>,
  cleared: string[],
): string {
  const kept = Object.values(paths).filter(
    (entry) => entry.resolution.decision,
  ).length;
  const keptPart = `updated: kept ${kept} recorded decision${kept === 1 ? "" : "s"}`;
  if (cleared.length === 0) return keptPart;
  return `${keptPart}; cleared the decision for ${cleared.sort().join(", ")}, whose class or regeneration command changed: record it again`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function summary(
  snapshot: Snapshot,
  unmerged: string[],
  file: string,
  note: string,
): string {
  const { operation, sides } = snapshot;
  const out: string[] = [];
  if (snapshot.warning) out.push(`WARNING: ${snapshot.warning}`, "");
  out.push(
    `Operation: ${operation.kind}, stopped with ${unmerged.length} unmerged path${unmerged.length === 1 ? "" : "s"}`,
  );
  for (const name of ["ours", "theirs"] as const) {
    const side = sides[name];
    out.push(
      `  ${name.padEnd(6)} = ${side.ref === null ? "" : `${side.ref} `}${shortSha(side.commit)} "${side.subject}": ${side.role}`,
    );
  }
  out.push(
    `  integration side: ${sides.integration} (${sides.integrationWhy}); derived files start from this side, then are regenerated`,
    `  base: ${operation.base === null ? "(none: unrelated histories or a root commit)" : shortSha(operation.base)}`,
    "",
  );
  for (const path of Object.keys(snapshot.paths).sort()) {
    const entry = snapshot.paths[path] as PathEntry;
    const state = unmerged.includes(path) ? "" : " [no longer unmerged]";
    const decision = entry.resolution.decision
      ? ` [recorded: ${entry.resolution.decision}]`
      : "";
    out.push(`${path}  ${entry.kind}  ${entry.class}${state}${decision}`);
    if (entry.regenerate)
      out.push(
        `  regenerate: ${entry.regenerate.command} (in ${entry.regenerate.cwd}; ${entry.regenerate.source})`,
      );
    if (entry.hunks.length > 0)
      out.push(
        `  ${entry.hunks.length} conflict region${entry.hunks.length === 1 ? "" : "s"}: lines ${entry.hunks.map((h) => `${h.start}-${h.end}`).join(", ")}${entry.hunks.some((h) => h.base === null) ? " (no base section: git checkout --conflict=zdiff3 -- <path> adds it)" : ""}`,
      );
    for (const name of ["ours", "theirs"] as const) {
      const intent = entry.intent[name];
      if (intent.renamedTo)
        out.push(`  ${name} renamed it to ${intent.renamedTo}`);
      for (const commit of intent.commits)
        out.push(`  ${name}: ${shortSha(commit.sha)} ${commit.subject}`);
      if (intent.truncated)
        out.push(`  ${name}: … (more than ${INTENT_CAP} commits)`);
    }
  }
  out.push(
    "",
    `Snapshot: ${file} (${note})`,
    "Next: resolve each path, record each decision with record.ts, then run check-resolution.ts.",
  );
  return out.join("\n");
}

/** The operation's warning and the catalog's problems, each under its own `WARNING:` prefix. */
function warningOf(
  operation: string | null,
  catalog: CatalogGenerated,
): string | null {
  const lines = [operation, ...catalog.problems].filter(Boolean);
  return lines.length === 0 ? null : lines.join("\nWARNING: ");
}

/** The stored stages of each path the same operation mapped earlier and has staged since. */
function stagedSince(
  previous: Snapshot | null,
  fresh: Snapshot,
): Map<string, Unmerged> {
  const staged = new Map<string, Unmerged>();
  if (previous === null || !sameOperation(previous, fresh.operation))
    return staged;
  for (const [path, entry] of Object.entries(previous.paths))
    if (!Object.hasOwn(fresh.paths, path)) staged.set(path, entry.stages);
  return staged;
}

/** The stored snapshot, or `null` when there is none; an unreadable one stops the map. */
function storedSnapshot(root: string): Snapshot | null {
  try {
    return loadSnapshot(root);
  } catch (err) {
    // A path staged since the map was written is no longer unmerged, so its
    // conflict stages and decision exist only in that snapshot: never replace it.
    return fail(
      3,
      `conflict-map: the stored snapshot is unreadable: ${err instanceof Error ? err.message : err}`,
      "Restore it if any conflicted path has been staged since it was written. If none has, move it aside and run conflict-map.ts again.",
    );
  }
}

/** The marker size an earlier map of the same operation recorded for each path. */
function recordedSizes(
  previous: Snapshot | null,
  op: Operation,
): Map<string, number> {
  const sizes = new Map<string, number>();
  if (previous !== null && sameOperation(previous, op))
    for (const [path, entry] of Object.entries(previous.paths))
      sizes.set(path, entry.markerSize);
  return sizes;
}

/**
 * An earlier operation's snapshot is about to be overwritten: keep its events
 * if it concluded and nobody recorded them (each stop of a rebase is a new
 * operation, and `events.ts` runs once, after the last). When the record
 * cannot be written, the snapshot is kept as pending, with the commit it
 * concluded with, for `events.ts` to record later. Never stops the map.
 */
function recordBeforeReplacing(root: string, previous: Snapshot): void {
  let commit: string | null = null;
  try {
    commit = concludedCommit(root, previous);
    if (commit === null) return;
    const done = recordConcluded(root, previous, process.env, commit);
    if (done.written > 0)
      console.error(
        `conflict-map: recorded ${done.written} merge_conflict event${done.written === 1 ? "" : "s"} of the ${describeOperation(previous.operation)} before replacing its snapshot`,
      );
  } catch (err) {
    const kept = keepPending(root, previous, commit);
    console.error(
      `conflict-map: could not record the events of the ${describeOperation(previous.operation)}: ${err instanceof Error ? err.message : err}. ${kept === null ? "Its snapshot could not be kept either; its events are lost." : `Its snapshot is kept in ${kept}; events.ts records it once the record can be written.`}`,
    );
  }
}

function usage(): never {
  fail(2, "usage: conflict-map.ts [--json] [--integration ours|theirs]");
}

function parseArgs(args: readonly string[]): {
  json: boolean;
  integration: SideName | undefined;
} {
  let json = false;
  let integration: SideName | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") json = true;
    else if (arg === "--integration") {
      const value = args[++i];
      if (value !== "ours" && value !== "theirs") usage();
      integration = value;
    } else usage();
  }
  return { json, integration };
}

/** The operation in progress at `root`; exit 3 when there is none. */
function operationOrExit(
  root: string,
  integration: SideName | undefined,
): Operation {
  try {
    return detectOperation(root, integration);
  } catch (err) {
    if (err instanceof NoOperation)
      fail(3, `conflict-map: ${err.message} Nothing to map.`);
    throw err;
  }
}

async function main(): Promise<number> {
  const { json, integration } = parseArgs(process.argv.slice(2));
  const root = topLevel();
  if (root === null) fail(2, "conflict-map: not inside a git work tree.");
  const op = operationOrExit(root, integration);
  const previous = storedSnapshot(root);
  const catalog = catalogGeneratedEntries();
  const paths = mapConflicts(root, op, catalog, recordedSizes(previous, op));
  const fresh: Snapshot = {
    version: 1,
    operation: {
      kind: op.kind,
      head: op.head,
      incoming: op.incoming,
      base: op.base,
    },
    sides: {
      ours: op.ours,
      theirs: op.theirs,
      integration: op.integration,
      integrationWhy: op.integrationWhy,
    },
    warning: warningOf(op.warning, catalog),
    catalogIncomplete: catalog.incomplete,
    mappedAt: new Date().toISOString(),
    attribution: attributionOf(process.env),
    paths,
  };
  const { snapshot, note } = mergeSnapshot(
    previous,
    fresh,
    classifyPaths(root, stagedSince(previous, fresh), derivedEntries(catalog)),
  );
  if (previous !== null && !sameOperation(previous, op))
    recordBeforeReplacing(root, previous);
  const file = saveSnapshot(root, snapshot);
  if (!json) {
    console.log(summary(snapshot, Object.keys(paths), file, note));
    return 0;
  }
  console.log(JSON.stringify(snapshot, null, 2));
  if (snapshot.warning) console.error(`WARNING: ${snapshot.warning}`);
  return 0;
}

if (import.meta.main) runMain("conflict-map", main);
