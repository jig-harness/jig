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
 * the same operation keeps the decisions already recorded; a snapshot for a
 * different operation is replaced. Reads nothing else into the repository
 * and changes nothing else.
 *
 * Reads `resolve_conflicts.generated` from `.config/jig.yaml`
 * (path globs and the command that regenerates them); JIG_OVERLAY
 * points at another configuration file.
 *
 * Exit codes: 0 mapped; 2 usage error, not in a git work tree, or invalid
 * configuration; 3 no merge, rebase, cherry-pick or revert is in progress, or
 * the stored snapshot is unreadable (it is never replaced: it holds what git
 * forgot about the paths already staged).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fail,
  isEntryPoint,
  runMain,
} from "../../resolve-review-comments/scripts/lib/cli.ts";
import { generatedEntries, regenerateFor } from "./lib/classify.ts";
import { git, readBlob, splitNul, topLevel } from "./lib/git.ts";
import { parseHunks } from "./lib/markers.ts";
import {
  detectOperation,
  NoOperation,
  type Operation,
  type SideName,
} from "./lib/operation.ts";
import {
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

interface Unmerged {
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

/** `git check-attr` values for the attributes the map reads, per path. */
function attributes(
  root: string,
  paths: string[],
): Map<string, Record<string, string>> {
  const result = new Map<string, Record<string, string>>();
  if (paths.length === 0) return result;
  const out = splitNul(
    git(
      root,
      ["check-attr", "-z", "--stdin", "diff", "merge", "conflict-marker-size"],
      `${paths.join("\0")}\0`,
    ),
  );
  for (let i = 0; i + 2 < out.length; i += 3) {
    const path = out[i] as string;
    const values = result.get(path) ?? {};
    values[out[i + 1] as string] = out[i + 2] as string;
    result.set(path, values);
  }
  return result;
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
    if (readBlob(root, stage.blob).slice(0, 8000).includes("\0")) return true;
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

/** Map every unmerged path of the operation in progress. */
export function mapConflicts(
  root: string,
  op: Operation,
): Record<string, PathEntry> {
  const unmerged = unmergedPaths(root);
  const paths = [...unmerged.keys()].sort();
  const attrs = attributes(root, paths);
  const entries = generatedEntries();
  const intent = intentReader(root, op);
  // Keyed by git paths, so `__proto__` is an ordinary path: no prototype.
  const mapped: Record<string, PathEntry> = Object.create(null);
  for (const path of paths) {
    const stages = unmerged.get(path) as Unmerged;
    const kind = kindOf(stages);
    const pathAttrs = attrs.get(path) ?? {};
    const size = Number(pathAttrs["conflict-marker-size"]);
    const markerSize =
      Number.isInteger(size) && size > 0 ? size : DEFAULT_MARKER_SIZE;
    const derived = regenerateFor(path, entries);
    const cls = derived
      ? derived.class
      : isBinary(root, stages, pathAttrs)
        ? "binary"
        : "text";
    const file = join(root, path);
    const hunks =
      cls === "text" && existsSync(file)
        ? parseHunks(readFileSync(file, "utf8"), markerSize)
        : [];
    mapped[path] = {
      kind,
      class: cls,
      markerSize,
      regenerate: derived
        ? { command: derived.command, cwd: derived.cwd, source: derived.source }
        : null,
      stages,
      hunks,
      intent: intent(path, kind),
      resolution: emptyResolution(),
    };
  }
  return mapped;
}

/**
 * Fold a fresh map into the stored snapshot. The same operation keeps every
 * recorded decision and every path mapped earlier (a staged path is no longer
 * unmerged, but its entry is still what the check needs); a different
 * operation's snapshot is replaced.
 */
export function mergeSnapshot(
  previous: Snapshot | null,
  fresh: Snapshot,
): { snapshot: Snapshot; note: string } {
  if (previous === null) return { snapshot: fresh, note: "new" };
  if (!sameOperation(previous, fresh.operation))
    return {
      snapshot: fresh,
      note: `replaced the snapshot of a different operation (${previous.operation.kind} of ${previous.operation.incoming.slice(0, 12)} onto ${previous.operation.head.slice(0, 12)})`,
    };
  const paths: Record<string, PathEntry> = Object.assign(
    Object.create(null),
    previous.paths,
  );
  for (const [path, entry] of Object.entries(fresh.paths)) {
    const resolution = Object.hasOwn(previous.paths, path)
      ? previous.paths[path]?.resolution
      : undefined;
    paths[path] = { ...entry, resolution: resolution ?? entry.resolution };
  }
  const kept = Object.values(paths).filter(
    (entry) => entry.resolution.decision,
  ).length;
  return {
    snapshot: { ...fresh, paths },
    note: `updated: kept ${kept} recorded decision${kept === 1 ? "" : "s"}`,
  };
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

function usage(): never {
  fail(2, "usage: conflict-map.ts [--json] [--integration ours|theirs]");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
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
  const root = topLevel();
  if (root === null) fail(2, "conflict-map: not inside a git work tree.");
  let op: Operation;
  try {
    op = detectOperation(root, integration);
  } catch (err) {
    if (err instanceof NoOperation)
      fail(3, `conflict-map: ${err.message} Nothing to map.`);
    throw err;
  }
  const paths = mapConflicts(root, op);
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
    warning: op.warning,
    mappedAt: new Date().toISOString(),
    paths,
  };
  let previous: Snapshot | null = null;
  try {
    previous = loadSnapshot(root);
  } catch (err) {
    // A path staged since the map was written is no longer unmerged, so its
    // conflict stages and decision exist only in that snapshot: never replace it.
    fail(
      3,
      `conflict-map: the stored snapshot is unreadable: ${err instanceof Error ? err.message : err}`,
      "Restore it if any conflicted path has been staged since it was written. If none has, move it aside and run conflict-map.ts again.",
    );
  }
  const { snapshot, note } = mergeSnapshot(previous, fresh);
  const file = saveSnapshot(root, snapshot);
  if (json) console.log(JSON.stringify(snapshot, null, 2));
  else {
    console.log(summary(snapshot, Object.keys(paths), file, note));
  }
  if (json && snapshot.warning) console.error(`WARNING: ${snapshot.warning}`);
  return 0;
}

if (isEntryPoint(import.meta.url)) runMain("conflict-map", main);
