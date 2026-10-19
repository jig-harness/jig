// The plugin reaches the issue tracker only through the tracker interface:
// the adapters in `plugin/skills/do-item/scripts/lib/tracker/`, called
// through the `Tracker` port or `do-item/scripts/tracker.ts`. Anything else
// that calls Linear directly is code a second tracker's adapter cannot reach.
//
// "Directly" means a token only a direct call uses: Linear's API host, its
// SDK package, the name prefix of a Linear MCP server's tools, or a run of
// the `linear` command-line client (an argument list or a spawn that starts
// with `linear`, or a command line `linear <subcommand>`). The file is matched
// as a whole, so an argument list or a spawn split over several lines is
// found like one written on a single line; a command line stays on one line.
//
// Scope: every code file (TypeScript, JavaScript, shell, Python) under
// `plugin/` outside the adapters' directory, and every file of the planning
// skills (`file-issue`, `work-batch`), whose procedures must name the
// interface's commands rather than a tracker's tools. Tests (`__tests__/`) are out of scope: the plugin ships without
// them, and they exercise the adapters through fakes. The other skills'
// `SKILL.md` files and references are out of scope for now: they name the
// Linear MCP tools as the harness's own fallback for the operations their
// scripts do not cover.
//
// The allow list (`tracker-boundary-allow.txt` beside this script) names a
// file that still bypasses the interface, one path per line under `#` lines
// giving the reason. An entry without a reason, or one whose file no longer
// reaches Linear directly, is itself a finding, so the list only shrinks.
//
// Exit 1 on a finding, 2 when it cannot check: no `plugin/` directory, the
// allow list missing, or a file in scope unreadable.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { readRegularFile, repoFiles } from "../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  type ReasonedEntry,
  reasonedEntries,
  reportFindings,
} from "../lib/findings.ts";

const RULE = "tracker-boundary";
const ALLOW_RULE = "tracker-boundary-allowlist";
const ALLOW_FILE = "scripts/tracker-boundary-allow.txt";

/** The adapters' directory: the one place that may reach Linear directly. */
export const ADAPTERS = "plugin/skills/do-item/scripts/lib/tracker/";

/** The skills whose every file is checked, documents included. */
export const PLANNING_SKILLS = [
  "plugin/skills/file-issue/",
  "plugin/skills/work-batch/",
];

/** Code in any language the plugin's scripts are written in. */
const CODE = /\.(?:[cm]?ts|[cm]?js|sh|bash|py)$/;

/** The tokens only a direct call to Linear uses, each with what it names. */
export const TOKENS: { what: string; pattern: RegExp }[] = [
  { what: "Linear's API host", pattern: /api\.linear\.app/i },
  { what: "Linear's SDK package", pattern: /@linear\/sdk/ },
  // An MCP tool's name is `mcp__<server>__<tool>`, and the server's name is
  // whatever the harness or the plugin that registered it chose
  // (`mcp__linear__…`, `mcp__claude_ai_Linear__…`), so any server segment
  // naming Linear counts.
  {
    what: "a Linear MCP tool",
    pattern: /mcp__(?:(?!__)[\w-])*linear(?:(?!__)[\w-])*__/i,
  },
  {
    what: "a run of the `linear` command-line client",
    pattern:
      /\[\s*["'`]linear["'`]\s*,|\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*["'`]linear\b|(?<![\w./-])linear[ \t]+(?:api|auth|config|issues?|teams?|projects?|labels?|cycles?|comments?|documents?|milestones?|initiatives?)\b/,
  },
];

/** Whether the boundary applies to a repository path. */
export function inScope(path: string): boolean {
  if (!path.startsWith("plugin/") || path.startsWith(ADAPTERS)) return false;
  if (path.split("/").includes("__tests__")) return false;
  return CODE.test(path) || PLANNING_SKILLS.some((p) => path.startsWith(p));
}

/**
 * Every place in a file that holds a token, one finding per token and line;
 * a construct over several lines is reported at the line it starts on.
 */
export function violations(path: string, text: string): Finding[] {
  const findings: { line: number; order: number; finding: Finding }[] = [];
  TOKENS.forEach((token, order) => {
    const lines = new Set<number>();
    for (const match of text.matchAll(
      new RegExp(token.pattern, `${token.pattern.flags}g`),
    )) {
      const line = text.slice(0, match.index).split("\n").length;
      if (lines.has(line)) continue;
      lines.add(line);
      findings.push({
        line,
        order,
        finding: {
          rule: RULE,
          file: path,
          line,
          problem: `names ${token.what}, reaching Linear outside the tracker interface`,
          remedy: `go through the Tracker port or do-item/scripts/tracker.ts (add the operation to ${ADAPTERS}port.ts and its adapters if it is missing); a procedure names the interface's command, not a tracker's tool`,
        },
      });
    }
  });
  return findings
    .sort((a, b) => a.line - b.line || a.order - b.order)
    .map((f) => f.finding);
}

/**
 * The findings left once the allow list is applied, and the allow list's
 * own findings: an entry without a reason, repeated, or allowing a file that
 * no longer reaches Linear directly.
 */
export function applyAllowList(
  found: Finding[],
  allow: ReasonedEntry[],
  allowFile = ALLOW_FILE,
): Finding[] {
  const allowed = new Set<string>();
  const own: Finding[] = [];
  for (const entry of allow) {
    const path = entry.text.trim();
    const at = { rule: ALLOW_RULE, file: allowFile, line: entry.line };
    if (allowed.has(path)) {
      own.push({
        ...at,
        problem: `${path} is listed twice`,
        remedy: "remove the repeated entry",
      });
      continue;
    }
    allowed.add(path);
    if (!entry.reason)
      own.push({
        ...at,
        problem: `${path} is allowed without a reason`,
        remedy:
          "put a `#` line above it saying why the file still bypasses the tracker interface and which open work moves it",
      });
    if (!found.some((f) => f.file === path))
      own.push({
        ...at,
        problem: `${path} no longer reaches Linear directly (or is out of the boundary's scope)`,
        remedy: "remove the entry: the list only shrinks",
      });
  }
  return [
    ...found.filter((f) => f.file === undefined || !allowed.has(f.file)),
    ...own,
  ];
}

export function checkTrackerBoundary(root = "."): number {
  if (
    !existsSync(join(root, "plugin")) ||
    !statSync(join(root, "plugin")).isDirectory()
  )
    return couldNotCheck(RULE, `no plugin/ directory under ${root}`);
  if (!existsSync(join(root, ALLOW_FILE)))
    return couldNotCheck(RULE, `${ALLOW_FILE} is missing under ${root}`);
  const reason = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  let allow: ReasonedEntry[];
  let paths: string[];
  try {
    allow = reasonedEntries(readRegularFile(join(root, ALLOW_FILE)));
    paths = repoFiles(root).filter(inScope);
  } catch (error) {
    return couldNotCheck(RULE, reason(error));
  }
  const found: Finding[] = [];
  let checked = 0;
  for (const path of paths) {
    let text: string;
    try {
      text = readRegularFile(join(root, path));
    } catch (error) {
      return couldNotCheck(RULE, `${path}: ${reason(error)}`);
    }
    found.push(...violations(path, text));
    checked++;
  }
  if (checked === 0)
    return couldNotCheck(
      RULE,
      `no file under plugin/ is in scope under ${root}`,
    );
  const findings = applyAllowList(found, allow);
  if (findings.length) {
    reportFindings(findings);
    return 1;
  }
  console.log(
    `${RULE}: OK — ${checked} plugin files reach Linear only through ${ADAPTERS}, apart from the ${allow.length} allowed`,
  );
  return 0;
}
if (import.meta.main) cli(() => checkTrackerBoundary(process.argv[2]));
