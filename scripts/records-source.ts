import { parse } from "@babel/parser";
import {
  isIdentifier,
  isMemberExpression,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTemplateLiteral,
  type Expression,
  type TemplateLiteral,
  traverseFast,
} from "@babel/types";

/** Literal text and the original source line for each character. */
export interface SqlSource {
  text: string;
  lines: number[];
  /** An unknown tag may transform the literal; its declarations cannot certify names. */
  uncertain?: boolean;
}

/** Static property spelling, without evaluating a computed expression. */
function rawTag(tag: Expression): boolean {
  if (!isMemberExpression(tag) || !isIdentifier(tag.object, { name: "String" }))
    return false;
  if (!tag.computed) return isIdentifier(tag.property, { name: "raw" });
  if (isStringLiteral(tag.property)) return tag.property.value === "raw";
  return (
    isTemplateLiteral(tag.property) &&
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
): SqlSource {
  const sql: SqlSource = { text: "", lines: [] };
  for (const [index, quasi] of node.quasis.entries()) {
    if (index > 0) {
      sql.text += "\0";
      sql.lines.push(quasi.loc?.start.line ?? 1);
    }
    append(
      sql,
      source.slice(quasi.start ?? 0, quasi.end ?? 0),
      quasi.loc?.start.line ?? 1,
      verbatim,
    );
  }
  return sql;
}

/** Parse TypeScript syntax so regexes and division never change literal boundaries. */
export function sourceLiterals(source: string): SqlSource[] {
  const ast = parse(source, {
    sourceType: "unambiguous",
    plugins: ["typescript"],
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  });
  const rawTemplates = new Set<TemplateLiteral>();
  const unknownTemplates = new Set<TemplateLiteral>();
  const found: SqlSource[] = [];
  traverseFast(ast, (node) => {
    if (isTaggedTemplateExpression(node)) {
      if (rawTag(node.tag)) rawTemplates.add(node.quasi);
      else unknownTemplates.add(node.quasi);
    }
    if (isTemplateLiteral(node)) {
      if (unknownTemplates.has(node)) {
        // Inspect both representations: neither is proven to be the tag's output.
        for (const verbatim of [true, false])
          found.push({ ...template(source, node, verbatim), uncertain: true });
      } else found.push(template(source, node, rawTemplates.has(node)));
    }
    if (isStringLiteral(node)) {
      const sql: SqlSource = { text: "", lines: [] };
      append(
        sql,
        source.slice((node.start ?? 0) + 1, (node.end ?? 0) - 1),
        node.loc?.start.line ?? 1,
        false,
      );
      found.push(sql);
    }
  });
  return found;
}
