/** Reconstruct Git's automatic result from committed inputs, never the index. */
import { DecodeError } from "../../../../shared/guards.ts";
import { git, gitRaw, splitNul } from "./git.ts";
import type { Operation } from "./operation.ts";
import type { Snapshot, Stage } from "./snapshot.ts";

type Inputs = Pick<Snapshot, "operation" | "sides">;
export interface Provenance {
  allowed: Set<string>;
  conflicts: Set<string>;
  automatic: Map<string, Stage>;
  base: Map<string, Stage>;
  ours: Map<string, Stage>;
  theirs: Map<string, Stage>;
}

export function treeEntries(root: string, tree: string): Map<string, Stage> {
  const result = new Map<string, Stage>();
  for (const record of splitNul(git(root, ["ls-tree", "-r", "-z", tree]))) {
    const match = record.match(/^(\d+) \w+ ([0-9a-f]+)\t(.*)$/s);
    if (!match)
      throw new DecodeError(
        "git ls-tree",
        "$",
        "cannot parse a Git tree entry",
      );
    result.set(match[3] as string, {
      mode: match[1] as string,
      blob: match[2] as string,
    });
  }
  return result;
}

export function sameStage(a: Stage | undefined, b: Stage | undefined): boolean {
  if (a === undefined) return b === undefined;
  if (b === undefined) return false;
  return a.mode === b.mode && a.blob === b.blob;
}

export function operationInputs(op: Operation): Inputs {
  return {
    operation: op,
    sides: {
      ours: op.ours,
      theirs: op.theirs,
      integration: op.integration,
      integrationWhy: op.integrationWhy,
    },
  };
}

/** The arguments distinguish a true merge from a replay's explicit base. */
function mergeArguments(root: string, op: Inputs["operation"]): string[] {
  const args = ["merge-tree", "--write-tree", "--name-only", "-z"];
  if (isMerging(root, op)) {
    if (op.base === null) args.push("--allow-unrelated-histories");
  } else {
    const base =
      op.base ??
      git(root, ["hash-object", "-w", "-t", "tree", "--stdin"], "").trim();
    args.push(`--merge-base=${base}`);
  }
  return args;
}

function isMerging(root: string, op: Inputs["operation"]): boolean {
  return (
    op.kind === "merge" ||
    gitRaw(root, ["rev-parse", "--verify", "MERGE_HEAD"]).code === 0
  );
}

function automaticTree(
  root: string,
  inputs: Inputs,
): { tree: string; conflicts: Set<string> } {
  const result = gitRaw(root, [
    ...mergeArguments(root, inputs.operation),
    inputs.sides.ours.commit,
    inputs.sides.theirs.commit,
  ]);
  if (result.code !== 0 && result.code !== 1)
    throw new DecodeError(
      "git merge-tree",
      "$",
      `cannot reconstruct the automatic result (Git 2.41 or newer is required): ${result.stderr.trim()}`,
    );
  return parseAutomaticTree(result.stdout);
}

function parseAutomaticTree(output: string): {
  tree: string;
  conflicts: Set<string>;
} {
  const records = splitNul(output);
  const tree = records.shift();
  if (!tree || !/^[0-9a-f]+$/.test(tree))
    throw new DecodeError(
      "git merge-tree",
      "$",
      "Git did not return an automatic merge tree",
    );
  return { tree, conflicts: conflictPaths(records) };
}

function conflictPaths(records: string[]): Set<string> {
  const conflicts = new Set<string>();
  for (const path of records) {
    if (path === "") break;
    conflicts.add(path);
  }
  return conflicts;
}

function changedPaths(
  base: Map<string, Stage>,
  side: Map<string, Stage>,
): string[] {
  return [...new Set([...base.keys(), ...side.keys()])].filter(
    (path) => !sameStage(base.get(path), side.get(path)),
  );
}

/** Git 2.40+ supplies the explicit merge base needed for replay operations. */
export function provenance(root: string, inputs: Inputs): Provenance {
  const { operation: op, sides } = inputs;
  const { tree, conflicts } = automaticTree(root, inputs);
  const base =
    op.base === null ? new Map<string, Stage>() : treeEntries(root, op.base);
  const ours = treeEntries(root, sides.ours.commit);
  const theirs = treeEntries(root, sides.theirs.commit);
  const allowed = new Set([
    ...conflicts,
    ...changedPaths(base, ours),
    ...changedPaths(base, theirs),
  ]);
  return {
    allowed,
    conflicts,
    automatic: treeEntries(root, tree),
    base,
    ours,
    theirs,
  };
}

/** Full stage-0 index, with modes; unmerged paths are checked separately. */
export function stagedEntries(root: string): Map<string, Stage> {
  const result = new Map<string, Stage>();
  for (const record of splitNul(git(root, ["ls-files", "--stage", "-z"]))) {
    const match = record.match(/^(\d+) ([0-9a-f]+) 0\t(.*)$/s);
    if (match)
      result.set(match[3] as string, {
        mode: match[1] as string,
        blob: match[2] as string,
      });
  }
  return result;
}

type Problem = { path: string; message: string };
const OUTSIDE_OPERATION =
  "staged path is outside this operation: unstage the unrelated change and carry it in a separate commit";

function unmappedProblem(
  path: string,
  proof: Provenance,
  changed: boolean,
): string | null {
  if (proof.conflicts.has(path))
    return "conflicted path is missing from the conflict map: restore its snapshot before continuing";
  if (changed)
    return `staged content differs from Git's automatic result; no decision recorded: run record.ts ${path} <decision> and explain the change`;
  return null;
}

function outsideProblem(changed: boolean, mapped: boolean): string | null {
  return changed || mapped ? OUTSIDE_OPERATION : null;
}

function pathProblem(
  path: string,
  proof: Provenance,
  staged: Map<string, Stage>,
  snapshot: Snapshot,
): string | null {
  const mapped = Object.hasOwn(snapshot.paths, path);
  const changed = !sameStage(staged.get(path), proof.automatic.get(path));
  if (!proof.allowed.has(path)) return outsideProblem(changed, mapped);
  if (mapped) return null;
  return unmappedProblem(path, proof, changed);
}

function inspectProvenance(
  root: string,
  snapshot: Snapshot,
  unmerged: ReadonlySet<string>,
): Problem[] {
  const proof = provenance(root, snapshot);
  const staged = stagedEntries(root);
  const problems: Problem[] = [];
  for (const path of new Set([
    ...staged.keys(),
    ...proof.automatic.keys(),
    ...proof.conflicts,
    ...Object.keys(snapshot.paths),
  ])) {
    if (unmerged.has(path)) continue;
    const message = pathProblem(path, proof, staged, snapshot);
    if (message !== null) problems.push({ path, message });
  }
  return problems;
}

/** Every staged deviation needs a decision, and every path needs an input. */
export function provenanceProblems(
  root: string,
  snapshot: Snapshot,
  unmerged: ReadonlySet<string>,
): Problem[] {
  try {
    return inspectProvenance(root, snapshot, unmerged);
  } catch (err) {
    return [
      {
        path: "(provenance)",
        message: err instanceof Error ? err.message : String(err),
      },
    ];
  }
}
