import { posix } from "node:path";
import { swallow } from "../../../../shared/errors.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { configuredMigrations } from "./classify.ts";
import { readBlob } from "./git.ts";
import {
  detectMigrationGroups,
  type MigrationGroup,
  type MigrationName,
  migrationName,
  snapshotPaths,
} from "./migration-config.ts";
import { sameStage, treeEntries } from "./provenance.ts";
import type { Snapshot, Stage } from "./snapshot.ts";

type Tree = ReadonlyMap<string, Stage>;
type Inputs = Pick<Snapshot, "operation" | "sides">;
type Trees = { base: Tree; ours: Tree; theirs: Tree };
type Problem = { path: string; message: string };

interface Source {
  path: string;
  name: MigrationName;
  stage: Stage;
}

interface Required extends Source {
  target: string;
}

export interface MigrationPlan {
  group: MigrationGroup;
  integration: { commit: string; paths: string[] };
  moves: { from: string; to: string; commit: string }[];
  remove: string[];
  required: Required[];
  outputs: Map<string, Stage | null>;
  regenerate: string[];
  problems: Problem[];
}

function compare(a: Source, b: Source): number {
  if (a.name.ordinal !== b.name.ordinal)
    return a.name.ordinal < b.name.ordinal ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function sources(group: MigrationGroup, tree: Tree): Source[] {
  const result: Source[] = [];
  for (const [path, stage] of tree) {
    const name = migrationName(group, path);
    if (name !== null) result.push({ path, name, stage });
  }
  return result.sort(compare);
}

function numberedPath(
  group: MigrationGroup,
  name: MigrationName,
  ordinal: bigint,
): string {
  const number = ordinal.toString().padStart(name.sequence.length, "0");
  return posix.join(group.directory, `${number}${name.suffix}.sql`);
}

function duplicateSequences(files: Source[], label: string): Problem[] {
  return files.flatMap((file, index) =>
    file.name.ordinal === files[index - 1]?.name.ordinal
      ? [
          {
            path: file.path,
            message: `${label} already has two migrations with sequence ${file.name.sequence}`,
          },
        ]
      : [],
  );
}

function makePlan(
  group: MigrationGroup,
  inputs: Inputs,
  common: Tree,
  integrationTree: Tree,
  branchTree: Tree,
): MigrationPlan | null {
  const integration = sources(group, integrationTree);
  const branch = sources(group, branchTree);
  const integrationAdded = integration.filter(({ path }) => !common.has(path));
  const branchAdded = branch.filter(({ path }) => !common.has(path));
  if (integrationAdded.length + branchAdded.length === 0) return null;

  const integrationSide = inputs.sides.integration;
  const branchSide = integrationSide === "ours" ? "theirs" : "ours";
  const newToBranch = branchAdded.filter(
    ({ path, stage }) => !sameStage(stage, integrationTree.get(path)),
  );
  const highest = integration.at(-1)?.name.ordinal ?? -1n;
  const renumber = newToBranch.some(({ name }) => name.ordinal <= highest);
  let next = highest;
  // On a collision keep the integration tree's history, then append every
  // pending branch migration in its original order.
  const pending = newToBranch.map((source) => ({
    ...source,
    target: renumber ? numberedPath(group, source.name, ++next) : source.path,
  }));
  const moved = pending.filter(({ path, target }) => path !== target);
  const moves = moved.map(({ path, target }) => ({
    from: path,
    to: target,
    commit: inputs.sides[branchSide].commit,
  }));

  const integrationFiles = renumber ? integration : integrationAdded;
  const required = [
    ...integrationFiles.map((source) => ({ ...source, target: source.path })),
    ...pending,
  ];
  const problems = [
    ...duplicateSequences(integration, "the integration side"),
    ...duplicateSequences(branch, "the branch"),
  ];
  if (renumber && group.command === null)
    problems.push({
      path: group.journal,
      message:
        "configure a repository regeneration command under resolve_conflicts.sequenced_migrations before renumbering migrations",
    });

  const outputs = new Map<string, Stage | null>([[group.journal, null]]);
  const regenerate = [group.journal];
  const remove = new Set<string>();
  const restore = new Set<string>();
  if (integrationTree.has(group.journal)) restore.add(group.journal);
  for (const source of integration) {
    for (const path of snapshotPaths(group, source.name)) {
      const stage = integrationTree.get(path);
      if (stage === undefined) continue;
      restore.add(path);
      if (renumber) outputs.set(path, stage);
    }
  }
  for (const { path, target, name } of pending) {
    const destination = migrationName(group, target) as MigrationName;
    const existing = snapshotPaths(group, name);
    if (renumber) {
      if (integrationTree.has(path)) restore.add(path);
      else if (path !== target) remove.add(path);
      for (const snapshot of existing)
        if (
          branchTree.has(snapshot) &&
          !integrationTree.has(snapshot) &&
          path !== target
        )
          remove.add(snapshot);
    }
    for (const [index, output] of snapshotPaths(group, destination).entries()) {
      // Legacy Drizzle permits custom migrations without snapshots. A
      // configured snapshot template requires the output for every addition.
      if (group.command === null && !branchTree.has(existing[index] ?? ""))
        continue;
      outputs.set(output, null);
      if (renumber) regenerate.push(output);
    }
  }
  for (const source of integrationAdded) {
    for (const path of snapshotPaths(group, source.name)) {
      if (integrationTree.has(path) || group.command !== null)
        if (!outputs.has(path))
          outputs.set(
            path,
            renumber ? (integrationTree.get(path) ?? null) : null,
          );
    }
  }
  for (const path of remove)
    if (outputs.has(path) || required.some(({ target }) => target === path))
      remove.delete(path);

  return {
    group,
    integration: {
      commit: inputs.sides[integrationSide].commit,
      paths: [...restore].sort(),
    },
    moves,
    remove: [...remove].sort(),
    required,
    outputs,
    regenerate: [...new Set(regenerate)].sort(),
    problems,
  };
}

function committedTrees(root: string, inputs: Inputs): Trees {
  return {
    base:
      inputs.operation.base === null
        ? new Map()
        : treeEntries(root, inputs.operation.base),
    ours: treeEntries(root, inputs.sides.ours.commit),
    theirs: treeEntries(root, inputs.sides.theirs.commit),
  };
}

export function migrationPlans(
  root: string,
  inputs: Inputs,
  trees: Trees = committedTrees(root, inputs),
): MigrationPlan[] {
  const configured = configuredMigrations();
  const { base } = trees;
  const { integration } = inputs.sides;
  const branch = integration === "ours" ? "theirs" : "ours";
  const paths = new Set([
    ...base.keys(),
    ...trees.ours.keys(),
    ...trees.theirs.keys(),
  ]);
  const groups = detectMigrationGroups(configured, paths);
  return groups.flatMap((group) => {
    const plan = makePlan(
      group,
      inputs,
      base,
      trees[integration],
      trees[branch],
    );
    return plan === null ? [] : [plan];
  });
}

/** An ordered JSON filename list, or legacy Drizzle's ordered tag entries. */
function journalNames(text: string): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    swallow(
      err,
      "an invalid migration journal is reported by the resolution check",
    );
    return null;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    return value;
  if (!isRecord(value) || !Array.isArray(value.entries)) return null;
  const names: string[] = [];
  let previousWhen = -Infinity;
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.tag !== "string" ||
      entry.idx !== names.length ||
      typeof entry.when !== "number" ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= previousWhen
    )
      return null;
    previousWhen = entry.when;
    names.push(`${entry.tag}.sql`);
  }
  return names;
}

function isRegular(stage: Stage | undefined): stage is Stage {
  return stage?.mode === "100644" || stage?.mode === "100755";
}

/**
 * Check the whole staged migration sequence even if a migration merged
 * cleanly, or its recorded decision acknowledges a deletion. Only the
 * planned new paths and generated outputs may bypass ordinary provenance.
 */
export function checkMigrations(
  root: string,
  plans: MigrationPlan[],
  staged: Tree,
): { problems: Problem[]; verified: Set<string> } {
  const problems: Problem[] = [];
  const verified = new Set<string>();
  for (const plan of plans) {
    problems.push(...plan.problems);
    for (const source of plan.required) {
      if (
        !isRegular(source.stage) ||
        !sameStage(source.stage, staged.get(source.target))
      )
        problems.push({
          path: source.target,
          message: `migration ${source.path} is missing or changed at ${source.target}: preserve the committed migration`,
        });
      else if (source.path !== source.target) verified.add(source.target);
    }

    for (const path of plan.remove)
      if (staged.has(path))
        problems.push({
          path,
          message:
            "obsolete migration or snapshot still staged after renumbering",
        });

    const files = sources(plan.group, staged);
    problems.push(...duplicateSequences(files, "the staged tree"));
    const expected = files.map(({ path }) => posix.basename(path));
    const journal = staged.get(plan.group.journal);
    const actual = isRegular(journal)
      ? journalNames(readBlob(root, journal.blob))
      : null;
    if (
      actual === null ||
      actual.length !== expected.length ||
      actual.some((name, i) => name !== expected[i])
    )
      problems.push({
        path: plan.group.journal,
        message:
          "migration journal must list each staged migration in sequence order: regenerate the journal and snapshots",
      });

    for (const [path, original] of plan.outputs) {
      const stage = staged.get(path);
      if (
        !isRegular(stage) ||
        (original !== null && !sameStage(original, stage))
      )
        problems.push({
          path,
          message:
            original === null
              ? "regenerated migration output is missing"
              : "integration snapshot was changed: restore its committed version",
        });
      else if (plan.moves.length > 0) verified.add(path);
    }
  }
  return { problems, verified };
}
