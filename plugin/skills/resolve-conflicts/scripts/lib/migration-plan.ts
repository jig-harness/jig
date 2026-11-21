import { posix } from "node:path";
import { configuredMigrations } from "./classify.ts";
import {
  detectMigrationGroups,
  isMigrationMetadata,
  type MigrationGroup,
  type MigrationName,
  migrationName,
  snapshotPaths,
} from "./migration-config.ts";
import { sameStage, treeEntries } from "./provenance.ts";
import type { Snapshot, Stage } from "./snapshot.ts";

type Tree = ReadonlyMap<string, Stage>;
type Inputs = Pick<Snapshot, "operation" | "sides" | "paths">;
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

export function sources(group: MigrationGroup, tree: Tree): Source[] {
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

export function duplicateSequences(files: Source[], label: string): Problem[] {
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

interface MigrationSide {
  tree: Tree;
  files: Source[];
  added: Source[];
}

function migrationSide(
  group: MigrationGroup,
  tree: Tree,
  common: Tree,
): MigrationSide {
  const files = sources(group, tree);
  return { tree, files, added: files.filter(({ path }) => !common.has(path)) };
}

function branchTargets(
  group: MigrationGroup,
  integration: MigrationSide,
  branch: MigrationSide,
): Required[] {
  const pending = branch.added.filter(
    ({ path, stage }) => !sameStage(stage, integration.tree.get(path)),
  );
  let highest = integration.files.at(-1)?.name.ordinal ?? -1n;
  // Once a pending migration falls within the integration history, append
  // all pending migrations to the integration side in their original order.
  const needsRenumbering = pending.some(({ name }) => name.ordinal <= highest);
  return pending.map((source) => ({
    ...source,
    target: needsRenumbering
      ? numberedPath(group, source.name, ++highest)
      : source.path,
  }));
}

function snapshotsFor(group: MigrationGroup, files: Source[]): string[] {
  return files.flatMap(({ name }) => snapshotPaths(group, name));
}

function integrationSnapshots(
  group: MigrationGroup,
  integration: MigrationSide,
): Map<string, Stage | null> {
  const outputs = new Map<string, Stage | null>();
  const existing = snapshotsFor(group, integration.files);
  for (const path of existing) {
    const stage = integration.tree.get(path);
    if (stage !== undefined) outputs.set(path, stage);
  }

  for (const path of snapshotsFor(group, integration.added)) {
    if (
      !outputs.has(path) &&
      (group.command !== null || integration.tree.has(path))
    )
      outputs.set(path, null);
  }
  return outputs;
}

function branchSnapshots(
  group: MigrationGroup,
  branch: MigrationSide,
  pending: Required[],
): { outputs: string[]; obsolete: string[] } {
  const outputs: string[] = [];
  const obsolete: string[] = [];
  for (const { name, path, target } of pending) {
    const destination = migrationName(group, target) as MigrationName;
    const original = snapshotPaths(group, name);
    if (path !== target)
      obsolete.push(...original.filter((file) => branch.tree.has(file)));
    for (const [index, output] of snapshotPaths(group, destination).entries()) {
      // Detected legacy sequences can contain custom migrations without a snapshot.
      const hasOriginal = branch.tree.has(original[index] ?? "");
      if (group.command !== null || hasOriginal) outputs.push(output);
    }
  }
  return { outputs, obsolete };
}

function metadata(
  group: MigrationGroup,
  integration: MigrationSide,
  branch: MigrationSide,
  required: Required[],
  pending: Required[],
  moved: Required[],
  conflicted: string[],
): Pick<MigrationPlan, "outputs" | "regenerate" | "remove"> {
  const renumbering = moved.length > 0;
  const integrationOutputs = integrationSnapshots(group, integration);
  const branchFiles = branchSnapshots(group, branch, pending);
  const branchOutputs = branchFiles.outputs.filter(
    (path) => !integrationOutputs.has(path),
  );
  const outputs = new Map([
    [group.journal, null] as const,
    ...integrationOutputs,
    ...branchOutputs.map((path) => [path, null] as const),
  ]);
  const regenerate = new Set<string>();
  const hasNewPredecessors =
    pending.length > 0 &&
    integration.added.some(
      ({ path, stage }) => !sameStage(stage, branch.tree.get(path)),
    );
  if (renumbering || hasNewPredecessors) {
    regenerate.add(group.journal);
    for (const path of branchOutputs) regenerate.add(path);
  }
  for (const path of integrationOutputs.keys())
    if (!integration.tree.has(path)) regenerate.add(path);
  if (!renumbering)
    for (const path of conflicted) {
      regenerate.add(path);
      outputs.set(path, null);
    }

  const retained = new Set([
    ...outputs.keys(),
    ...required.map(({ target }) => target),
  ]);
  const obsolete = new Set([
    ...moved.map(({ path }) => path),
    ...branchFiles.obsolete,
  ]);
  return {
    outputs,
    regenerate: [...regenerate].sort(),
    remove: [...obsolete]
      .filter((path) => !integration.tree.has(path) && !retained.has(path))
      .sort(),
  };
}

function integrationPaths(
  group: MigrationGroup,
  integration: MigrationSide,
  pending: Required[],
): string[] {
  const candidates = [
    group.journal,
    ...snapshotsFor(group, integration.files),
    ...pending.map(({ path }) => path),
  ];
  return [...new Set(candidates)]
    .filter((path) => integration.tree.has(path))
    .sort();
}

function planProblems(
  group: MigrationGroup,
  integration: MigrationSide,
  branch: MigrationSide,
  renumbering: boolean,
): Problem[] {
  const problems = [
    ...duplicateSequences(integration.files, "the integration side"),
    ...duplicateSequences(branch.files, "the branch"),
  ];
  if (renumbering && group.command === null)
    problems.push({
      path: group.journal,
      message:
        "configure a repository regeneration command under resolve_conflicts.sequenced_migrations before renumbering migrations",
    });
  return problems;
}

function makePlan(
  group: MigrationGroup,
  inputs: Inputs,
  trees: Trees,
): MigrationPlan | null {
  const integrationSide = inputs.sides.integration;
  const branchSide = integrationSide === "ours" ? "theirs" : "ours";
  const integration = migrationSide(group, trees[integrationSide], trees.base);
  const branch = migrationSide(group, trees[branchSide], trees.base);
  const conflicted = Object.entries(inputs.paths)
    .filter(([path, entry]) => !entry.clean && isMigrationMetadata(group, path))
    .map(([path]) => path);
  if (integration.added.length + branch.added.length + conflicted.length === 0)
    return null;

  const pending = branchTargets(group, integration, branch);
  const moved = pending.filter(({ path, target }) => path !== target);
  const renumbering = moved.length > 0;
  const original = renumbering ? integration.files : integration.added;
  const required = [
    ...original.map((source) => ({ ...source, target: source.path })),
    ...pending,
  ];
  const steps = metadata(
    group,
    integration,
    branch,
    required,
    pending,
    moved,
    conflicted,
  );
  return {
    group,
    integration: {
      commit: inputs.sides[integrationSide].commit,
      paths: renumbering
        ? integrationPaths(group, integration, pending)
        : conflicted.filter((path) => integration.tree.has(path)).sort(),
    },
    moves: moved.map(({ path, target }) => ({
      from: path,
      to: target,
      commit: inputs.sides[branchSide].commit,
    })),
    required,
    ...steps,
    problems: planProblems(group, integration, branch, renumbering),
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
  const paths = new Set([
    ...trees.base.keys(),
    ...trees.ours.keys(),
    ...trees.theirs.keys(),
  ]);
  const groups = detectMigrationGroups(configured, paths);
  return groups.flatMap((group) => {
    const plan = makePlan(group, inputs, trees);
    return plan === null ? [] : [plan];
  });
}
