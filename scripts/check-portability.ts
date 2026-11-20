// The portability gate: the hub's portable core runs unchanged on every
// platform an adapter brings it to, a Bun process or a serverless worker
// (ADR-0016, `docs/adr/ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md`;
// design/control-plane.md, "The portable core and its adapters"), so the
// core, and every module it imports, uses nothing one runtime alone gives.
//
// Starting from every TypeScript file under `PORTABLE_ROOTS` (outside
// `__tests__/` and test files) and every module `PORTABLE_SHARED` declares
// portable, the check follows each relative import, `export … from` and
// dynamic `import()` of a literal, and reads every file it reaches, a shared
// module outside the core included, for these rules:
//
// - runtime-module: an import of a `bun:` or `node:` module, of `bun`, or of
//   a Node built-in by its bare name (`fs`, `child_process`, `path`). These
//   are how code runs a subprocess or reads a file, so the rule covers both.
// - package-import: any other import that is not relative, unless
//   `ALLOWED_PACKAGES` names it.
// - runtime-global: a reference to a runtime's own global that needs no
//   import (`Bun`, `process`, `Deno`, `require`, `Buffer`, `__dirname`,
//   `__filename`), bare or through `globalThis`, `self`, `window` or
//   `global`, or an `import.meta` property other than `url` and `resolve`
//   (`import.meta.dir` is Bun's). `Bun.spawn` and `Bun.file` are how code
//   runs a program or reads a file without an import. The global object
//   itself may be read only for a fixed property: aliased, indexed by a
//   value or passed to a function, it could reach any of these unseen.
// - unfollowed-import: a dynamic `import()` of anything but a literal, which
//   the check cannot follow, or a relative import of a file that is neither
//   a script nor JSON (a text or SQL file only a runtime's loader reads).
//
// A type-only import or export (`import type`, `export type … from`) is not
// followed and not checked: its module never runs. An `import { type A }`
// of a module is followed, since the import of the module itself remains.
// A name the file declares itself (a variable, a parameter, an import named
// `process`) is not the runtime's global; the check reads declarations per
// file, not per scope, so such a declaration anywhere in the file hides the
// global for the whole file, which review catches.
//
// A finding names the file, the line, the rule and, for a file the check
// reached through imports, the chain of imports from the root that brought
// it in. Exit 1 on a finding, 2 when it cannot check: a root missing, a file
// unreadable or not parsing, or a relative import that resolves to no file.
import { existsSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import { parseSync } from "oxc-parser";
import { cli } from "../lib/cli.ts";
import { readRegularFile, walk } from "../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  reportFindings,
} from "../lib/findings.ts";

const RULE = "portability";

/** The directories every file of which must be portable. */
export const PORTABLE_ROOTS: readonly string[] = ["plugin/hub/core/"];

/** Shared modules declared portable, checked whether the core imports them yet or not. */
export const PORTABLE_SHARED: readonly string[] = [
  "plugin/shared/outcome.ts",
  "plugin/shared/outbound/budget-governor.ts",
  "plugin/shared/outbound/budget-shape.ts",
  "plugin/shared/outbound/budget-snapshot.ts",
  "plugin/shared/outbound/cache.ts",
  "plugin/shared/outbound/failure.ts",
  "plugin/shared/outbound/gh-route.ts",
  "plugin/shared/outbound/github-answer.ts",
  "plugin/shared/outbound/github-fetch.ts",
  "plugin/shared/outbound/github-refusal.ts",
  "plugin/shared/outbound/github.ts",
  "plugin/shared/outbound/operations.ts",
  "plugin/shared/outbound/paging.ts",
  "plugin/shared/outbound/retry.ts",
];

/** Packages a portable module may import: each one checked to run on every platform first. */
export const ALLOWED_PACKAGES: readonly string[] = [];

/** The globals one runtime gives without an import. */
const RUNTIME_GLOBALS = new Set([
  "Bun",
  "process",
  "Deno",
  "require",
  "Buffer",
  "__dirname",
  "__filename",
]);

/** The names the global object goes by. */
const GLOBAL_OBJECTS = new Set(["globalThis", "self", "window", "global"]);

/** The `import.meta` properties every platform gives. */
const PORTABLE_META = new Set(["url", "resolve"]);

const SCRIPT = /\.(?:[cm]?tsx?|[cm]?js)$/;

const BUILTINS = new Set(["bun", ...builtinModules]);

export interface PortabilityScope {
  roots: readonly string[];
  shared: readonly string[];
  allowed: readonly string[];
}

export interface PortabilityFinding extends Finding {
  /** The files from a root to this one, this one last. */
  chain: string[];
}

type Read =
  | { ok: true; files: string[]; findings: PortabilityFinding[] }
  | { ok: false; reason: string };

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

function nameOf(node: unknown): string | null {
  return isNode(node) && node.type === "Identifier" ? String(node.name) : null;
}

/** A string literal's value, or a template literal's with no expression in it. */
function literalOf(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (node.type === "Literal" && typeof node.value === "string")
    return node.value;
  if (node.type === "TemplateLiteral" && (node.expressions as []).length === 0)
    return String(
      ((node.quasis as AstNode[])[0]?.value as { cooked?: string })?.cooked ??
        "",
    );
  return null;
}

/** A node's children, under the keys that hold them. */
function children(node: AstNode): Array<[string, AstNode]> {
  return Object.entries(node)
    .filter(([key]) => key !== "parent")
    .flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value])
        .filter(isNode)
        .map((child): [string, AstNode] => [key, child]),
    );
}

/** TypeScript nodes that hold a value: only their `expression` runs. */
const TS_VALUE_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TSExportAssignment",
]);

/** The children whose code runs: none of a type, a declaration's `declare` form or a wrapper's type. */
function runtimeChildren(node: AstNode): Array<[string, AstNode]> {
  if (node.type.startsWith("TS")) {
    if (!TS_VALUE_WRAPPERS.has(node.type)) return [];
    return isNode(node.expression) ? [["expression", node.expression]] : [];
  }
  if (node.declare === true) return [];
  return children(node);
}

/** The names a binding pattern declares. */
function patternNames(pattern: unknown, into: Set<string>): void {
  if (!isNode(pattern)) return;
  const name = nameOf(pattern);
  if (name !== null) into.add(name);
  else if (pattern.type === "ObjectPattern")
    for (const property of pattern.properties as AstNode[])
      patternNames(
        property.type === "RestElement" ? property.argument : property.value,
        into,
      );
  else if (pattern.type === "ArrayPattern")
    for (const element of pattern.elements as unknown[])
      patternNames(element, into);
  else if (pattern.type === "AssignmentPattern")
    patternNames(pattern.left, into);
  else if (pattern.type === "RestElement") patternNames(pattern.argument, into);
}

/** Every name the file declares, anywhere in it, outside type-only code. */
function declaredNames(program: AstNode): Set<string> {
  const names = new Set<string>();
  const visit = (node: AstNode) => {
    switch (node.type) {
      case "VariableDeclarator":
        patternNames(node.id, names);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        patternNames(node.id, names);
        for (const param of (node.params as unknown[]) ?? [])
          patternNames(param, names);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        patternNames(node.id, names);
        break;
      case "CatchClause":
        patternNames(node.param, names);
        break;
      case "ImportDeclaration":
        if (node.importKind === "type") return;
        for (const specifier of node.specifiers as AstNode[])
          if (specifier.importKind !== "type")
            patternNames(specifier.local, names);
        return;
    }
    for (const [, child] of runtimeChildren(node)) visit(child);
  };
  visit(program);
  return names;
}

/** One place a file uses what is not portable, before the chain is added. */
interface Use {
  kind: string;
  at: number;
  problem: string;
}

/** A module a file imports at run time, and where. */
interface Edge {
  specifier: string | null;
  at: number;
  dynamic: boolean;
}

/** Whether a reference at `key` of `parent` is a name, not a value: a property, a key, a label. */
function namePosition(parent: AstNode | null, key: string): boolean {
  if (parent === null) return false;
  switch (parent.type) {
    case "MemberExpression":
      return key === "property" && parent.computed !== true;
    case "Property":
    case "PropertyDefinition":
    case "MethodDefinition":
    case "AccessorProperty":
      return key === "key" && parent.computed !== true;
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportSpecifier":
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "MetaProperty":
      return true;
    default:
      return false;
  }
}

/** The runtime-global use a member expression is, if it is one. */
function memberUse(node: AstNode, declared: Set<string>): Use | null {
  const object = node.object;
  const property =
    node.computed === true ? literalOf(node.property) : nameOf(node.property);
  if (property === null || !isNode(object)) return null;
  const holder = nameOf(object);
  if (
    holder !== null &&
    GLOBAL_OBJECTS.has(holder) &&
    !declared.has(holder) &&
    RUNTIME_GLOBALS.has(property)
  )
    return {
      kind: "runtime-global",
      at: node.start,
      problem: `\`${holder}.${property}\` is a runtime's own global`,
    };
  if (
    object.type === "MetaProperty" &&
    nameOf(object.meta) === "import" &&
    !PORTABLE_META.has(property)
  )
    return {
      kind: "runtime-global",
      at: node.start,
      problem: `\`import.meta.${property}\` is one runtime's, not every platform's`,
    };
  return null;
}

/**
 * The runtime imports a file makes and the runtime globals it uses, or why
 * it does not parse: a tree recovered from errors could hide either.
 */
function readModule(
  source: string,
  file: string,
): { edges: Edge[]; uses: Use[] } | { unparsed: string } {
  const parsed = parseSync(file, source, { sourceType: "module" });
  if (parsed.errors.length > 0)
    return { unparsed: parsed.errors.map((e) => e.message).join("; ") };
  const program = parsed.program as unknown as AstNode;
  const declared = declaredNames(program);
  const edges: Edge[] = [];
  const uses: Use[] = [];
  const visit = (node: AstNode, parent: AstNode | null, key: string) => {
    switch (node.type) {
      case "ImportDeclaration":
        if (node.importKind !== "type")
          edges.push({
            specifier: literalOf(node.source),
            at: node.start,
            dynamic: false,
          });
        return;
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (node.source && node.exportKind !== "type")
          edges.push({
            specifier: literalOf(node.source),
            at: node.start,
            dynamic: false,
          });
        break;
      case "ImportExpression":
        edges.push({
          specifier: literalOf(node.source),
          at: node.start,
          dynamic: true,
        });
        break;
      case "MemberExpression": {
        const use = memberUse(node, declared);
        if (use !== null) uses.push(use);
        break;
      }
      case "Identifier": {
        const name = String(node.name);
        // The global object read for a fixed property is checked as that
        // property; read any other way (aliased, indexed by a value, handed
        // to a function) it could reach a runtime global by any name.
        if (
          GLOBAL_OBJECTS.has(name) &&
          !declared.has(name) &&
          !namePosition(parent, key) &&
          !(
            parent?.type === "MemberExpression" &&
            key === "object" &&
            (parent.computed !== true || literalOf(parent.property) !== null)
          )
        ) {
          uses.push({
            kind: "runtime-global",
            at: node.start,
            problem: `\`${name}\` is read other than for a fixed property, so the runtime globals it can reach are unchecked`,
          });
          return;
        }
        if (
          RUNTIME_GLOBALS.has(name) &&
          !declared.has(name) &&
          !namePosition(parent, key)
        )
          uses.push({
            kind: "runtime-global",
            at: node.start,
            problem: `\`${name}\` is a runtime's own global, used without an import`,
          });
        return;
      }
    }
    for (const [childKey, child] of runtimeChildren(node))
      visit(child, node, childKey);
  };
  visit(program, null, "");
  return { edges, uses };
}

/** The use an import of a module that is not relative is, if any. */
function moduleUse(edge: Edge, allowed: readonly string[]): Use | null {
  const specifier = edge.specifier;
  if (specifier === null)
    return {
      kind: "unfollowed-import",
      at: edge.at,
      problem:
        "a dynamic `import()` of a computed name, which the check cannot follow",
    };
  if (specifier.startsWith(".")) return null;
  if (
    specifier.startsWith("bun:") ||
    specifier.startsWith("node:") ||
    BUILTINS.has(specifier)
  )
    return {
      kind: "runtime-module",
      at: edge.at,
      problem: `imports "${specifier}", a module one runtime gives`,
    };
  const name = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : (specifier.split("/")[0] ?? specifier);
  if (allowed.includes(name)) return null;
  return {
    kind: "package-import",
    at: edge.at,
    problem: `imports the package "${specifier}", which ALLOWED_PACKAGES does not name`,
  };
}

/** The repository path a relative import names, or null when no file is there. */
function resolveImport(
  root: string,
  from: string,
  specifier: string,
): string | null {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (candidate.startsWith("../")) return null;
    const path = join(root, candidate);
    if (existsSync(path) && statSync(path).isFile()) return candidate;
  }
  return null;
}

/** The 1-based line of offset `at` in `source`. */
function lineAt(source: string, at: number): number {
  return source.slice(0, at).split("\n").length;
}

/** Every TypeScript file under the roots, outside tests. */
function rootFiles(root: string, roots: readonly string[]): string[] {
  return roots.flatMap((dir) =>
    walk(join(root, dir))
      .map((name) => posix.join(dir, name.replaceAll("\\", "/")))
      .filter(
        (path) =>
          SCRIPT.test(path) &&
          !path.split("/").includes("__tests__") &&
          !/\.test\.[cm]?tsx?$/.test(path),
      ),
  );
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const REMEDY: Record<string, string> = {
  "runtime-module":
    "reach the platform through a port of the hub's core (plugin/hub/core/ports.ts), whose adapter holds the runtime module",
  "package-import":
    "use a relative, portable module, or add the package to ALLOWED_PACKAGES in scripts/check-portability.ts once it runs on every platform",
  "runtime-global":
    "take what the global gave through a port of the hub's core (plugin/hub/core/ports.ts) or an injected function",
  "unfollowed-import":
    "import a literal path to a script, or pass what the file holds in through a port",
};

/**
 * What the check finds under `root`: every file it read and every use of
 * what is not portable, with the import chain that reached it; or why it
 * could not check.
 */
export function portabilityFindings(
  root: string,
  scope: PortabilityScope,
): Read {
  for (const dir of scope.roots)
    if (!existsSync(join(root, dir)))
      return { ok: false, reason: `no ${dir} under ${root}` };
  for (const file of scope.shared)
    if (!existsSync(join(root, file)))
      return {
        ok: false,
        reason: `${file}, which PORTABLE_SHARED declares portable, is not under ${root}`,
      };
  const queue: string[][] = [
    ...rootFiles(root, scope.roots),
    ...scope.shared,
  ].map((file) => [file]);
  const seen = new Set<string>();
  const findings: PortabilityFinding[] = [];
  while (queue.length > 0) {
    const chain = queue.shift() as string[];
    const file = chain.at(-1) as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith(".json")) continue;
    let source: string;
    try {
      source = readRegularFile(join(root, file));
    } catch (error) {
      return { ok: false, reason: `${file}: ${reason(error)}` };
    }
    const read = readModule(source, file);
    if ("unparsed" in read)
      return { ok: false, reason: `${file}: ${read.unparsed}` };
    const uses = [...read.uses];
    for (const edge of read.edges) {
      const use = moduleUse(edge, scope.allowed);
      if (use !== null) {
        uses.push(use);
        continue;
      }
      const specifier = edge.specifier as string;
      if (!specifier.startsWith(".")) continue;
      const target = resolveImport(root, file, specifier);
      if (target === null)
        return {
          ok: false,
          reason: `${file}:${lineAt(source, edge.at)}: "${specifier}" resolves to no file`,
        };
      if (!SCRIPT.test(target) && !target.endsWith(".json")) {
        uses.push({
          kind: "unfollowed-import",
          at: edge.at,
          problem: `imports "${specifier}", which is no script: only a runtime's loader reads it`,
        });
        continue;
      }
      queue.push([...chain, target]);
    }
    for (const use of uses.sort((a, b) => a.at - b.at)) {
      const via =
        chain.length > 1
          ? `; reached from ${chain.slice(0, -1).join(" → ")}`
          : "";
      findings.push({
        rule: `${RULE}:${use.kind}`,
        file,
        line: lineAt(source, use.at),
        problem: `${use.problem}${via}`,
        remedy: REMEDY[use.kind] as string,
        chain,
      });
    }
  }
  return { ok: true, files: [...seen].sort(), findings };
}

/** The gate: exit 0 when every file reached is portable, 1 on a finding, 2 when it cannot check. */
export function checkPortability(
  root = ".",
  scope: Partial<PortabilityScope> = {},
): number {
  const read = portabilityFindings(root, {
    roots: scope.roots ?? PORTABLE_ROOTS,
    shared: scope.shared ?? PORTABLE_SHARED,
    allowed: scope.allowed ?? ALLOWED_PACKAGES,
  });
  if (!read.ok) return couldNotCheck(RULE, read.reason);
  if (read.findings.length > 0) {
    reportFindings(read.findings);
    return 1;
  }
  console.log(
    `${RULE}: OK — ${read.files.length} files from ${(scope.roots ?? PORTABLE_ROOTS).join(" and ")} and the shared modules declared portable; no runtime module, package or runtime global`,
  );
  return 0;
}

if (import.meta.main) cli(() => checkPortability(process.argv[2]));
