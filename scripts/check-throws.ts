// Failures are values, and a throw is a defect (ADR-0012,
// `docs/adr/ADR-0012-failures-as-values.md`). In the dispatcher
// (`plugin/dispatch/`) and resource collection (`plugin/gc/`), code that can
// fail in a way its caller handles returns an `Outcome`
// (`plugin/shared/outcome.ts`), so the only throws left are these three:
//
// - `throw new Defect(…)`: a bug or a broken invariant, which the boundary
//   around the work it stops reports with its stack;
// - `throw new ExitError(USAGE_EXIT, …)`: a command line the command refuses,
//   exit 2, which the command-line boundary turns into the exit;
// - a rethrow: `throw <name>` inside a `catch (<name>)` clause, which passes
//   on what something else threw, a defect or a platform error the code
//   there does not handle, rather than starting a failure of its own.
//
// Any other `throw` is a finding. The check reads each file's syntax tree,
// so a `throw` in a comment or a string is not one; it does not follow
// values, so `throw` of a variable holding a `Defect` is a finding as any
// other value is, and a call that throws on the code's behalf (`fail` in
// `plugin/shared/cli.ts`) is not seen.
//
// Scope: every TypeScript file under `plugin/dispatch/` and `plugin/gc/`,
// outside `__tests__/` and `vendor/`.
//
// Exit 1 on a finding, 2 when it cannot check: neither directory there, or
// a file in scope unreadable or not TypeScript that parses.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import { cli } from "../lib/cli.ts";
import { readRegularFile, repoFiles } from "../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  reportFindings,
} from "../lib/findings.ts";

const RULE = "throws";
const REMEDY =
  "return an Outcome (plugin/shared/outcome.ts) for a failure the caller handles, throw a Defect for a bug, or throw new ExitError(USAGE_EXIT, …) for a refused command line (docs/adr/ADR-0012-failures-as-values.md)";

/** The directories under the rule. */
export const SCOPE = ["plugin/dispatch/", "plugin/gc/"];

/** Whether the check reads a repository path. */
export function inScope(path: string): boolean {
  if (!SCOPE.some((dir) => path.startsWith(dir))) return false;
  if (!/\.[cm]?tsx?$/.test(path)) return false;
  const parts = path.split("/");
  return !parts.includes("__tests__") && !parts.includes("vendor");
}

/** One `throw` the rule does not allow: where it is, and its text. */
export interface ThrowSite {
  line: number;
  text: string;
}

/** What the oxc tree holds that the walk reads. */
interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function identifierName(node: unknown): string | null {
  return isNode(node) && node.type === "Identifier" ? String(node.name) : null;
}

/** Whether `argument`, thrown inside catch clauses binding `caught`, is one of the allowed forms. */
function allowed(argument: AstNode, caught: readonly string[]): boolean {
  const name = identifierName(argument);
  if (name !== null) return caught.includes(name);
  if (argument.type !== "NewExpression") return false;
  const callee = identifierName(argument.callee);
  if (callee === "Defect") return true;
  const args = argument.arguments as unknown[];
  return callee === "ExitError" && identifierName(args[0]) === "USAGE_EXIT";
}

/**
 * Every `throw` in `source` the rule does not allow, in source order.
 * Throws when the source does not parse: a tree recovered from errors
 * could hide one.
 */
export function throwSites(source: string, file = "source.ts"): ThrowSite[] {
  const parsed = parseSync(file.endsWith(".tsx") ? file : "source.ts", source, {
    sourceType: "module",
  });
  if (parsed.errors.length > 0)
    throw new Error(parsed.errors.map((e) => e.message).join("; "));
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++)
    if (source[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset)
      line++;
    return line + 1;
  };
  const sites: ThrowSite[] = [];
  const walk = (node: AstNode, caught: readonly string[]) => {
    if (node.type === "ThrowStatement" && isNode(node.argument)) {
      if (!allowed(node.argument, caught))
        sites.push({
          line: lineOf(node.start),
          text: source.slice(node.start, node.end).split("\n")[0]!.trim(),
        });
    }
    if (node.type === "CatchClause") {
      const param = identifierName(node.param);
      const inner = param === null ? caught : [...caught, param];
      if (isNode(node.body)) walk(node.body, inner);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent") continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) walk(item, caught);
      } else if (isNode(value)) walk(value, caught);
    }
  };
  walk(parsed.program as unknown as AstNode, []);
  return sites;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function checkThrows(root = "."): number {
  if (!SCOPE.some((dir) => existsSync(join(root, dir))))
    return couldNotCheck(RULE, `no ${SCOPE.join(" or ")} under ${root}`);
  const paths = repoFiles(root).filter(
    (path) =>
      inScope(path) &&
      existsSync(join(root, path)) &&
      statSync(join(root, path)).isFile(),
  );
  const found: Finding[] = [];
  for (const path of paths) {
    let sites: ThrowSite[];
    try {
      sites = throwSites(readRegularFile(join(root, path)), path);
    } catch (error) {
      return couldNotCheck(RULE, `${path}: ${reason(error)}`);
    }
    for (const site of sites)
      found.push({
        rule: RULE,
        file: path,
        line: site.line,
        problem: `\`${site.text}\` is neither a defect, the usage exit nor a rethrow`,
        remedy: REMEDY,
      });
  }
  if (found.length > 0) {
    reportFindings(found);
    return 1;
  }
  console.log(
    `${RULE}: OK — ${paths.length} files under ${SCOPE.join(" and ")}; every throw is a defect, the usage exit or a rethrow`,
  );
  return 0;
}

if (import.meta.main) cli(() => checkThrows(process.argv[2]));
