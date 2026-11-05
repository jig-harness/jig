/**
 * The dispatcher's part of the terminal-state drift check: the plugin files
 * outside drive-pr that classify `drive.ts`'s exits read them from
 * `scripts/lib/status/terminal-states.ts` (`DRIVE_EXIT` and the sets beside
 * it) and never restate one as a number, and the exit codes their prose,
 * and the plugin README's table of outcome classes (`DISPATCH_PROSE`), pair
 * with a state name are the codes the table gives that state.
 *
 * A file in `DISPATCH_FILES` fails the check when:
 *
 * - it names `importsRegistry` and binds no runtime value from `terminal-states.ts`;
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
import { delimiter, dirname, relative, resolve } from "node:path";
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
  { path: "dispatch/lib/log-ended.ts", importsRegistry: true },
  { path: "dispatch/lib/labels.ts", importsRegistry: true },
  { path: "dispatch/lib/contention.ts", importsRegistry: true },
  { path: "shared/orca-tabs.ts", importsRegistry: false },
];

/** Prose about the dispatcher that pairs a drive state with its exit, checked by `findInlinePairMismatches` alone. */
const DISPATCH_PROSE: readonly string[] = ["README.md"];

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

/** `expr` without the parentheses around it. */
function unparenthesized(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** The name a property access or a literal bracket access reads, else `null`. */
function accessedName(expr: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isElementAccessExpression(expr)) {
    const key = unparenthesized(expr.argumentExpression);
    return ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)
      ? key.text
      : null;
  }
  return ts.isIdentifier(expr) ? expr.text : null;
}

/** `exit` or `code` when `expr` is a property or a variable of that name, else `null`. */
function exitOperand(operand: ts.Expression): "exit" | "code" | null {
  const expr = unparenthesized(operand);
  const name = accessedName(expr);
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
  const argument = node.arguments?.[0];
  if ((kind !== "Set" && kind !== "Map") || argument === undefined) return null;
  const first = unparenthesized(argument);
  return ts.isArrayLiteralExpression(first)
    ? { kind, elements: first.elements }
    : null;
}

/** A restated exit one node of the tree carries. */
interface NodeFinding {
  at: ts.Node;
  value: number;
  where: string;
}

/** Record `at` as a finding when it resolves to one of `codes`. */
type Note = (
  at: ts.Expression,
  codes: ReadonlySet<number>,
  where: string,
) => void;

/** An equality whose one side is an `exit` or a `code`. */
function noteEquality(node: ts.Node, note: Note): void {
  if (!ts.isBinaryExpression(node) || !EQUALITY.has(node.operatorToken.kind))
    return;
  for (const [side, other] of [
    [node.left, node.right],
    [node.right, node.left],
  ] as const) {
    const name = exitOperand(side);
    if (name !== null) note(other, codesFor(name), `compared with \`${name}\``);
  }
}

/** The elements of a `new Set(...)`, the keys of a `new Map(...)`. */
function noteCollection(node: ts.Node, note: Note): void {
  const collection = collectionSource(node);
  if (collection === null) return;
  for (const element of collection.elements) {
    const key =
      collection.kind === "Set"
        ? element
        : ts.isArrayLiteralExpression(unparenthesized(element))
          ? (unparenthesized(element) as ts.ArrayLiteralExpression).elements[0]
          : undefined;
    if (key !== undefined)
      note(key, DRIVE_EXIT_CODES, `in a new ${collection.kind}`);
  }
}

/** A `case` of a `switch` on an `exit` or a `code`. */
function noteCase(node: ts.Node, note: Note): void {
  if (!ts.isCaseClause(node) || !ts.isSwitchStatement(node.parent.parent))
    return;
  const name = exitOperand(node.parent.parent.expression);
  if (name !== null)
    note(node.expression, codesFor(name), `as a case of \`${name}\``);
}

/** A numeric property name of an object literal that is a drive exit. */
function objectKey(node: ts.Node): NodeFinding | null {
  if (!ts.isPropertyAssignment(node)) return null;
  const key = ts.isComputedPropertyName(node.name)
    ? unparenthesized(node.name.expression)
    : node.name;
  if (!ts.isNumericLiteral(key)) return null;
  const value = Number(key.text);
  return DRIVE_EXIT_CODES.has(value)
    ? { at: key, value, where: "as an object key" }
    : null;
}

/** The restated exits one node of the tree carries, by the positions the header names. */
function nodeFindings(
  node: ts.Node,
  checker: FileChecker,
  tools: AstTools,
): NodeFinding[] {
  const found: NodeFinding[] = [];
  const note: Note = (at, codes, where) => {
    const value = restated(at, checker, codes, tools);
    if (value !== null) found.push({ at, value, where });
  };
  noteEquality(node, note);
  noteCollection(node, note);
  noteCase(node, note);
  const key = objectKey(node);
  if (key !== null) found.push(key);
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

/** The registry this check reads, which a dispatcher file's import must resolve to. */
const REGISTRY_PATH = resolve(
  PLUGIN_ROOT,
  "skills/drive-pr/scripts/lib/status/terminal-states.ts",
);

/** Whether `clause` binds at least one runtime value: a default or namespace import, or a named one not marked `type`. */
function bindsValue(clause: ts.ImportClause): boolean {
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return false;
  const named = clause.namedBindings;
  if (clause.name !== undefined || (named && ts.isNamespaceImport(named)))
    return true;
  return (
    named !== undefined &&
    ts.isNamedImports(named) &&
    named.elements.some((element) => !element.isTypeOnly)
  );
}

/**
 * Whether `source`, at absolute path `fileName`, has an import declaration
 * that binds a runtime value from drive-pr's terminal-state registry; a
 * comment or a string naming it, a type-only import and an import of another
 * `terminal-states.ts` do not count.
 */
export async function importsRegistry(
  source: string,
  fileName: string,
  tools: AstTools,
): Promise<boolean> {
  const { sourceFile } = await tools.program(fileName, source);
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.importClause !== undefined &&
      bindsValue(statement.importClause) &&
      resolve(dirname(fileName), statement.moduleSpecifier.text) ===
        REGISTRY_PATH,
  );
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

/** What drifted in the plugin README's outcome classes, unless a test names its own files. */
function proseProblems(): string[] {
  if (process.env.DRIVE_PR_TERMINAL_STATES_TEST_DISPATCH_FILES !== undefined)
    return [];
  return DISPATCH_PROSE.flatMap((doc) =>
    findInlinePairMismatches(
      readFileSync(resolve(PLUGIN_ROOT, doc), "utf8"),
    ).map((f) => `${doc}:${f.line}  ${f.what}`),
  );
}

/** What drifted in one dispatcher file. */
async function fileProblems(
  file: { path: string; importsRegistry: boolean },
  tools: AstTools,
): Promise<string[]> {
  const shown = relative(PLUGIN_ROOT, file.path);
  if (!existsSync(file.path))
    return [
      `${shown}: missing — a file that moved leaves DISPATCH_FILES stale`,
    ];
  const source = readFileSync(file.path, "utf8");
  const unread =
    file.importsRegistry && !(await importsRegistry(source, file.path, tools))
      ? [`${shown}: imports nothing from drive-pr's terminal-states.ts`]
      : [];
  const restatements = [
    ...(await findDispatchExitLiterals(source, file.path, tools)),
    ...findInlinePairMismatches(source),
  ].map((f) => `${shown}:${f.line}  ${f.what}`);
  return [...unread, ...restatements];
}

/** The dispatcher's part of `runCheck`: 0 when every file reads the registry, else 1 with what drifted. */
export async function checkDispatchFiles(tools: AstTools): Promise<number> {
  const problems = proseProblems();
  for (const file of filesToCheck())
    problems.push(...(await fileProblems(file, tools)));
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
