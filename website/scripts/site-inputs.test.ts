import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { convertToTsx } from "@astrojs/astro2tsx";
import ts from "typescript";
import { repoFiles } from "../../lib/files.ts";
import {
  CATALOG,
  type Catalog,
  readCatalog,
  resolveAreas,
} from "../../scripts/change-areas.ts";

const root = resolve(import.meta.dir, "../..");
const SITE = "website/src/lib/site.ts";
const CONTENT_CONFIG = "website/src/content.config.ts";

/** A file the bundler runs as code, in any of the formats it loads. */
const CODE = /\.[cm]?[jt]sx?$/;

/**
 * The site's sources as TypeScript, by repository path: a code file as it
 * is, an Astro component as the TSX `astro check` type-checks (its
 * frontmatter and its template), and each of its `<script>` blocks.
 */
function siteSources(files: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, text] of files) {
    if (CODE.test(path)) out.set(path, text);
    if (!path.endsWith(".astro")) continue;
    const tsx = convertToTsx(text, {
      filename: path.split("/").pop(),
      ambientTypes: true,
    });
    if (tsx.hasParseErrors)
      throw new Error(`${path}: ${tsx.diagnostics.map((d) => d.message)}`);
    out.set(`${path}.tsx`, tsx.code);
    tsx.scripts.forEach((s, i) => {
      out.set(`${path}.script-${i}.ts`, s.content);
    });
  }
  return out;
}

/** The relative import specifiers of each source, by the source's path. */
function relativeImports(sources: Map<string, string>): [string, string][] {
  const found: [string, string][] = [];
  for (const [path, code] of sources)
    for (const i of new Bun.Transpiler({
      loader: path.endsWith("x") ? "tsx" : "ts",
    }).scanImports(code))
      if (i.path.startsWith(".")) found.push([path, i.path]);
  return found;
}

/**
 * A program over in-memory sources, for its parser and type checker. Its
 * file names are POSIX paths from `/` on every platform, the form TypeScript
 * passes to the host's callbacks. It checks strictly, so a type that may be
 * `undefined` or `null` says so rather than reading as only its strings.
 */
function program(sources: Map<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
    noLib: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const byAbs = new Map([...sources].map(([p, c]) => [abs(p), c]));
  host.fileExists = (f) => byAbs.has(f);
  host.directoryExists = (d) => {
    const dir = d.endsWith("/") ? d : `${d}/`;
    return [...byAbs.keys()].some((f) => f.startsWith(dir));
  };
  host.getDirectories = () => [];
  host.realpath = (f) => f;
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (f) => f;
  host.readFile = (f) => byAbs.get(f);
  host.getSourceFile = (f, lang) => {
    const text = byAbs.get(f);
    return text === undefined
      ? undefined
      : ts.createSourceFile(f, text, lang, true);
  };
  host.getCurrentDirectory = () => "/";
  return ts.createProgram([...byAbs.keys()], options, host);
}

/** A repository path as the program's file name, and back. */
const abs = (p: string) => posix.resolve("/", p);
const repoPath = (sf: ts.SourceFile) =>
  posix
    .relative("/", sf.fileName)
    .replace(/\.astro\.(tsx|script-\d+\.ts)$/, ".astro");

/**
 * What tracing a path expression needs: the checker, every identifier by the
 * symbol it is bound to, and the expressions being traced, so a cycle stops.
 */
interface Trace {
  checker: ts.TypeChecker;
  refs: Map<ts.Symbol, ts.Identifier[]>;
  stack: Set<ts.Node>;
}

function trace(prog: ts.Program): Trace {
  const checker = prog.getTypeChecker();
  const refs = new Map<ts.Symbol, ts.Identifier[]>();
  const index = (node: ts.Node) => {
    const sym = ts.isIdentifier(node) && boundSymbol(checker, node);
    if (sym) refs.set(sym, [...(refs.get(sym) ?? []), node as ts.Identifier]);
    ts.forEachChild(node, index);
  };
  for (const sf of prog.getSourceFiles()) index(sf);
  return { checker, refs, stack: new Set() };
}

/** The symbol an identifier uses, through imports; none for an import's own name. */
function boundSymbol(checker: ts.TypeChecker, node: ts.Identifier) {
  const p = node.parent;
  if (
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isImportClause(p)
  )
    return undefined;
  const sym = checker.getSymbolAtLocation(node);
  return sym && sym.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(sym)
    : sym;
}

/** Every identifier bound to a declaration's symbol, its own name excepted. */
function referencesTo(t: Trace, name: ts.Identifier): ts.Identifier[] {
  const sym = t.checker.getSymbolAtLocation(name);
  return (sym && t.refs.get(sym)?.filter((r) => r !== name)) ?? [];
}

/** Every list's values together, or null when any is null or there are none. */
function all(lists: (string[] | null)[]): string[] | null {
  return lists.length && lists.every((v) => v)
    ? (lists as string[][]).flat()
    : null;
}

/**
 * The values a path expression can have, traced through the program's
 * syntax: a string, both branches of a conditional or a `||`/`??` fallback, a
 * template whose substitutions all have known values (every combination of
 * them, which can only add paths), a `const` bound to one, a function's
 * parameter through what every call of the function passes it, and an Astro
 * component's prop through the attribute every use of the component gives
 * it. A type assertion is looked through to the value it asserts about. The
 * checker only binds names: a type, which an assertion or a narrowing can
 * make claim any string, is never read as a value. Null when any of those
 * cannot be established: a function used other than by calling it, a
 * component given its props by a spread, a value only the run knows.
 */
function pathValues(t: Trace, node: ts.Expression): string[] | null {
  if (t.stack.has(node)) return null;
  t.stack.add(node);
  try {
    return syntaxValues(t, node) ?? valuesOf(t, node);
  } finally {
    t.stack.delete(node);
  }
}

/** The expressions whose value at run time is their operand's. */
const TRANSPARENT = new Set([
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.TypeAssertionExpression,
]);

const FALLBACKS = new Set([
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

/** A string's value, or the values of what a value is chosen from; else null. */
function syntaxValues(t: Trace, node: ts.Expression): string[] | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return [node.text];
  if (TRANSPARENT.has(node.kind))
    return pathValues(t, (node as ts.ParenthesizedExpression).expression);
  if (ts.isConditionalExpression(node))
    return all([pathValues(t, node.whenTrue), pathValues(t, node.whenFalse)]);
  return ts.isBinaryExpression(node) && FALLBACKS.has(node.operatorToken.kind)
    ? all([pathValues(t, node.left), pathValues(t, node.right)])
    : null;
}

function valuesOf(t: Trace, node: ts.Expression): string[] | null {
  if (ts.isTemplateExpression(node)) return templateValues(t, node);
  if (ts.isPropertyAccessExpression(node) && isAstroProps(node.expression))
    return propValues(t, node, node.name.text);
  return ts.isIdentifier(node) ? identifierValues(t, node) : null;
}

const isAstroProps = (node: ts.Node) => node.getText() === "Astro.props";

/** The nodes an assignment's target can sit inside and still be written. */
const TARGET_PARTS = new Set([
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.TypeAssertionExpression,
  ts.SyntaxKind.ArrayLiteralExpression,
  ts.SyntaxKind.ObjectLiteralExpression,
  ts.SyntaxKind.SpreadElement,
  ts.SyntaxKind.SpreadAssignment,
  ts.SyntaxKind.ShorthandPropertyAssignment,
]);

const isAssignment = (k: ts.SyntaxKind) =>
  k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;

const UPDATES = new Set([
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
]);

/**
 * Whether an expression is written to: assigned, updated, deleted, or the
 * target of a destructuring assignment or a `for … in`/`of` loop. These are
 * every operator JavaScript has that changes what a reference holds.
 */
function isWritten(node: ts.Node): boolean {
  const p = node.parent;
  if (
    TARGET_PARTS.has(p.kind) ||
    (ts.isPropertyAssignment(p) && p.initializer === node)
  )
    return isWritten(p);
  if (ts.isBinaryExpression(p))
    return p.left === node && isAssignment(p.operatorToken.kind);
  if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p))
    return UPDATES.has(p.operator);
  return ts.isDeleteExpression(p) || isLoopTarget(p, node);
}

const isLoopTarget = (loop: ts.Node, node: ts.Node) =>
  (ts.isForInStatement(loop) || ts.isForOfStatement(loop)) &&
  loop.initializer === node;

/**
 * Whether a component's props are only read, and only given by the tags that
 * use it: each `Astro` is a member read other than `Astro.self` (which
 * renders the component with props of its own), and each `Astro.props` is
 * destructured into a declaration or has a prop read from it. So no alias of
 * either object, no write, and no function given the object, can change what
 * a prop holds.
 */
function propsOnlyRead(sf: ts.SourceFile): boolean {
  let ok = true;
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === "Astro" &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
    )
      ok &&= isAstroRead(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return ok;
}

function isAstroRead(astro: ts.Identifier): boolean {
  const use = astro.parent;
  if (
    !ts.isPropertyAccessExpression(use) ||
    use.expression !== astro ||
    use.name.text === "self"
  )
    return false;
  const p = use.parent;
  return (
    use.name.text !== "props" ||
    (ts.isVariableDeclaration(p) &&
      p.initializer === use &&
      ts.isObjectBindingPattern(p.name)) ||
    (ts.isPropertyAccessExpression(p) && p.expression === use && !isWritten(p))
  );
}

function templateValues(t: Trace, node: ts.TemplateExpression) {
  let out = [node.head.text];
  for (const span of node.templateSpans) {
    const parts = pathValues(t, span.expression);
    if (!parts) return null;
    out = out.flatMap((o) => parts.map((v) => o + v + span.literal.text));
  }
  return out;
}

/**
 * A name's values, from its declaration. A name written after it is bound (a
 * `let`, a parameter, a destructured prop) may not hold its initial value at
 * the read, so it has none.
 */
function identifierValues(t: Trace, node: ts.Identifier) {
  const sym = boundSymbol(t.checker, node);
  const decl = sym?.valueDeclaration;
  if (!decl || t.refs.get(sym)?.some(isWritten)) return null;
  if (ts.isParameter(decl)) return parameterValues(t, decl);
  if (ts.isBindingElement(decl)) return propBindingValues(t, decl);
  return ts.isVariableDeclaration(decl) ? constValues(t, decl) : null;
}

/** A `const` name's values: its initializer's. */
function constValues(t: Trace, decl: ts.VariableDeclaration) {
  const isConst = ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const;
  return isConst && ts.isIdentifier(decl.name) && decl.initializer
    ? pathValues(t, decl.initializer)
    : null;
}

/** A prop bound by `const { prop } = Astro.props`. */
function propBindingValues(t: Trace, decl: ts.BindingElement) {
  const owner = decl.parent.parent;
  const prop = decl.propertyName ?? decl.name;
  const fromProps =
    !decl.dotDotDotToken &&
    ts.isVariableDeclaration(owner) &&
    owner.initializer !== undefined &&
    isAstroProps(owner.initializer);
  return fromProps && (ts.isIdentifier(prop) || ts.isStringLiteral(prop))
    ? propValues(t, decl, prop.text)
    : null;
}

/** A parameter's values: what every call of its function passes it. */
function parameterValues(t: Trace, param: ts.ParameterDeclaration) {
  const fn = param.parent;
  const owner = fn.parent;
  const name = ts.isFunctionDeclaration(fn)
    ? fn.name
    : ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)
      ? owner.name
      : undefined;
  if (!name || param.dotDotDotToken || !ts.isIdentifier(param.name))
    return null;
  const at = fn.parameters.indexOf(param);
  return all(
    referencesTo(t, name).map((ref) => {
      const call = ref.parent;
      if (!isPlainCall(call, ref)) return null;
      const arg = call.arguments[at] ?? param.initializer;
      return arg ? pathValues(t, arg) : null;
    }),
  );
}

/** An Astro prop's values: the attribute every use of the component gives it. */
function propValues(t: Trace, node: ts.Node, prop: string) {
  const sf = node.getSourceFile();
  if (!propsOnlyRead(sf)) return null;
  const component = sf.statements.find(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) &&
      (ts.getCombinedModifierFlags(s) & ts.ModifierFlags.ExportDefault) ===
        ts.ModifierFlags.ExportDefault,
  );
  if (!component?.name) return null;
  return all(
    referencesTo(t, component.name)
      .filter((ref) => !passesNothing(ref))
      .map((ref) => {
        const el = ref.parent;
        const isTag =
          (ts.isJsxSelfClosingElement(el) || ts.isJsxOpeningElement(el)) &&
          el.tagName === ref;
        return isTag ? attributeValues(t, el.attributes, prop) : null;
      }),
  );
}

/** A reference in a type or a closing tag, which passes nothing at run time. */
const passesNothing = (ref: ts.Identifier) =>
  ts.isTypeQueryNode(ref.parent) || ts.isJsxClosingElement(ref.parent);

/** `ref(...)` with no spread, so each argument's position is its parameter's. */
function isPlainCall(
  call: ts.Node,
  ref: ts.Identifier,
): call is ts.CallExpression {
  return (
    ts.isCallExpression(call) &&
    call.expression === ref &&
    !call.arguments.some(ts.isSpreadElement)
  );
}

function attributeValues(t: Trace, attrs: ts.JsxAttributes, prop: string) {
  if (attrs.properties.some(ts.isJsxSpreadAttribute)) return null;
  const init = attrs.properties.find(
    (a): a is ts.JsxAttribute =>
      ts.isJsxAttribute(a) && a.name.getText() === prop,
  )?.initializer;
  if (init && ts.isStringLiteral(init)) return [init.text];
  return init && ts.isJsxExpression(init) && init.expression
    ? pathValues(t, init.expression)
    : null;
}

/** The first argument of a call of `ref`; none when `ref` is not plainly called. */
function callArgument(ref: ts.Identifier): ts.Expression | undefined {
  const call = ref.parent;
  return isPlainCall(call, ref) ? call.arguments[0] : undefined;
}

/** The name of the site's `read()` declaration, if the program has one. */
function readFunctionName(prog: ts.Program): ts.Identifier | undefined {
  return prog
    .getSourceFile(abs(SITE))
    ?.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === "read",
    )?.name;
}

/**
 * Every path the site's sources pass to the site's `read()`, found by the
 * type checker: each reference to that function, under any name it is
 * imported as, with its argument traced to the values it can have. An
 * argument only the run can build (a directory listing, a module's
 * directory) must be declared, by its file and its text, with the files it
 * can read as a glob; `undeclared` lists the rest, and every reference that
 * is not a call, so the test fails rather than skipping them, and `unused`
 * the declarations no read matched.
 */
function siteReads(
  sources: Map<string, string>,
  declared: Record<string, string> = {},
): { paths: string[]; globs: string[]; unparsed: string[]; unused: string[] } {
  const prog = program(sources);
  const t = trace(prog);
  const readName = readFunctionName(prog);
  const paths: string[] = [];
  const globs: string[] = [];
  const unparsed = readName ? [] : [`no read() in ${SITE}`];
  const used = new Set<string>();
  for (const ref of readName ? referencesTo(t, readName) : []) {
    const at = `${repoPath(ref.getSourceFile())}: `;
    const arg = callArgument(ref);
    const found = arg && pathValues(t, arg);
    const key = arg ? at + arg.getText() : "";
    if (found) paths.push(...found);
    else if (key in declared) {
      used.add(key);
      globs.push(declared[key] as string);
    } else unparsed.push(at + ref.parent.getText());
  }
  return {
    paths,
    globs,
    unparsed,
    unused: Object.keys(declared).filter((k) => !used.has(k)),
  };
}

/**
 * The entries of the content collection's one `pattern: [...]`; an entry
 * that is not a string of known values is reported.
 */
function collectionPatterns(sources: Map<string, string>): {
  patterns: string[];
  unparsed: string[];
} {
  const prog = program(sources);
  const t = trace(prog);
  const lists: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "pattern"
    )
      lists.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  const config = prog.getSourceFile(abs(CONTENT_CONFIG));
  if (config) visit(config);
  const list = lists[0];
  if (lists.length !== 1 || !list || !ts.isArrayLiteralExpression(list))
    return { patterns: [], unparsed: [`${lists.length} pattern arrays`] };
  const patterns: string[] = [];
  const unparsed: string[] = [];
  for (const el of list.elements) {
    const values = pathValues(t, el);
    if (values) patterns.push(...values);
    else unparsed.push(el.getText());
  }
  return { patterns, unparsed };
}

const siteTs = `export function read(path: string): string { return path; }`;
const reads = (
  files: Record<string, string>,
  declared: Record<string, string> = {},
) =>
  siteReads(
    siteSources(new Map(Object.entries({ [SITE]: siteTs, ...files }))),
    declared,
  );

test("the site's reads are found by binding, whatever the spelling, name or layout", () => {
  const found = reads({
    "website/src/lib/a.ts": [
      `import { read, read as loadDoc } from "./site.ts";`,
      `const A = 'a.md';`,
      `// read("commented.md") and an explanatory read() are not calls`,
      `read ("b.md"); loadDoc('c.md'); read( \`d.md\` );`,
      `read(\n  "e.md", /* "f.md" */\n);`,
      `read(A); read("\\u0052EADME.md");`,
      `function g(dir: string, name = "x.md") {`,
      `  read(\`\${dir}/\${name}\`);`,
      `  const A = "shadowed.md"; read(A);`,
      `}`,
      `g("docs"); g("guides", "y.md");`,
      `const pick = (x: boolean) => read(x ? "y.md" : "z.md");`,
      `export const doc = (path: string) => read(path);`,
      `function opt(p = "given.md") { return read(p || "fallback.md"); } opt();`,
      `read(("asserted.md" as string) as "README.md");`,
      `export const SHARED = "shared.md";`,
    ].join("\n"),
    "website/src/lib/b.ts": `import { doc, SHARED } from "./a.ts";\nimport { read } from "./site.ts";\ndoc("CONTRIBUTING.md"); read(SHARED);`,
    "website/src/components/P.astro": `---\nimport { read } from "../lib/site.ts";\nconst { from, alt: other } = Astro.props;\nconst FROM = "p.md";\nconst text = read(from) + read(FROM) + read(other) + read(Astro.props.extra);\n---\n<p>{read("markup.md")}</p>`,
    "website/src/pages/q.astro": `---\nimport P from "../components/P.astro";\n---\n<P from="q.md" alt={"r.md"} extra="s.md" /><P from={\`t.md\`} alt="u.md" extra="v.md"></P>`,
    "website/src/lib/c.js": `import { read } from "./site.ts";\nread("js.md");`,
    "website/src/lib/d.mjs": `import { read } from "./site.ts";\nread("mjs.md");`,
    "website/src/lib/e.tsx": `import { read } from "./site.ts";\nexport const E = () => <p>{read("tsx.md")}</p>;`,
  });
  expect(found.unparsed).toEqual([]);
  expect(found.paths.sort()).toEqual(
    [
      "a.md",
      "b.md",
      "c.md",
      "d.md",
      "e.md",
      "README.md",
      "docs/x.md",
      "docs/y.md",
      "guides/x.md",
      "guides/y.md",
      "shadowed.md",
      "y.md",
      "z.md",
      "CONTRIBUTING.md",
      "q.md",
      "t.md",
      "p.md",
      "r.md",
      "u.md",
      "s.md",
      "v.md",
      "markup.md",
      "js.md",
      "mjs.md",
      "tsx.md",
      "given.md",
      "fallback.md",
      "asserted.md",
      "shared.md",
    ].sort(),
  );
});

test("a read the checker cannot trace is reported unless declared, and a declaration no read uses is reported", () => {
  const found = reads(
    {
      "website/src/lib/a.ts": [
        `import { read } from "./site.ts";`,
        `let M = "a.md"; M = "design/plan.md"; read(M);`,
        `read("a" + String(1)); read(f(1)); ["x.md"].map(read);`,
        `function f(n: number): string { return String(n); }`,
        `function uncalled(p: string) { return read(p); }`,
        `function passed(p: string) { return read(p); } ["y.md"].forEach(passed);`,
        `function mixed(p: string) { return read(p); } mixed("ok.md"); mixed(String(2));`,
        `read(\`dir/\${f(3)}\`);`,
        `function load(_i: string, p = "README.md") { return read(p); } load(...(["i", "design/plan.md"] as const));`,
        `read(...(["x.md"] as const));`,
        `function bare(p?: "README.md") { return read(p); } bare();`,
        `function set(p: string) { p = "design/plan.md"; return read(p); } set("README.md");`,
        `function grow(p: string) { p += ".md"; return read(p); } grow("design/plan");`,
        `function bump(p: string) { [p] = ["design/plan.md"]; return read(p); } bump("README.md");`,
        `function opt(p?: "given.md") { return read(p || "fallback.md"); } opt();`,
        `let q: "README.md" | "design/plan.md" = "README.md"; function change() { q = "design/plan.md"; } change(); read(q);`,
      ].join("\n"),
      "website/src/components/P.astro": `---\nimport { read } from "../lib/site.ts";\nconst { from } = Astro.props;\nread(from);\n---`,
      "website/src/pages/q.astro": `---\nimport P from "../components/P.astro";\nconst rest = { from: "q.md" };\n---\n<P {...rest} />`,
      "website/src/components/R.astro": `---\nimport { read } from "../lib/site.ts";\nread(Astro.props.from);\n---`,
      "website/src/pages/r.astro": `---\nimport R from "../components/R.astro";\nconst Other = R;\n---\n<R from="ok.md" /><Other from="design/plan.md" />`,
      "website/src/components/S.astro": `---\nimport { read } from "../lib/site.ts";\nlet { from } = Astro.props;\nfrom = "design/plan.md";\nread(from);\n---`,
      "website/src/components/T.astro": `---\nimport { read } from "../lib/site.ts";\nAstro.props.from = "design/plan.md";\nread(Astro.props.from);\n---`,
      "website/src/components/U.astro": `---\nimport { read } from "../lib/site.ts";\nObject.assign(Astro.props, { from: "design/plan.md" });\nread(Astro.props.from);\n---`,
      "website/src/components/V.astro": `---\nimport { read } from "../lib/site.ts";\nconst props = Astro.props;\nprops.from = "design/plan.md";\nread(Astro.props.from);\n---`,
      "website/src/components/W.astro": `---\nimport { read } from "../lib/site.ts";\nread(Astro.props.from);\n---\n<Astro.self from="design/plan.md" />`,
      "website/src/components/X.astro": `---\nimport { read } from "../lib/site.ts";\nconst A = Astro;\nA.props.from = "design/plan.md";\nread(Astro.props.from);\n---`,
      "website/src/components/Y.astro": `---\nimport { read } from "../lib/site.ts";\ndelete Astro.props.from;\nconst { from = "design/plan.md" } = Astro.props;\nread(from);\n---`,
      "website/src/pages/s.astro": `---\nimport S from "../components/S.astro";\nimport T from "../components/T.astro";\nimport U from "../components/U.astro";\nimport V from "../components/V.astro";\nimport W from "../components/W.astro";\nimport X from "../components/X.astro";\nimport Y from "../components/Y.astro";\n---\n<S from="ok.md" /><T from="ok.md" /><U from="ok.md" /><V from="ok.md" /><W from="ok.md" /><X from="ok.md" /><Y from="ok.md" />`,
    },
    {
      "website/src/lib/a.ts: `dir/${f(3)}`": "dir/*.md",
      "website/src/lib/a.ts: gone": "gone/*.md",
    },
  );
  expect(found.unparsed).toEqual([
    "website/src/lib/a.ts: read(M)",
    'website/src/lib/a.ts: read("a" + String(1))',
    "website/src/lib/a.ts: read(f(1))",
    'website/src/lib/a.ts: ["x.md"].map(read)',
    "website/src/lib/a.ts: read(p)",
    "website/src/lib/a.ts: read(p)",
    "website/src/lib/a.ts: read(p)",
    "website/src/lib/a.ts: read(p)",
    'website/src/lib/a.ts: read(...(["x.md"] as const))',
    "website/src/lib/a.ts: read(p)",
    "website/src/lib/a.ts: read(p)",
    "website/src/lib/a.ts: read(p)",
    "website/src/lib/a.ts: read(p)",
    'website/src/lib/a.ts: read(p || "fallback.md")',
    "website/src/lib/a.ts: read(q)",
    "website/src/components/P.astro: read(from)",
    "website/src/components/R.astro: read(Astro.props.from)",
    "website/src/components/S.astro: read(from)",
    "website/src/components/T.astro: read(Astro.props.from)",
    "website/src/components/U.astro: read(Astro.props.from)",
    "website/src/components/V.astro: read(Astro.props.from)",
    "website/src/components/W.astro: read(Astro.props.from)",
    "website/src/components/X.astro: read(Astro.props.from)",
    "website/src/components/Y.astro: read(from)",
  ]);
  expect(found.globs).toEqual(["dir/*.md"]);
  expect(found.unused).toEqual(["website/src/lib/a.ts: gone"]);
});

test("the content collection's patterns are read as the parser reads them", () => {
  const patterns = (config: string) =>
    collectionPatterns(new Map([[CONTENT_CONFIG, config]]));
  expect(
    patterns(
      `export const c = { pattern: [\n  "a.md", 'b/*.md', // "design/*.md",\n  /* "x.md", */ \`c.md\`, "modules/M[0-9]*/README.md",\n] };`,
    ),
  ).toEqual({
    patterns: ["a.md", "b/*.md", "c.md", "modules/M[0-9]*/README.md"],
    unparsed: [],
  });
  expect(
    patterns(
      `declare const more: string[]; const c = { pattern: ["a.md", ...more] };`,
    ).unparsed,
  ).toEqual(["...more"]);
});

// What the website's build reads from outside website/ must select the
// website, or a change to it skips the build it can break. Derived from the
// build itself where it can be: the code its scripts, its Astro components
// and the audit renderer import (Bun's bundler follows every static import
// from there), the content collection's globs, and each path the site's code
// passes to `read()`, traced to its values. A path only the run can build
// is declared in RUN_TIME_READS, with the files it can read.
/**
 * The site's reads whose path only the run knows (a directory listing, a
 * module's directory), by the file and the argument as written, each with
 * the files it can read as a glob.
 */
const RUN_TIME_READS: Record<string, string> = {
  "website/src/lib/data/index.ts: `${m.dir}/README.md`": "modules/M*/README.md",
  "website/src/lib/data/index.ts: `${moduleMeta(id).dir}/mappings.md`":
    "modules/M*/mappings.md",
  "website/src/lib/data/index.ts: `${CRITERIA_DIR}/${f}`":
    "plugin/skills/audit/criteria/*.yaml",
  "website/src/lib/data/index.ts: `principles/${f}`": "principles/*.md",
  "website/src/lib/data/index.ts: `tools/${name}/README.md`":
    "tools/*/README.md",
  "website/src/pages/modules/[id]/mappings.astro: from":
    "modules/M*/mappings.md",
};

/**
 * The files the site's code reads: the paths its reads trace to, and every
 * file a declared run-time read's glob matches.
 */
function readPaths(files: string[], sources: Map<string, string>) {
  const { paths, globs, unparsed, unused } = siteReads(sources, RUN_TIME_READS);
  expect(unparsed).toEqual([]);
  expect(unused).toEqual([]);
  expect(paths).toContain("plugin/skills/audit/profiles.yaml");
  expect(paths).toContain("plugin/EXTENDING.md");
  const globbed = globs.map((g) =>
    files.filter((f) => new Bun.Glob(g).match(f)),
  );
  expect(globs.filter((_, i) => globbed[i]?.length === 0)).toEqual([]);
  return { paths, globbed: globbed.flat() };
}

const RESOLVE_AS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js"];

/**
 * The file a relative import names, as the bundler resolves it: the path as
 * written, with a code extension, or a directory's index. Undefined when no
 * tracked file matches.
 */
function resolveImport(
  files: Set<string>,
  from: string,
  spec: string,
): string | undefined {
  const target = posix.join(posix.dirname(from), spec);
  return RESOLVE_AS.map((s) => target + s).find((f) => files.has(f));
}

/**
 * What the site's Astro components import: code, which joins the bundle's
 * entrypoints, the other files they read as they are, and the imports that
 * resolve to no tracked file or to a component outside website/src, which
 * nothing here would analyse.
 */
function astroImports(files: Set<string>, sources: Map<string, string>) {
  const code: string[] = [];
  const read: string[] = [];
  const unresolved: string[] = [];
  for (const [path, spec] of relativeImports(sources)) {
    if (!/\.astro\.(tsx|script-\d+\.ts)$/.test(path)) continue;
    const from = path.replace(/\.(tsx|script-\d+\.ts)$/, "");
    const target = resolveImport(files, from, spec);
    if (
      !target ||
      (target.endsWith(".astro") && !target.startsWith("website/src/"))
    )
      unresolved.push(`${from}: ${spec}`);
    else (CODE.test(target) ? code : read).push(target);
  }
  return { code, read, unresolved };
}

test("an Astro import resolves to a tracked file as the bundler would, or is reported", () => {
  const files = new Set([
    "website/src/lib/a.ts",
    "website/src/lib/dir/index.ts",
    "website/src/styles/s.css",
    "plugin/x/y.ts",
    "plugin/x/C.astro",
  ]);
  const page = (imports: string[]) =>
    siteSources(
      new Map([
        [
          "website/src/pages/p.astro",
          `---\n${imports.map((i) => `import "${i}";`).join("\n")}\n---`,
        ],
      ]),
    );
  expect(
    astroImports(
      files,
      page([
        "../lib/a",
        "../lib/a.ts",
        "../lib/dir",
        "../../../plugin/x/y",
        "../styles/s.css",
        "../lib/missing",
        "../../../plugin/x/C.astro",
      ]),
    ),
  ).toEqual({
    code: [
      "website/src/lib/a.ts",
      "website/src/lib/a.ts",
      "website/src/lib/dir/index.ts",
      "plugin/x/y.ts",
    ],
    read: ["website/src/styles/s.css"],
    unresolved: [
      "website/src/pages/p.astro: ../lib/missing",
      "website/src/pages/p.astro: ../../../plugin/x/C.astro",
    ],
  });
});

/**
 * Everything the website's build runs or reads as code: the files Bun's
 * bundler reaches from every script under website/ (its configuration
 * included), from what the Astro components import and from the audit
 * renderer, and the sources the read analysis covers, which are all of
 * those that are code, so a helper anywhere in the closure has its reads
 * traced.
 */
async function buildClosure(files: string[]) {
  const tracked = new Set(files);
  const text = (f: string) => readFileSync(join(root, f), "utf8");
  const site = files.filter(
    (f) => /^website\/src\/.*\.(ts|astro)$/.test(f) && !f.endsWith(".test.ts"),
  );
  const astro = astroImports(
    tracked,
    siteSources(new Map(site.map((f) => [f, text(f)]))),
  );
  const entries = files.filter(
    (f) => /^website\/.*\.ts$/.test(f) && !f.endsWith(".test.ts"),
  );
  entries.push("plugin/skills/audit/scripts/report.ts", ...astro.code);
  const build = await Bun.build({
    entrypoints: [...new Set(entries)].map((f) => join(root, f)),
    target: "bun",
    metafile: true,
    packages: "external",
    external: ["astro:*", "*.css"],
  });
  const imported = Object.keys(build.metafile?.inputs ?? {}).map((f) =>
    relative(root, resolve(process.cwd(), f)).replaceAll("\\", "/"),
  );
  const analysed = [...new Set([...site, ...imported])].filter(
    (f) => tracked.has(f) && (CODE.test(f) || f.endsWith(".astro")),
  );
  const sources = siteSources(new Map(analysed.map((f) => [f, text(f)])));
  return { entries, imported, astro, sources };
}

test("Jig's catalog selects the website for every file the site's build reads", async () => {
  const jig = (readCatalog(join(root, CATALOG)) as { areas: Catalog }).areas;
  const files = repoFiles(root);
  const { entries, imported, astro, sources } = await buildClosure(files);
  expect(astro.unresolved).toEqual([]);
  expect(entries).toContain("website/astro.config.ts");
  expect(entries).toContain("website/src/lib/data/index.ts");
  expect(entries).toContain("website/src/scripts/specimen.ts");
  expect(imported).toContain("plugin/skills/audit/scripts/report.ts");
  expect(sources.has("plugin/skills/audit/scripts/report.ts")).toBe(true);
  const { patterns, unparsed: unparsedPatterns } = collectionPatterns(sources);
  expect(unparsedPatterns).toEqual([]);
  expect(patterns).toContain("plugin/skills/*/SKILL.md");
  const collected = files.filter((f) =>
    patterns.some((p) => new Bun.Glob(p).match(f)),
  );
  const { paths, globbed } = readPaths(files, sources);
  const read = [
    ...new Set([
      ...imported,
      ...astro.read,
      ...collected,
      ...paths,
      ...globbed,
    ]),
  ].filter((f) => !f.startsWith("website/") && !f.includes("node_modules/"));
  expect(
    read.filter((f) => !resolveAreas([f], jig).areas.includes("website")),
  ).toEqual([]);
  // And what the site does not read leaves the website out.
  for (const file of [
    "changes/some-change.md",
    "design/plan.md",
    "plugin/skills/drive-pr/scripts/drive.ts",
    "plugin/skills/drive-pr/__tests__/drive.test.ts",
    "scripts/check-md-links.ts",
  ])
    expect(resolveAreas([file], jig).areas).not.toContain("website");
});
