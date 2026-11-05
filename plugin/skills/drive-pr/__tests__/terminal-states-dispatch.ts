/**
 * The dispatcher's part of the terminal-state drift check: the plugin files
 * outside drive-pr that classify `drive.ts`'s exits read them from
 * `scripts/lib/status/terminal-states.ts` (`DRIVE_EXIT` and the sets beside
 * it) and never restate one as a number, and the exit codes their prose
 * pairs with a state name are the codes the table gives that state.
 *
 * A file in `DISPATCH_FILES` fails the check when:
 *
 * - it names `importsRegistry` and imports nothing from `terminal-states.ts`;
 * - a numeric literal that is one of `drive.ts`'s exits stands where an exit
 *   is classified: an element of the array a `new Set(...)` is built from, the
 *   key of an entry of the array a `new Map(...)` is built from, a numeric
 *   property name of an object literal, a `case` of a `switch` on an `exit` or
 *   a `code`, or one side of an equality whose other side is an `exit` or a
 *   `code` (a property or variable of that name). A local identifier is read
 *   through to its literal initializer the way the driver's own check reads
 *   it (`resolveLiteral`). An equality against a `code` does not count `0`,
 *   `1` or `2`, which every process exits with and these files compare
 *   helper processes' results against; one against an `exit` counts them;
 * - its text pairs a state with a code the way the ledger classifier's table
 *   does, `` `STATE` (`n` ``, and `n` is not the exit `drive.ts` ends with for
 *   that state.
 *
 * What it does not see: an exit code built by arithmetic or passed through a
 * function, an exported constant's own literal initializer, and a literal in
 * any other position. Those stay review's to catch.
 */
import { existsSync, readFileSync } from "node:fs";
import { delimiter, relative, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import {
  DRIVE_EXIT,
  TERMINAL_STATES,
} from "../scripts/lib/status/terminal-states.ts";
import type {
  createSingleFileProgram,
  FileChecker,
  resolveLiteral,
} from "./terminal-states-consistency.ts";

const PLUGIN_ROOT = resolve(import.meta.dir, "..", "..", "..");

export interface DispatchFile {
  /** From the plugin directory. */
  readonly path: string;
  /** Whether it must read the registry: false only for a `shared/` module, which may not import a skill. */
  readonly importsRegistry: boolean;
}

/** The plugin files outside drive-pr that classify a drive's exit, or did. */
export const DISPATCH_FILES: readonly DispatchFile[] = [
  { path: "dispatch/run.ts", importsRegistry: true },
  { path: "dispatch/lib/launches.ts", importsRegistry: true },
  { path: "dispatch/lib/actions/drive-hold.ts", importsRegistry: true },
  { path: "dispatch/lib/log.ts", importsRegistry: true },
  { path: "dispatch/lib/sources/ledgers.ts", importsRegistry: true },
  { path: "shared/orca-tabs.ts", importsRegistry: false },
];

/** Every exit `drive.ts` ends with. */
const DRIVE_EXIT_CODES: ReadonlySet<number> = new Set(
  Object.values(DRIVE_EXIT),
);

/** The codes every process exits with, which an equality against a `code` does not count. */
const GENERIC_CODES: ReadonlySet<number> = new Set([0, 1, 2]);

/**
 * The driver check's TypeScript program and literal resolution, handed in by
 * `runCheck` (and the tests) rather than imported, so the two modules do not
 * import each other.
 */
export interface AstTools {
  readonly program: typeof createSingleFileProgram;
  readonly resolveLiteral: typeof resolveLiteral;
}

export interface DispatchFinding {
  readonly line: number;
  readonly what: string;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

/** `exit` or `code` when `expr` is a property or a variable of that name, else `null`. */
function exitOperand(expr: ts.Expression): "exit" | "code" | null {
  const name = ts.isPropertyAccessExpression(expr)
    ? expr.name.text
    : ts.isIdentifier(expr)
      ? expr.text
      : null;
  return name === "exit" || name === "code" ? name : null;
}

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** The drive exit `expr` restates, when it resolves to one of `codes`. */
function restated(
  expr: ts.Expression,
  checker: FileChecker,
  codes: ReadonlySet<number>,
  tools: AstTools,
): number | null {
  const literal = tools.resolveLiteral(expr, checker);
  if (literal === undefined) return null;
  const value = Number(literal.text);
  return codes.has(value) ? value : null;
}

/** The codes an equality against an operand named `name` counts. */
function codesFor(name: "exit" | "code"): ReadonlySet<number> {
  return name === "exit"
    ? DRIVE_EXIT_CODES
    : new Set([...DRIVE_EXIT_CODES].filter((c) => !GENERIC_CODES.has(c)));
}

/** The array a `new Set(...)` or `new Map(...)` is built from, with which it is. */
function collectionSource(
  node: ts.Node,
): { kind: "Set" | "Map"; elements: readonly ts.Expression[] } | null {
  if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression))
    return null;
  const kind = node.expression.text;
  const first = node.arguments?.[0];
  if ((kind !== "Set" && kind !== "Map") || first === undefined) return null;
  return ts.isArrayLiteralExpression(first)
    ? { kind, elements: first.elements }
    : null;
}

/** The restated exits one node of the tree carries, by the positions the header names. */
function nodeFindings(
  node: ts.Node,
  checker: FileChecker,
  tools: AstTools,
): Array<{ at: ts.Node; value: number; where: string }> {
  const found: Array<{ at: ts.Node; value: number; where: string }> = [];
  const note = (
    at: ts.Expression,
    codes: ReadonlySet<number>,
    where: string,
  ) => {
    const value = restated(at, checker, codes, tools);
    if (value !== null) found.push({ at, value, where });
  };
  if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
    for (const [side, other] of [
      [node.left, node.right],
      [node.right, node.left],
    ] as const) {
      const name = exitOperand(side);
      if (name !== null)
        note(other, codesFor(name), `compared with \`${name}\``);
    }
  }
  const collection = collectionSource(node);
  if (collection !== null)
    for (const element of collection.elements) {
      const key =
        collection.kind === "Set"
          ? element
          : ts.isArrayLiteralExpression(element)
            ? element.elements[0]
            : undefined;
      if (key !== undefined)
        note(key, DRIVE_EXIT_CODES, `in a new ${collection.kind}`);
    }
  if (
    ts.isPropertyAssignment(node) &&
    ts.isNumericLiteral(node.name) &&
    DRIVE_EXIT_CODES.has(Number(node.name.text))
  )
    found.push({
      at: node.name,
      value: Number(node.name.text),
      where: "as an object key",
    });
  if (ts.isCaseClause(node) && ts.isSwitchStatement(node.parent.parent)) {
    const name = exitOperand(node.parent.parent.expression);
    if (name !== null)
      note(node.expression, codesFor(name), `as a case of \`${name}\``);
  }
  return found;
}

/** The drive exits `source` restates as numbers. */
export async function findDispatchExitLiterals(
  source: string,
  fileName: string,
  tools: AstTools,
): Promise<DispatchFinding[]> {
  const { checker, sourceFile } = await tools.program(fileName, source);
  const findings: DispatchFinding[] = [];
  const visit = (node: ts.Node): void => {
    for (const { at, value, where } of nodeFindings(node, checker, tools))
      findings.push({
        line: lineOf(sourceFile, at),
        what: `exit ${value} ${where}: name it from DRIVE_EXIT instead`,
      });
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return findings;
}

const IMPORT = /\bfrom\s+["'][^"']*\/terminal-states\.ts["']/;

/** Whether `source` imports from drive-pr's terminal-state registry. */
export function importsRegistry(source: string): boolean {
  return IMPORT.test(source);
}

const INLINE_PAIR = /`([A-Z][A-Z0-9_]*)` \(`(\d{1,2})`/g;

/** The `` `STATE` (`n` `` pairs in `text` whose code is not the exit `drive.ts` ends with for that state. */
export function findInlinePairMismatches(text: string): DispatchFinding[] {
  const findings: DispatchFinding[] = [];
  for (const [index, line] of text.split("\n").entries())
    for (const [, state = "", code = ""] of line.matchAll(INLINE_PAIR)) {
      const entry = TERMINAL_STATES[state];
      const valid =
        entry === undefined
          ? []
          : (entry.additionalExitCodes ?? [entry.exitCode]);
      if (!valid.includes(Number(code)))
        findings.push({
          line: index + 1,
          what:
            entry === undefined
              ? `\`${state}\` (\`${code}\`) names no state in TERMINAL_STATES`
              : `\`${state}\` (\`${code}\`): drive.ts exits ${valid.join(" or ")} for it`,
        });
    }
  return findings;
}

/** The files to check: `DISPATCH_FILES`, or the test seam's `path=imports|shared` list. */
function filesToCheck(): Array<{ path: string; importsRegistry: boolean }> {
  const seam = process.env.DRIVE_PR_TERMINAL_STATES_TEST_DISPATCH_FILES;
  if (seam === undefined)
    return DISPATCH_FILES.map((f) => ({
      path: resolve(PLUGIN_ROOT, f.path),
      importsRegistry: f.importsRegistry,
    }));
  return seam
    .split(delimiter)
    .filter((entry) => entry !== "")
    .map((entry) => {
      const at = entry.lastIndexOf("=");
      return {
        path: entry.slice(0, at),
        importsRegistry: entry.slice(at + 1) === "imports",
      };
    });
}

/** The dispatcher's part of `runCheck`: 0 when every file reads the registry, else 1 with what drifted. */
export async function checkDispatchFiles(tools: AstTools): Promise<number> {
  const problems: string[] = [];
  const files = filesToCheck();
  for (const file of files) {
    const shown = relative(PLUGIN_ROOT, file.path);
    if (!existsSync(file.path)) {
      problems.push(
        `${shown}: missing — a file that moved leaves DISPATCH_FILES stale`,
      );
      continue;
    }
    const source = readFileSync(file.path, "utf8");
    if (file.importsRegistry && !importsRegistry(source))
      problems.push(
        `${shown}: imports nothing from drive-pr's terminal-states.ts`,
      );
    for (const f of [
      ...(await findDispatchExitLiterals(source, file.path, tools)),
      ...findInlinePairMismatches(source),
    ])
      problems.push(`${shown}:${f.line}  ${f.what}`);
  }
  if (problems.length === 0) return 0;
  console.error(
    "A dispatcher file restates a drive exit instead of reading it from drive-pr's terminal-state registry:\n",
  );
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nRead the exit by name (DRIVE_EXIT, DRIVER_REFUSAL_EXITS, PERSON_STOP_EXITS,",
  );
  console.error(
    "driveExitClosesTab in skills/drive-pr/scripts/lib/status/terminal-states.ts).",
  );
  return 1;
}

/** How many dispatcher files the check read, for `runCheck`'s summary. */
export function dispatchFileCount(): number {
  return filesToCheck().length;
}
