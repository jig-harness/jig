#!/usr/bin/env bun
/**
 * Record the resolution decision for one conflicted path in the conflict
 * snapshot, so nobody has to edit its JSON by hand.
 *
 * Usage: bun record.ts <path> <decision> [--reason "<text>"]
 *                      [--command "<command>"] [--dropped "<why>"]
 *
 *   <decision>  combined | ours | theirs | rewritten | regenerated | deleted
 *               | escalate. ours, theirs, rewritten, deleted and escalate
 *               need --reason (for escalate: the question for a human).
 *   --command   for regenerated: the command that rebuilt the path; defaults
 *               to the command the map found for it.
 *   --dropped   for combined: acknowledge that the lines the dropped-change
 *               check reports for this path right now are gone on purpose,
 *               and say why. Lines dropped later are not covered.
 *
 * Recording again for the same path replaces the earlier decision.
 *
 * Exit codes: 0 recorded; 2 usage error (unknown path or decision, missing
 * reason or command, regenerated for a path that is not a derived file); 3 no
 * operation in progress, no snapshot, or a snapshot of a different operation
 * (run conflict-map.ts).
 */
import { relative, resolve, sep } from "node:path";
import { mapConflicts } from "./conflict-map.ts";
import { catalogGeneratedEntries } from "./lib/classify.ts";
import {
  operationInputs,
  provenance,
  type Provenance,
} from "./lib/provenance.ts";
import { fail, runMain } from "../../../shared/cli.ts";
import { droppedLines, resolvedText } from "./lib/drops.ts";
import type { Operation } from "./lib/operation.ts";
import { topLevel } from "./lib/git.ts";
import {
  currentSnapshot,
  DECISIONS,
  isDecision,
  NEEDS_REASON,
  type Resolution,
  type Snapshot,
  type PathEntry,
  saveSnapshot,
} from "./lib/snapshot.ts";

const USAGE =
  'usage: record.ts <path> <decision> [--reason "<text>"] [--command "<command>"] [--dropped "<why>"]';

function readProvenance(root: string, operation: Operation): Provenance {
  try {
    return provenance(root, operationInputs(operation));
  } catch (err) {
    fail(2, `record: ${err instanceof Error ? err.message : err}`);
  }
}

function cleanStages(proof: Provenance, path: string): PathEntry["stages"] {
  return {
    base: proof.base.get(path) ?? null,
    ours: proof.ours.get(path) ?? null,
    theirs: proof.theirs.get(path) ?? null,
  };
}

function validateCleanPath(
  proof: Provenance,
  snapshot: Snapshot,
  path: string,
  given: string,
): void {
  if (!proof.allowed.has(path))
    fail(
      2,
      `record: ${given} is outside this operation and is not in the conflict map. Mapped paths: ${Object.keys(snapshot.paths).join(", ") || "(none)"}`,
    );
  if (proof.conflicts.has(path))
    fail(
      2,
      `record: ${given} conflicted but is missing from the map; restore the original snapshot before continuing`,
    );
}

function mappedEntry(
  root: string,
  operation: Operation,
  snapshot: Snapshot,
  path: string,
  given: string,
): PathEntry {
  if (Object.hasOwn(snapshot.paths, path))
    return snapshot.paths[path] as PathEntry;
  const proof = readProvenance(root, operation);
  validateCleanPath(proof, snapshot, path, given);
  const stages = cleanStages(proof, path);
  const entry = mapConflicts(
    root,
    operation,
    catalogGeneratedEntries(),
    new Map(),
    new Map([[path, stages]]),
  )[path];
  if (entry === undefined) fail(2, `record: cannot map ${given}`);
  const clean: PathEntry = { ...entry, clean: true };
  snapshot.paths[path] = clean;
  return clean;
}

async function main(): Promise<number> {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (["--reason", "--command", "--dropped"].includes(arg)) {
      const value = args[++i];
      if (value === undefined || value.trim() === "")
        fail(2, `record: ${arg} needs a nonempty value`, USAGE);
      options[arg.slice(2)] = value.trim();
    } else if (arg.startsWith("--"))
      fail(2, `record: unknown option ${arg}`, USAGE);
    else positional.push(arg);
  }
  const [given, decision] = positional;
  if (positional.length !== 2 || given === undefined) fail(2, USAGE);
  if (!isDecision(decision))
    fail(
      2,
      `record: unknown decision '${decision}'; use one of ${DECISIONS.join(", ")}`,
    );

  const root = topLevel();
  if (root === null) fail(2, "record: not inside a git work tree.");
  const { snapshot, operation } = currentSnapshot("record", root);
  const fromCwd = relative(root, resolve(given)).split(sep).join("/");
  const path = Object.hasOwn(snapshot.paths, given) ? given : fromCwd;
  const entry = mappedEntry(root, operation, snapshot, path, given);

  const reason = options.reason ?? null;
  if (NEEDS_REASON.has(decision) && reason === null)
    fail(
      2,
      decision === "escalate"
        ? "record: escalate needs --reason: the question to put to a human"
        : `record: ${decision} needs --reason: say for the reviewer why the change is dropped or replaced`,
    );
  if (
    decision === "regenerated" &&
    entry.class !== "lockfile" &&
    entry.class !== "generated"
  )
    fail(
      2,
      `record: regenerated applies only to lockfiles and generated files, and ${path} is ${entry.class}. Declare it under resolve_conflicts.generated or in the change-area catalog's generated entries, or record another decision.`,
    );
  if (options.command !== undefined && decision !== "regenerated")
    fail(2, "record: --command applies only to regenerated");
  if (options.dropped !== undefined && decision !== "combined")
    fail(2, "record: --dropped applies only to combined");

  const resolution: Resolution = {
    decision,
    reason,
    command: null,
    dropped: null,
  };
  if (decision === "regenerated") {
    resolution.command = options.command ?? entry.regenerate?.command ?? null;
    if (resolution.command === null)
      fail(
        2,
        `record: no regeneration command is known for ${path}; pass --command`,
      );
  }
  const notes: string[] = [];
  if (options.dropped !== undefined) {
    const text = resolvedText(root, path);
    const dropped =
      text === null
        ? []
        : droppedLines(
            root,
            {
              base: entry.stages.base?.blob ?? null,
              ours: entry.stages.ours?.blob ?? null,
              theirs: entry.stages.theirs?.blob ?? null,
            },
            text,
          );
    if (dropped.length === 0)
      notes.push(
        "nothing is dropped from either side; no acknowledgement stored",
      );
    else {
      resolution.dropped = {
        why: options.dropped,
        lines: dropped.map(({ side, text }) => ({ side, text })),
      };
      for (const d of dropped)
        notes.push(`acknowledged: ${d.side} line ${d.line} "${d.text}"`);
    }
  }
  entry.resolution = resolution;
  saveSnapshot(root, snapshot);
  const detail = resolution.command ? ` (${resolution.command})` : "";
  console.log(
    `recorded ${path}: ${decision}${detail}${reason ? ` — ${reason}` : ""}`,
  );
  for (const note of notes) console.log(`  ${note}`);
  return 0;
}

if (import.meta.main) runMain("record", main);
