// Neutral example: TODO comments need an issue or a justified suppression.
//
// Exit 0: every TODO in the text files under the scan root cites an issue or
// carries a justified `todo-exempt: <reason>`. Exit 1: findings, each with its
// rule, file and line, problem and fix: a bare TODO, a suppression without a
// reason, or a suppression that suppresses nothing (on a line with no TODO, or
// beside a TODO that already cites an issue). Exit 2: could not check, because
// the scan root is missing or holds no text file, so a run that examined
// nothing never passes. Under GitHub Actions each finding is also printed as
// an `::error` annotation.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../../../../lib/cli.ts";
import { walk } from "../../../../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  repoPath,
  reportFindings,
} from "../../../../lib/findings.ts";

const RULE = "todo-has-issue";
const ISSUE = /TODO\((#[0-9]+|[A-Za-z][A-Za-z0-9]*-[0-9]+)\)/g;
const TODO = /TODO/g;
const TOKEN = /todo-exempt:/g;
const REASONED = /todo-exempt:\s*\S/;
const CITE =
  "cite an issue, as TODO(#123) or TODO(PROJ-123), or add `todo-exempt: <reason>` on the same line (see the suppression registry)";

const count = (text: string, pattern: RegExp) =>
  text.match(pattern)?.length ?? 0;

/**
 * The finding on one line of a scanned file. Each TODO counts on its own: a
 * TODO citing an issue does not discharge another TODO beside it, so one
 * suppression is live exactly when the line holds a TODO that cites none.
 * Whole issue-citing markers are blanked before the remaining TODOs are
 * counted, so a TODO inside an issue key (`TODO(MYTODO-123)`) is not a second
 * TODO, and the text on either side of a marker cannot join into a new one.
 */
function lineFinding(
  file: string,
  line: number,
  text: string,
): Finding | undefined {
  const todos = count(text, TODO);
  const bare = count(
    text.replace(ISSUE, (cited) => " ".repeat(cited.length)),
    TODO,
  );
  const tokens = count(text, TOKEN);
  const stale = (problem: string): Finding => ({
    rule: RULE,
    file,
    line,
    problem,
    remedy: "delete the stale suppression",
  });
  if (tokens && !bare)
    return stale(
      todos
        ? "`todo-exempt:` beside TODOs that all cite an issue suppresses nothing"
        : "`todo-exempt:` on a line with no TODO suppresses nothing",
    );
  if (tokens > 1)
    return stale(
      "a second `todo-exempt:` on one line suppresses nothing: one covers the line",
    );
  if (!bare || REASONED.test(text)) return undefined;
  return {
    rule: RULE,
    file,
    line,
    problem: tokens
      ? "`todo-exempt:` without a reason does not suppress"
      : "TODO without an issue reference",
    remedy: CITE,
  };
}

export function checkTodo(
  root = process.env.SRC_DIR || "src",
  env: Record<string, string | undefined> = process.env,
): number {
  if (!existsSync(root) || !statSync(root).isDirectory())
    return couldNotCheck(
      RULE,
      `scan root ${root} is not a directory; set SRC_DIR to the folder to scan`,
      env,
    );
  let scanned = 0;
  const findings: Finding[] = [];
  for (const name of walk(root, [".git"])) {
    const content = readFileSync(join(root, name));
    if (content.includes(0)) continue;
    scanned++;
    // Relative to the working directory, the repository root in CI, so an
    // annotation lands on the right file even for an absolute SRC_DIR.
    const file = repoPath(process.cwd(), join(root, name));
    content
      .toString()
      .split("\n")
      .forEach((text, index) => {
        const finding = lineFinding(file, index + 1, text);
        if (finding) findings.push(finding);
      });
  }
  if (scanned === 0)
    return couldNotCheck(
      RULE,
      `no text file under ${root} to scan; point SRC_DIR at the source folder`,
      env,
    );
  if (findings.length) {
    reportFindings(findings, env);
    console.error(
      `${RULE}: ${findings.length} finding(s) in ${scanned} text file(s) under ${root}`,
    );
    return 1;
  }
  console.log(
    `OK — ${RULE}: ${scanned} text file(s) under ${root}, every TODO cites an issue or carries a justified todo-exempt. Checks the text "TODO" only, not other markers such as FIXME; binary files are skipped.`,
  );
  return 0;
}
if (import.meta.main) cli(() => checkTodo());
