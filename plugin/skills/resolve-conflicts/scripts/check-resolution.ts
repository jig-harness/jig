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
 * generated file was not regenerated; and when a side's change is dropped
 * without that being the recorded decision (the dropped-change check; see
 * lib/drops.ts). Every staged change must belong to the operation and match
 * Git's automatic result or a recorded decision. Repository obligations are
 * reported over the whole resolved diff; failed commands block conclusion.
 *
 * Exit codes: 0 the resolution passes; 1 problems, each listed with its file
 * and line; 2 usage error or invalid obligation configuration; 3 no operation in progress, no snapshot, or a
 * snapshot of a different operation (run conflict-map.ts first); 4 a path is
 * recorded as escalate: the resolution needs a human, and each question is
 * printed. Exit 4 wins over exit 1, since an escalated resolution is not
 * concluded either way.
 */
import { existsSync, readFileSync } from "node:fs";
import { fail, runMain } from "../../../shared/cli.ts";
import { unmergedPaths } from "./conflict-map.ts";
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

/** Conflict markers in staged changes outside the mapped paths. */
function stagedMarkers(root: string, mapped: Snapshot["paths"]): Finding[] {
  // Exit 2 means it found something (whitespace errors count too); only the
  // marker lines matter here.
  const r = gitRaw(root, ["diff", "--cached", "--check", "--no-ext-diff"]);
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
      "decision 'regenerated' applies only to lockfiles and generated files: declare the path under resolve_conflicts.generated, or record another decision",
    );
  if (decision === "regenerated" && !command?.trim())
    problem("decision 'regenerated' needs the command that rebuilt the path");

  if (entry.class === "binary") return;
  const text = readBlob(root, blob);
  for (const line of markerLines(text, entry.markerSize))
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

export function checkResolution(root: string, snapshot: Snapshot): CheckResult {
  const result: CheckResult = {
    exit: 0,
    problems: [],
    notes: [],
    escalations: [],
  };
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
  unstaged: string[];
}

function treeState(root: string): TreeState {
  return {
    tree: git(root, ["write-tree"]).trim(),
    unstaged: splitNul(git(root, ["diff", "--name-only", "-z"])).sort(),
  };
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
 * Commands read files on disk, so they run only when the disk matches the
 * staged tree, and their results stand only if no command changed either.
 */
async function checkWithObligations(
  root: string,
  snapshot: Snapshot,
): Promise<{ result: CheckResult; obligations: ObligationResult[] }> {
  const entries = obligationEntries();
  const result = checkResolution(root, snapshot);
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
  if (before.unstaged.length > 0) {
    for (const path of before.unstaged)
      result.problems.push({
        path,
        message:
          "differs from the staged tree: obligation commands check files on disk, so stage or discard it first",
      });
    result.exit = 1;
    return {
      result,
      obligations: notRun(
        entries,
        "The working tree differs from the staged tree.",
      ),
    };
  }
  const obligations = await runObligations(root, entries);
  const after = treeState(root);
  const final = checkResolution(root, snapshot);
  if (after.tree !== before.tree || after.unstaged.length > 0)
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
  const { result, obligations } = await checkWithObligations(root, snapshot);

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
