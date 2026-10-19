#!/usr/bin/env bun
/**
 * Verify a conflict resolution before the operation is concluded: after every
 * path is resolved, recorded and staged, before `git commit`,
 * `git merge --continue` or `git rebase --continue`.
 *
 * Usage: bun check-resolution.ts [--json | --message | --commit-message]
 *   --message         on success, print the "Conflicts resolved:" section for
 *                     the commit message (or the pull-request comment).
 *   --commit-message  on success, print git's prepared message for this merge,
 *                     cherry-pick or revert (comment lines removed) followed
 *                     by that section: the whole message for `git commit -F`.
 *   --json            print the full result as JSON.
 *
 * It fails when a path is still unmerged; when conflict markers remain in a
 * mapped path or in any other staged change; when a mapped path has no
 * decision, an unknown one, or lacks a required reason; when staged content
 * differs from the working tree for a mapped path; when a lockfile or
 * generated file was not regenerated; when the configuration and change-area
 * catalog as they stand now classify a mapped path differently from the map
 * (its decision answered another requirement), or the catalog cannot be read.
 * Both, and the attributes, are read from the index, as the commit carries
 * them (lib/staged-config.ts), so a file changed on disk and not staged
 * decides nothing;
 * and when a side's change is dropped
 * without that being the recorded decision (the dropped-change check; see
 * lib/drops.ts). Every staged change must belong to the operation and match
 * Git's automatic result or a recorded decision. Repository obligations are
 * reported over the whole resolved diff; failed commands block conclusion.
 *
 * Exit codes: 0 the resolution passes; 1 problems, each listed with its file
 * and line; 2 usage error, invalid configuration or invalid obligation
 * configuration; 3 no operation in progress, no snapshot, or a snapshot of a
 * different operation (run conflict-map.ts first); 4 a path is
 * recorded as escalate: the resolution needs a human, and each question is
 * printed. Exit 4 wins over exit 1, since an escalated resolution is not
 * concluded either way.
 */
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail, runMain } from "../../../shared/cli.ts";
import {
  type Classification,
  classifyPaths,
  derivedEntries,
  sameRequirement,
  unmergedPaths,
} from "./conflict-map.ts";
import {
  type CatalogGenerated,
  catalogGeneratedEntries,
} from "./lib/classify.ts";
import { droppedLines } from "./lib/drops.ts";
import {
  git,
  gitPath,
  gitRaw,
  indexBlob,
  readBlob,
  splitNul,
  topLevel,
} from "./lib/git.ts";
import { markerLines } from "./lib/markers.ts";
import {
  obligationEntries,
  runObligations,
  type ObligationEntry,
  type ObligationResult,
} from "./lib/obligations.ts";
import { provenanceProblems } from "./lib/provenance.ts";
import {
  currentSnapshot,
  DECISIONS,
  isDecision,
  NEEDS_REASON,
  type PathEntry,
  type Snapshot,
} from "./lib/snapshot.ts";

export interface Finding {
  path: string;
  line?: number;
  message: string;
}

export interface CheckResult {
  exit: 0 | 1 | 4;
  problems: Finding[];
  notes: Finding[];
  escalations: { path: string; question: string }[];
}

function unstaged(root: string, path: string): boolean {
  return git(root, ["diff", "--name-only", "-z", "--", path]) !== "";
}

/**
 * A tree holding the regular `.gitattributes` files of the index (a link of
 * that name is ignored by a checkout), for git to read
 * attributes from instead of the working tree: the commit carries those, and
 * an untracked or ignored one decides nothing.
 */
function attributesTree(root: string): string {
  const records = splitNul(git(root, ["ls-files", "--stage", "-z"])).filter(
    (record) =>
      /^100(?:644|755) [0-9a-f]+ 0\t(?:.*\/)?\.gitattributes$/s.test(record),
  );
  const dir = mkdtempSync(join(tmpdir(), "check-resolution-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
    git(
      root,
      [...THROWAWAY_INDEX_CONFIG, "update-index", "-z", "--index-info"],
      records.map((record) => `${record}\0`).join(""),
      env,
    );
    return git(
      root,
      [...THROWAWAY_INDEX_CONFIG, "write-tree"],
      undefined,
      env,
    ).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Conflict markers in staged changes outside the mapped paths. */
function stagedMarkers(root: string, mapped: Snapshot["paths"]): Finding[] {
  // Exit 2 means it found something (whitespace errors count too); only the
  // marker lines matter here.
  const r = gitRaw(root, [
    `--attr-source=${attributesTree(root)}`,
    "diff",
    "--cached",
    "--check",
    "--no-ext-diff",
  ]);
  if (r.code !== 0 && r.code !== 2)
    throw new Error(
      `git diff --cached --check exited ${r.code}: ${r.stderr.trim()}`,
    );
  const found: Finding[] = [];
  for (const line of r.stdout.split("\n")) {
    const match = line.match(/^(.*):(\d+): leftover conflict marker$/);
    if (!match || Object.hasOwn(mapped, match[1] as string)) continue;
    found.push({
      path: match[1] as string,
      line: Number(match[2]),
      message: "conflict marker in a staged file",
    });
  }
  return found;
}

function checkPath(
  root: string,
  path: string,
  entry: PathEntry,
  stillUnmerged: boolean,
  currentMarkerSize: number,
  result: CheckResult,
): void {
  const problem = (message: string, line?: number) =>
    result.problems.push({ path, line, message });
  const note = (message: string, line?: number) =>
    result.notes.push({ path, line, message });
  const { decision, reason, command, dropped } = entry.resolution;

  if (decision === null || decision === undefined) {
    if (!stillUnmerged)
      problem(
        `no decision recorded: run record.ts ${path} <${DECISIONS.join("|")}>`,
      );
    return;
  }
  if (!isDecision(decision)) {
    problem(
      `unknown decision '${String(decision)}'; use one of ${DECISIONS.join(", ")}`,
    );
    return;
  }
  if (NEEDS_REASON.has(decision) && !reason?.trim())
    problem(`decision '${decision}' needs a reason`);
  if (decision === "escalate") {
    result.escalations.push({
      path,
      question: reason ?? "(no question recorded)",
    });
    return;
  }
  if (stillUnmerged) return;

  const stages = {
    base: entry.stages.base?.blob ?? null,
    ours: entry.stages.ours?.blob ?? null,
    theirs: entry.stages.theirs?.blob ?? null,
  };
  const blob = indexBlob(root, path);
  if (blob === null) {
    if (decision !== "deleted")
      problem(
        `removed from the index, but the decision is '${decision}': record deleted with a reason, or restore the path`,
      );
    else if (entry.class === "text")
      for (const d of droppedLines(root, stages, ""))
        note(`${d.side} line ${d.line} dropped: "${d.text}"`);
    return;
  }
  if (decision === "deleted")
    problem("decision is 'deleted' but the path is still staged: git rm it");
  if (unstaged(root, path))
    problem(
      "the working tree differs from what is staged: git add the final version (what is staged is what gets committed)",
    );

  const derived = entry.class === "lockfile" || entry.class === "generated";
  if (derived && decision !== "regenerated" && decision !== "deleted")
    problem(
      `is a ${entry.class === "lockfile" ? "lockfile" : "generated file"}: take the integration side, regenerate it${entry.regenerate ? ` (${entry.regenerate.command})` : ""} and record regenerated`,
    );
  if (decision === "regenerated" && !derived)
    problem(
      "decision 'regenerated' applies only to lockfiles and generated files: declare the path under resolve_conflicts.generated or in the change-area catalog's generated entries, or record another decision",
    );
  if (decision === "regenerated" && !command?.trim())
    problem("decision 'regenerated' needs the command that rebuilt the path");

  if (entry.class === "binary") return;
  const text = readBlob(root, blob);
  // The markers git wrote have the mapped size; markers rewritten since
  // (git checkout --conflict) have the size the attribute gives now.
  const lines = new Set(
    [...new Set([entry.markerSize, currentMarkerSize])].flatMap((size) =>
      markerLines(text, size),
    ),
  );
  for (const line of [...lines].sort((a, b) => a - b))
    problem("conflict marker left in the staged file", line);

  if (entry.class !== "text") return;
  // A hand-edited acknowledgement counts only with a reason and its lines.
  const acknowledgement =
    typeof dropped?.why === "string" &&
    dropped.why.trim() !== "" &&
    Array.isArray(dropped.lines)
      ? dropped
      : null;
  if (dropped && acknowledgement === null)
    problem(
      'the dropped-lines acknowledgement needs a nonempty why and a list of lines: record.ts <path> combined --dropped "<why>"',
    );
  for (const d of droppedLines(root, stages, text)) {
    const what = `${d.side} line ${d.line} dropped: "${d.text}"`;
    if (decision === "rewritten" || decision === "deleted") note(what);
    else if (decision === "combined") {
      const acknowledged = acknowledgement?.lines.some(
        (l) => l?.side === d.side && l?.text === d.text,
      );
      if (acknowledged) note(`${what} (acknowledged: ${acknowledgement?.why})`);
      else
        problem(
          `${what}. Restore it, or if it is gone on purpose record it: record.ts ${path} combined --dropped "<why>" (or ours/theirs/rewritten with a reason)`,
        );
    } else if (d.side === decision)
      problem(`${what}, although the decision keeps ${decision}`);
    else note(`${what} (decision: ${decision})`);
  }
}

/**
 * A catalog whose generated declarations could not all be honoured, when the
 * conflicts were mapped or now, may leave a generated file classified as text.
 */
function incompleteCatalog(
  snapshot: Snapshot,
  catalog: CatalogGenerated,
): Finding[] {
  const fix =
    "so a file it declares generated may be classified as text: resolve or correct the catalog, then run conflict-map.ts again";
  if (snapshot.catalogIncomplete)
    return [
      {
        path: "(conflict map)",
        message: `the change-area catalog's generated files could not all be read when the conflicts were mapped (${snapshot.catalogIncomplete}), ${fix}`,
      },
    ];
  if (catalog.incomplete)
    return [
      {
        path: "(conflict map)",
        message: `the change-area catalog's generated files cannot all be read now (${catalog.incomplete}), ${fix}`,
      },
    ];
  return [];
}

function describeClass(c: Classification): string {
  return c.regenerate ? `${c.class} (${c.regenerate.command})` : c.class;
}

/**
 * Mapped paths whose requirement has moved since the map: the configuration
 * and the catalog as they stand now, applied to each path's stored stages,
 * give a different class or generator than the snapshot holds, and the
 * decision was recorded against the snapshot's.
 */
function changedRequirements(
  snapshot: Snapshot,
  now: ReadonlyMap<string, Classification>,
): Finding[] {
  const found: Finding[] = [];
  for (const [path, entry] of Object.entries(snapshot.paths).sort()) {
    const after = now.get(path) as Classification;
    if (sameRequirement(entry, after)) continue;
    found.push({
      path,
      message: `mapped as ${describeClass(entry)}, but the configuration and change-area catalog now make it ${describeClass(after)}: run conflict-map.ts again and record the path again`,
    });
  }
  return found;
}

export function checkResolution(
  root: string,
  snapshot: Snapshot,
  catalog: CatalogGenerated,
): CheckResult {
  const result: CheckResult = {
    exit: 0,
    problems: [],
    notes: [],
    escalations: [],
  };
  const now = classifyPaths(
    root,
    new Map(
      Object.entries(snapshot.paths).map(([path, entry]) => [
        path,
        entry.stages,
      ]),
    ),
    derivedEntries(catalog),
  );
  const incomplete = incompleteCatalog(snapshot, catalog);
  result.problems.push(...incomplete);
  // A catalog that cannot be read now would report its generated files as
  // changed to text; the refusal above already covers them.
  if (incomplete.length === 0)
    result.problems.push(...changedRequirements(snapshot, now));
  const unmerged = unmergedPaths(root);
  for (const path of [...unmerged.keys()].sort()) {
    const entry = Object.hasOwn(snapshot.paths, path)
      ? snapshot.paths[path]
      : undefined;
    if (entry?.resolution.decision === "escalate") continue;
    result.problems.push({
      path,
      message:
        entry === undefined
          ? "still unmerged and not in the conflict map: run conflict-map.ts again"
          : "still unmerged: resolve it, then git add it (or git rm it)",
    });
  }
  for (const path of Object.keys(snapshot.paths).sort())
    checkPath(
      root,
      path,
      snapshot.paths[path] as PathEntry,
      unmerged.has(path),
      (now.get(path) as Classification).markerSize,
      result,
    );
  result.problems.push(...stagedMarkers(root, snapshot.paths));
  result.problems.push(
    ...provenanceProblems(root, snapshot, new Set(unmerged.keys())),
  );
  result.exit =
    result.escalations.length > 0 ? 4 : result.problems.length > 0 ? 1 : 0;
  return result;
}

/** The "Conflicts resolved:" section for the commit message. */
export function messageSection(snapshot: Snapshot): string {
  const lines = ["Conflicts resolved:"];
  for (const path of Object.keys(snapshot.paths).sort()) {
    const { decision, reason, command, dropped } = (
      snapshot.paths[path] as PathEntry
    ).resolution;
    let line = `- ${path}: ${decision}`;
    if (decision === "regenerated" && command) line += ` (${command})`;
    if (reason) line += ` — ${reason}`;
    if (dropped) line += ` Dropped on purpose: ${dropped.why}`;
    lines.push(line);
  }
  return lines.join("\n");
}

/** git's prepared message for the operation, without its comment lines. */
function preparedMessage(root: string): string {
  const path = gitPath(root, "MERGE_MSG");
  if (!existsSync(path))
    fail(2, "check-resolution: git prepared no message; use --message instead");
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
}

function render(f: Finding): string {
  return `${f.path}${f.line === undefined ? "" : `:${f.line}`}: ${f.message}`;
}

/** The staged tree, plus every tracked path whose file on disk differs from it. */
interface TreeState {
  tree: string;
  differing: Finding[];
}

const DIFFERS =
  "differs from the staged tree: obligation commands check files on disk, so stage or discard it first";
const SKIPPED_DIFFERS =
  "is marked assume-unchanged or skip-worktree, so git does not compare it, and its file on disk differs from the staged tree: clear the flag (git update-index --no-assume-unchanged --no-skip-worktree -- <path>), then stage or discard it";

const THROWAWAY_INDEX_CONFIG = [
  "-c",
  "core.splitIndex=false",
  "-c",
  "core.ignorestat=false",
];

/**
 * Tracked paths whose file on disk differs from the staged tree, as git itself
 * compares them. A plain `git diff` skips some paths: submodule ignore
 * settings hide a moved or dirty submodule (overridden here), and an
 * assume-unchanged or skip-worktree entry is never compared. Those entries are
 * re-staged without their flags into a throwaway copy of the index, so git
 * compares them as it compares any other entry, whatever their kind (file,
 * symlink, submodule) and whatever the checkout settings. Every git call on
 * that copy turns off the settings that would set a flag again on the way in
 * (`core.ignorestat` marks each re-staged entry assume-unchanged) or split the
 * copy across files. Initialized submodules are checked the same way, since
 * git's status of a submodule trusts the flags in the submodule's own index.
 */
function differingPaths(root: string, prefix = ""): Finding[] {
  const flagged = skippedEntries(root);
  const dir = mkdtempSync(join(tmpdir(), "check-resolution-"));
  try {
    const index = join(dir, "index");
    const source = gitPath(root, "index");
    if (existsSync(source)) copyFileSync(source, index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    if (flagged.size > 0)
      git(
        root,
        [...THROWAWAY_INDEX_CONFIG, "update-index", "-z", "--index-info"],
        [...flagged.values()].map((record) => `${record}\0`).join(""),
        env,
      );
    const differing = splitNul(
      git(
        root,
        [
          ...THROWAWAY_INDEX_CONFIG,
          "diff",
          "--name-only",
          "-z",
          "--ignore-submodules=none",
        ],
        undefined,
        env,
      ),
    ).map((path) => ({
      path: `${prefix}${path}`,
      message: flagged.has(path) ? SKIPPED_DIFFERS : DIFFERS,
    }));
    for (const path of initializedSubmodules(root))
      differing.push(...differingPaths(join(root, path), `${prefix}${path}/`));
    return differing;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function treeState(root: string): TreeState {
  const differing = differingPaths(root).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return { tree: git(root, ["write-tree"]).trim(), differing };
}

/**
 * Stage-0 entries marked assume-unchanged (a lowercase tag) or skip-worktree
 * (S), by path, each as the `git ls-files -s` record that re-stages it.
 */
function skippedEntries(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of splitNul(git(root, ["ls-files", "-s", "-v", "-z"]))) {
    const match = line.match(/^(\S) (\d+ [0-9a-f]+ 0\t(.*))$/s);
    if (!match) continue;
    const [, tag = "", record = "", path = ""] = match;
    if (tag === tag.toLowerCase() || tag === "S") entries.set(path, record);
  }
  return entries;
}

/** Submodule paths whose working tree is a checked-out repository. */
function initializedSubmodules(root: string): string[] {
  return splitNul(git(root, ["ls-files", "-s", "-z"]))
    .map((line) => line.match(/^160000 [0-9a-f]+ 0\t(.*)$/s)?.[1])
    .filter(
      (path): path is string =>
        path !== undefined && existsSync(join(root, path, ".git")),
    );
}

function notRun(
  entries: readonly ObligationEntry[],
  output: string,
): ObligationResult[] {
  return entries.map((entry) => ({
    check: entry.check,
    command: entry.command ?? null,
    status: "not-run",
    output,
  }));
}

/**
 * Commands read files on disk, so each runs only while the disk matches the
 * staged tree: the state is checked before every command and after the last,
 * a change stops the commands not yet run, and results stand only if no
 * command changed either.
 */
async function checkWithObligations(
  root: string,
  snapshot: Snapshot,
  catalog: CatalogGenerated,
): Promise<{ result: CheckResult; obligations: ObligationResult[] }> {
  const entries = obligationEntries();
  const result = checkResolution(root, snapshot, catalog);
  if (result.exit !== 0)
    return {
      result,
      obligations: notRun(
        entries,
        "Fix the resolution before running obligations.",
      ),
    };
  if (!entries.some((entry) => entry.command !== undefined))
    return { result, obligations: await runObligations(root, entries) };

  const before = treeState(root);
  if (before.differing.length > 0) {
    result.problems.push(...before.differing);
    result.exit = 1;
    return {
      result,
      obligations: notRun(
        entries,
        "The working tree differs from the staged tree.",
      ),
    };
  }
  const unchanged = () => {
    const now = treeState(root);
    return now.tree === before.tree && now.differing.length === 0;
  };
  const obligations = await runObligations(root, entries, () =>
    unchanged()
      ? null
      : "An earlier command changed the staged tree or the working tree, so this command did not run.",
  );
  const changed = !unchanged();
  // A command may have changed a catalog outside the repository, which the
  // tree state does not cover: the final check reads it again.
  const final = checkResolution(root, snapshot, catalogGeneratedEntries());
  if (changed || obligations.some((o) => o.status === "not-run"))
    final.problems.push({
      path: "resolve_conflicts.obligations",
      message:
        "a command changed the staged tree or the working tree, so its results describe an earlier state: review the change, stage or discard it, and run check-resolution.ts again",
    });
  for (const obligation of obligations)
    if (obligation.status === "failed")
      final.problems.push({
        path: "resolve_conflicts.obligations",
        message: `${obligation.check}: ${obligation.output}`,
      });
  if (final.exit !== 4 && final.problems.length > 0) final.exit = 1;
  return { result: final, obligations };
}

function reportObligations(
  obligations: readonly ObligationResult[],
  write: (line: string) => void,
): void {
  for (const obligation of obligations) {
    write(`OBLIGATION ${obligation.status}: ${obligation.check}`);
    if (obligation.command) write(`  command: ${obligation.command}`);
    write(`  ${obligation.output}`);
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const known = ["--json", "--message", "--commit-message"];
  if (args.length > 1 || args.some((a) => !known.includes(a)))
    fail(
      2,
      "usage: check-resolution.ts [--json | --message | --commit-message]",
    );
  const mode = args[0] ?? "";
  const root = topLevel();
  if (root === null) fail(2, "check-resolution: not inside a git work tree.");
  const { operation, snapshot } = currentSnapshot("check-resolution", root);
  if (mode === "--commit-message" && operation.kind === "rebase")
    fail(
      2,
      "check-resolution: a rebase concludes with 'git rebase --continue', which keeps the replayed commit's message; use --message and post the section on the pull request.",
    );
  const { result, obligations } = await checkWithObligations(
    root,
    snapshot,
    catalogGeneratedEntries(),
  );

  if (mode === "--json") {
    console.log(
      JSON.stringify(
        {
          ...result,
          operation: snapshot.operation,
          obligations,
          message: result.exit === 0 ? messageSection(snapshot) : null,
        },
        null,
        2,
      ),
    );
    return result.exit;
  }
  const report = (write: (line: string) => void) => {
    for (const f of result.problems) write(`PROBLEM ${render(f)}`);
    for (const e of result.escalations)
      write(`NEEDS A HUMAN ${e.path}: ${e.question}`);
    for (const f of result.notes) write(`note ${render(f)}`);
    reportObligations(obligations, write);
  };
  if (mode === "--message" || mode === "--commit-message") {
    report((line) => console.error(line));
    if (result.exit !== 0) return result.exit;
    console.log(
      mode === "--message"
        ? messageSection(snapshot)
        : `${preparedMessage(root)}\n\n${messageSection(snapshot)}`,
    );
    return 0;
  }
  report((line) => console.log(line));
  console.log(
    result.exit === 0
      ? "check-resolution: the resolution passes. Validate it, then conclude the operation."
      : result.exit === 4
        ? `check-resolution: ${result.escalations.length} path(s) need a human; do not conclude the operation.`
        : `check-resolution: ${result.problems.length} problem(s); fix them and run this again.`,
  );
  return result.exit;
}

if (import.meta.main) runMain("check-resolution", main);
