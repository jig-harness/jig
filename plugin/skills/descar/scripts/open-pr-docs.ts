#!/usr/bin/env bun
/**
 * List the documents that other open pull requests change, so a de-scarring
 * pass leaves them alone: editing a document another pull request is
 * rewriting creates merge conflicts and review noise.
 *
 * Usage: bun open-pr-docs.ts [--docs-dir <dir>]
 *   Run from the repository root. Prints one path per line (paths under the
 *   docs root, default `docs`), and a summary on stderr.
 *
 * Exit codes: 0 the census is complete (an empty list means no other open
 * pull request touches the docs); 2 the census could not be taken.
 *
 * It fails closed. An empty list must mean "nothing to exclude", never "the
 * query failed", so every failure aborts instead of narrowing the pass:
 *
 * - Every `gh` call is bounded (30 s) so a stalled request cannot hang the
 *   pass. The calls only read, so a synchronous child with a timeout is
 *   enough here.
 * - The current pull request is recognised by number, not branch name: a
 *   fork's pull request can carry the same branch name. With no current
 *   branch (detached HEAD) the number is unknown and every open pull request
 *   counts as another one: safe by over-exclusion.
 * - A branch with no pull request yet is normal. `gh` reports it with the
 *   message "no pull requests found for branch"; only that message means "no
 *   current pull request". Any other failure (authentication, network)
 *   aborts, because treating it as "no current pull request" would exclude
 *   the current pull request's own documents.
 * - `gh` returns at most 100 files per pull request whatever `--limit` says.
 *   Another pull request that changes more files than were returned aborts
 *   the census rather than scoping against a truncated list. The current
 *   pull request is removed before that check, so a large current pull
 *   request never blocks the pass.
 * - `gh pr list` returns at most `--limit` pull requests. A list that reaches
 *   the limit may have left some out, so it aborts the census instead of
 *   reporting documents as safe that an omitted pull request changes.
 * - Every entry of that list is checked (an integer number, a non-negative
 *   integer file count, string paths) before it is trusted: a malformed but
 *   parseable entry would otherwise pass the truncation check by accident.
 * - `gh` reports paths relative to the repository root with forward slashes,
 *   so the docs root is normalized to that form (`./docs`, `docs/`, an
 *   absolute path inside the repository and `docs\sub` all work; `.` means
 *   the whole repository). A root outside the repository aborts, because it
 *   could only ever match nothing.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string, args: string[]) => RunResult;

const CALL_TIMEOUT_MS = 30_000;
export const PR_LIST_LIMIT = 500;

export const run: Runner = (command, args) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: CALL_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.error ? String(result.error.message) : (result.stderr ?? ""),
  };
};

export class CensusError extends Error {}

interface OpenPr {
  number: number;
  changedFiles: number;
  files: { path: string }[];
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The docs root as a repository-relative POSIX prefix ending in `/`, or `""`
 * for the whole repository. A relative root resolves against `cwd`.
 */
export function docsPrefix(docsDir: string, top: string, cwd: string): string {
  const root = real(top);
  const dir = real(resolve(real(cwd), docsDir.replace(/\\/g, "/")));
  const rel = relative(root, dir).replace(/\\/g, "/");
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new CensusError(
      `docs root ${docsDir} is outside the repository; aborting rather than matching nothing`,
    );
  return rel === "" ? "" : `${rel}/`;
}

function repoTop(runner: Runner): string {
  const top = runner("git", ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || top.stdout.trim() === "")
    throw new CensusError(
      `could not find the repository root: ${top.stderr.trim() || "timed out"}`,
    );
  return top.stdout.trim();
}

function isOpenPr(value: unknown): value is OpenPr {
  if (typeof value !== "object" || value === null) return false;
  const pr = value as Record<string, unknown>;
  return (
    Number.isInteger(pr.number) &&
    Number.isInteger(pr.changedFiles) &&
    (pr.changedFiles as number) >= 0 &&
    Array.isArray(pr.files) &&
    pr.files.every(
      (file: unknown) =>
        typeof file === "object" &&
        file !== null &&
        typeof (file as { path?: unknown }).path === "string",
    )
  );
}

function currentPrNumber(runner: Runner): string {
  const branch = runner("git", ["branch", "--show-current"]);
  if (branch.status !== 0)
    throw new CensusError(
      `could not read the current branch: ${branch.stderr.trim()}`,
    );
  if (branch.stdout.trim() === "") return "";
  const view = runner("gh", [
    "pr",
    "view",
    "--json",
    "number",
    "-q",
    ".number",
  ]);
  if (view.status === 0) return view.stdout.trim();
  if (view.stderr.includes("no pull requests found for branch")) return "";
  throw new CensusError(
    `could not resolve the current pull request (${view.stderr.trim() || "timed out"}); aborting rather than counting it as another pull request`,
  );
}

export function openPrDocs(
  docsDir: string,
  runner: Runner = run,
  cwd: string = process.cwd(),
): string[] {
  const prefix = docsPrefix(docsDir, repoTop(runner), cwd);
  const current = currentPrNumber(runner);
  const list = runner("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    String(PR_LIST_LIMIT),
    "--json",
    "number,changedFiles,files",
  ]);
  if (list.status !== 0)
    throw new CensusError(
      `could not list open pull requests (${list.stderr.trim() || "timed out"}); aborting rather than scoping blind`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(list.stdout);
  } catch (error) {
    throw new CensusError(
      `could not parse the open pull request list: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!Array.isArray(parsed))
    throw new CensusError(
      "could not parse the open pull request list: not a list",
    );
  const malformed = parsed.findIndex((entry) => !isOpenPr(entry));
  if (malformed !== -1)
    throw new CensusError(
      `open pull request list entry ${malformed} is malformed (${JSON.stringify(parsed[malformed])}); aborting rather than scoping against it`,
    );
  const prs = parsed as OpenPr[];
  if (prs.length >= PR_LIST_LIMIT)
    throw new CensusError(
      `gh returned ${prs.length} open pull requests, the most one query asks for (${PR_LIST_LIMIT}); some may be missing, so aborting rather than scoping against an incomplete census`,
    );
  const others = prs.filter(
    (pr) => current === "" || String(pr.number) !== current,
  );
  const truncated = others.filter((pr) => pr.changedFiles > pr.files.length);
  if (truncated.length > 0)
    throw new CensusError(
      `pull request(s) ${truncated.map((pr) => `#${pr.number}`).join(", ")} change more files than gh returns (100 per pull request); aborting rather than scoping against an incomplete census`,
    );
  return [
    ...new Set(
      others.flatMap((pr) =>
        pr.files
          .map((file) => file.path)
          .filter((path) => path.startsWith(prefix)),
      ),
    ),
  ].sort();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let docsDir = "docs";
  if (args[0] === "--docs-dir" && args[1]) docsDir = args[1];
  else if (args.length > 0) {
    console.error("usage: bun open-pr-docs.ts [--docs-dir <dir>]");
    process.exit(2);
  }
  try {
    const paths = openPrDocs(docsDir);
    for (const path of paths) console.log(path);
    console.error(
      `open-pr-docs: ${paths.length} document(s) under ${docsDir}/ changed by other open pull requests`,
    );
  } catch (error) {
    console.error(
      `open-pr-docs: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 2;
  }
}
