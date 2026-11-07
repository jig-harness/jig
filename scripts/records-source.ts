import {
  parseSync,
  Visitor,
  type Node,
  type Expression,
  type TemplateLiteral,
} from "oxc-parser";

/** Literal text and the original source line for each character. */
export interface SqlSource {
  text: string;
  lines: number[];
  /** An unknown tag may transform the literal; its declarations cannot certify names. */
  uncertain?: boolean;
}

/** Source syntax the registry gate cannot safely inspect. */
class SourceParseError extends SyntaxError {
  readonly code = "RECORDS_SOURCE_PARSE";
}

/** Static property spelling, without evaluating a computed expression. */
function rawTag(tag: Expression): boolean {
  if (
    tag.type !== "MemberExpression" ||
    tag.object.type !== "Identifier" ||
    tag.object.name !== "String"
  )
    return false;
  if (!tag.computed)
    return tag.property.type === "Identifier" && tag.property.name === "raw";
  if (tag.property.type === "Literal" && typeof tag.property.value === "string")
    return tag.property.value === "raw";
  return (
    tag.property.type === "TemplateLiteral" &&
    tag.property.expressions.length === 0 &&
    tag.property.quasis[0]?.value.cooked === "raw"
  );
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  f: "\f",
  b: "\b",
  "0": "\0",
};

function escapeValue(raw: string): string {
  const code = raw.slice(1);
  if (/^[ux]/.test(code)) {
    const digits = code.startsWith("u{") ? code.slice(2, -1) : code.slice(1);
    const point = Number.parseInt(digits, 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : raw;
  }
  if (code === "\n" || code === "\r\n" || code === "\r") return "";
  return ESCAPES[code] ?? code;
}

/** Decode only parser-delimited literal contents, retaining each character's line. */
function append(
  sql: SqlSource,
  raw: string,
  line: number,
  verbatim: boolean,
): void {
  // Template CR and CRLF denote one LF; normalize before decoding escapes.
  raw = raw.replace(/\r\n?/g, "\n");
  for (let at = 0; at < raw.length; ) {
    const sourceEscape =
      /^\\(?:u\{[\dA-Fa-f]+\}|u[\dA-Fa-f]{4}|x[\dA-Fa-f]{2}|\r\n|[\s\S])/.exec(
        raw.slice(at),
      )?.[0];
    const part = sourceEscape ?? (raw[at] as string);
    const value = sourceEscape && !verbatim ? escapeValue(part) : part;
    sql.text += value;
    for (let n = 0; n < value.length; n++) sql.lines.push(line);
    line += part.split("\n").length - 1;
    at += part.length;
  }
}

function template(
  source: string,
  node: TemplateLiteral,
  verbatim: boolean,
  lineAt: (offset: number) => number,
): SqlSource {
  const sql: SqlSource = { text: "", lines: [] };
  for (const [index, quasi] of node.quasis.entries()) {
    if (index > 0) {
      sql.text += "\0";
      sql.lines.push(lineAt(quasi.start + 1));
    }
    const part: SqlSource = { text: "", lines: [] };
    append(
      part,
      source.slice(quasi.start + 1, quasi.end - (quasi.tail ? 1 : 2)),
      lineAt(quasi.start + 1),
      verbatim,
    );
    // The parser owns the language semantics; decoding above only maps lines.
    sql.text += verbatim
      ? quasi.value.raw
      : (quasi.value.cooked ?? quasi.value.raw);
    for (const line of part.lines) sql.lines.push(line);
  }
  return sql;
}

/** Unknown tags can transform either representation, so neither certifies names. */
function templateSources(
  source: string,
  node: TemplateLiteral,
  raw: boolean,
  uncertain: boolean,
  lineAt: (offset: number) => number,
): SqlSource[] {
  if (!uncertain) return [template(source, node, raw, lineAt)];
  return [true, false].map((verbatim) => ({
    ...template(source, node, verbatim, lineAt),
    uncertain: true,
  }));
}

/** Only binding positions count; property keys and references do not shadow String. */
function bindsStringName(node: Node | null): boolean {
  if (node === null) return false;
  switch (node.type) {
    case "Identifier":
      return node.name === "String";
    case "ObjectPattern":
      return node.properties.some((property) =>
        bindsStringName(
          property.type === "RestElement" ? property.argument : property.value,
        ),
      );
    case "ArrayPattern":
      return node.elements.some(bindsStringName);
    case "AssignmentPattern":
      return bindsStringName(node.left);
    case "RestElement":
      return bindsStringName(node.argument);
    case "TSParameterProperty":
      return bindsStringName(node.parameter);
    default:
      return false;
  }
}

/** Build source-line lookups once; parser offsets are JavaScript string offsets. */
function sourceLines(source: string): (offset: number) => number {
  const starts = [0];
  for (const match of source.matchAll(/\r\n|[\n\r\u2028\u2029]/g))
    starts.push(match.index + match[0].length);
  return (offset) => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((starts[mid] as number) <= offset) low = mid + 1;
      else high = mid;
    }
    return low;
  };
}

/** Parse TypeScript syntax so regexes and division never change literal boundaries. */
export function sourceLiterals(source: string): SqlSource[] {
  // Module syntax permits top-level await; CommonJS also admits return in
  // the source snippets checked by callers. Never walk an error-recovered tree.
  let parsed = parseSync("source.ts", source, {
    sourceType: "module",
    preserveParens: false,
  });
  if (parsed.errors.length)
    parsed = parseSync("source.ts", source, {
      sourceType: "commonjs",
      preserveParens: false,
    });
  if (parsed.errors.length)
    throw new SourceParseError(
      parsed.errors.map((error) => error.message).join("; "),
    );
  const ast = parsed.program;
  const lineAt = sourceLines(source);
  // Conservatively withhold built-in semantics throughout a file that binds
  // String. This includes nested scopes and declarations after the tag.
  let bindsString = false;
  const binding = (node: Node | null) => {
    bindsString ||= bindsStringName(node);
  };
  const fn = (node: { id?: Node | null; params: Node[] }) => {
    binding(node.id ?? null);
    for (const param of node.params) binding(param);
  };
  new Visitor({
    VariableDeclarator: (node) => binding(node.id),
    FunctionDeclaration: fn,
    FunctionExpression: fn,
    ArrowFunctionExpression: fn,
    TSDeclareFunction: fn,
    TSEmptyBodyFunctionExpression: fn,
    CatchClause: (node) => binding(node.param),
    ClassDeclaration: (node) => binding(node.id),
    ClassExpression: (node) => binding(node.id),
    ImportSpecifier: (node) => binding(node.local),
    ImportDefaultSpecifier: (node) => binding(node.local),
    ImportNamespaceSpecifier: (node) => binding(node.local),
    TSImportEqualsDeclaration: (node) => binding(node.id),
    TSEnumDeclaration: (node) => binding(node.id),
    TSModuleDeclaration: (node) => binding(node.id),
  }).visit(ast);
  const rawTemplates = new Set<TemplateLiteral>();
  const unknownTemplates = new Set<TemplateLiteral>();
  const found: SqlSource[] = [];
  new Visitor({
    TaggedTemplateExpression(node) {
      if (!bindsString && rawTag(node.tag)) rawTemplates.add(node.quasi);
      else unknownTemplates.add(node.quasi);
    },
    TemplateLiteral(node) {
      found.push(
        ...templateSources(
          source,
          node,
          rawTemplates.has(node),
          unknownTemplates.has(node),
          lineAt,
        ),
      );
    },
    Literal(node) {
      if (typeof node.value !== "string") return;
      const sql: SqlSource = { text: "", lines: [] };
      append(
        sql,
        source.slice(node.start + 1, node.end - 1),
        lineAt(node.start),
        false,
      );
      found.push(sql);
    },
  }).visit(ast);
  return found;
}
