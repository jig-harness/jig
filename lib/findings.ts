import { relative } from "node:path";

/**
 * Gate output a person or an agent can act on (module M1). A gate has three
 * outcomes: passed (exit 0), found violations (exit 1), could not check
 * (exit 2). Each finding names the rule, the place, the problem and the
 * remedy; under GitHub Actions it is also written as an `::error` workflow
 * command, so it appears as an annotation on the changed line.
 */

export interface Finding {
  /** The rule's short name, the same in every finding of that rule. */
  rule: string;
  /** Path relative to the repository root, with forward slashes. */
  file?: string;
  /** 1-based line number in `file`. */
  line?: number;
  /** What is wrong at this place. */
  problem: string;
  /** How to fix it, or the document that says how. */
  remedy: string;
}

type Env = Record<string, string | undefined>;

/** `file:line`, `file`, or `(repository)` when a finding has no file. */
export function location(finding: Finding): string {
  if (!finding.file) return "(repository)";
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}

/** The finding as two log lines: place, rule and problem; then the remedy. */
export function formatFinding(finding: Finding): string {
  return `${location(finding)}: [${finding.rule}] ${finding.problem}\n  fix: ${finding.remedy}`;
}

/** Workflow-command message escaping: `%`, carriage return, line feed. */
function escapeData(text: string): string {
  return text
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

/** Workflow-command property escaping: the message's, plus `:` and `,`. */
function escapeProperty(text: string): string {
  return escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

/** The finding as a GitHub Actions `::error` workflow command. */
export function githubAnnotation(finding: Finding): string {
  const properties = [
    finding.file ? `file=${escapeProperty(finding.file)}` : "",
    finding.file && finding.line ? `line=${finding.line}` : "",
    `title=${escapeProperty(finding.rule)}`,
  ].filter(Boolean);
  return `::error ${properties.join(",")}::${escapeData(`${finding.problem} Fix: ${finding.remedy}`)}`;
}

/** Whether the run is a GitHub Actions job, which reads workflow commands. */
function inGithubActions(env: Env = process.env): boolean {
  return env.GITHUB_ACTIONS === "true";
}

/**
 * Print each finding to stderr and, in a GitHub Actions job, its annotation
 * to stdout, where the runner reads workflow commands.
 */
export function reportFindings(
  findings: Finding[],
  env: Env = process.env,
): void {
  for (const finding of findings) console.error(formatFinding(finding));
  if (inGithubActions(env))
    for (const finding of findings) console.log(githubAnnotation(finding));
}

/**
 * Report that a gate could not decide (its input missing, unreadable or
 * empty, or a command it needs failed) and return exit status 2. The message
 * cannot be read as a finding: the fix is to the input or the environment,
 * not to the code under check.
 */
export function couldNotCheck(
  gate: string,
  reason: string,
  env: Env = process.env,
): number {
  console.error(`${gate}: could not check: ${reason}`);
  if (inGithubActions(env))
    console.log(
      `::error title=${escapeProperty(`${gate}: could not check`)}::${escapeData(reason)}`,
    );
  return 2;
}

/** A path relative to `root`, with forward slashes, for findings. */
export function repoPath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

/** One entry of an exception list, with the reason its group gives. */
export interface ReasonedEntry {
  text: string;
  /** 1-based line number in the list. */
  line: number;
  /** The `#` comment lines that open the entry's group, joined; may be empty. */
  reason: string;
}

/**
 * The entries of a line-based exception list, each with its reason: the `#`
 * comment lines that open its group. A blank line, or a comment after
 * entries, starts a new group. Leading whitespace is ignored.
 */
export function reasonedEntries(content: string): ReasonedEntry[] {
  const entries: ReasonedEntry[] = [];
  let reason: string[] = [];
  let inEntries = false;
  content.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line) {
      reason = [];
      inEntries = false;
    } else if (line.startsWith("#")) {
      if (inEntries) reason = [];
      inEntries = false;
      reason.push(line.replace(/^#+\s*/, ""));
    } else {
      inEntries = true;
      entries.push({
        text: raw.trimStart(),
        line: index + 1,
        reason: reason.join(" ").trim(),
      });
    }
  });
  return entries;
}
