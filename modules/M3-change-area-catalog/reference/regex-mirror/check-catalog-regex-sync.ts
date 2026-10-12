#!/usr/bin/env bun
// Certify only literal regex prefixes against an area's own paths declaration.
// This deliberately restrictive scanner is not a general YAML or shell evaluator.
// Never source the repository-controlled filter: its complete grammar is one
// single-quoted assignment plus blank lines and whole-line comments.
import { existsSync, readFileSync } from "node:fs";

function malformed(message: string): never {
  throw new Error(message);
}
const lines = (text: string) => text.replace(/\n$/, "").split("\n");

export function readFilter(
  text: string,
  variable: string,
  file: string,
): string {
  if (text.includes("\r"))
    malformed(
      `${file} contains a carriage return (CRLF line ending) — this gate does not normalize it away`,
    );
  const statements = lines(text).filter((line) => !/^\s*(#.*)?$/.test(line));
  if (statements.length !== 1)
    malformed(
      `${file} has ${statements.length} non-blank, non-comment line(s), not exactly one — expected one plain $${variable}='...' assignment`,
    );
  const line = statements[0] ?? "";
  const match = line.match(new RegExp(`^\\s*(?:export\\s+)?${variable}=(.*)$`));
  if (!match)
    malformed(
      `${file}'s one non-blank, non-comment line is not a plain assignment of the form $${variable}='...'`,
    );
  const rhs = (match[1] ?? "").trimEnd();
  if (!rhs.startsWith("'") || !rhs.endsWith("'"))
    malformed(
      `$${variable} in ${file} is not a single-quoted literal assignment: '${line}'`,
    );
  const re = rhs.slice(1, -1);
  if (re.includes("'"))
    malformed(
      `$${variable} in ${file} is a concatenated or otherwise multi-word single-quoted assignment: '${line}'`,
    );
  if (!re) malformed(`could not read $${variable} from ${file}`);
  if (re.includes("\\|"))
    malformed(
      `an escaped literal pipe (\\|) in $${variable} is not supported: '${re}'`,
    );
  if (re.startsWith("|") || re.endsWith("|") || re.includes("||"))
    malformed(`empty regex alternative in $${variable}: '${re}'`);
  return re;
}

// Quoted keys are decoded before duplicate checks; unsupported escapes fail
// closed rather than comparing an undecoded key against its plain spelling.
function quotedKey(line: string): { name: string; after: string } | undefined {
  const quote = line[0];
  let name = "";
  for (let i = 1; i < line.length; i++) {
    const c = line[i] ?? "";
    if (quote === '"' && c === "\\") {
      const next = line[++i];
      if (next === undefined) return;
      if (next !== '"' && next !== "\\")
        malformed(
          `malformed catalog — unsupported escape sequence \\${next} in quoted key`,
        );
      name += next;
    } else if (c === quote) {
      if (quote === "'" && line[i + 1] === "'") {
        name += "'";
        i++;
        continue;
      }
      const rest = line.slice(i + 1).trimStart();
      return rest.startsWith(":") ? { name, after: rest.slice(1) } : undefined;
    } else name += c;
  }
}

function disallowedTrailing(rest: string): boolean {
  if (rest.startsWith("#")) return true;
  let r = rest.trimStart();
  if (!r || r.startsWith("#")) return false;
  const hash = r.indexOf("#");
  if (hash >= 0) {
    if (!/\s/.test(r[hash - 1] ?? "")) return true;
    r = r.slice(0, hash).trimEnd();
  }
  const properties = r.split(/\s+/);
  if (properties.length > 2) return true;
  const seen = new Set<string>();
  for (const token of properties) {
    const kind = token[0] ?? "";
    const name = token.slice(1);
    if (!name || seen.has(kind)) return true;
    seen.add(kind);
    if (kind === "&") {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) return true;
    } else if (kind === "!") {
      const core = name.startsWith("!");
      const tag = core ? name.slice(1) : name;
      if (!tag || /[\s!"#%,<>[\]^`{|}\\]/.test(tag) || (core && tag !== "map"))
        return true;
    } else return true;
  }
  return false;
}

function pathArray(after: string): string[] {
  const line = after.trimStart();
  if (!line.startsWith("["))
    malformed(
      `malformed paths: declaration — expected an inline array starting with [, got: ${line}`,
    );
  const paths: string[] = [];
  let state = 0;
  let i = 1;
  for (; i < line.length; ) {
    const c = line[i];
    if (/\s/.test(c ?? "")) {
      i++;
      continue;
    }
    if (c === '"' && (state === 0 || state === 2)) {
      let val = "";
      let terminated = false;
      for (i++; i < line.length; i++) {
        const item = line[i] ?? "";
        if (item === "\\" && i + 1 < line.length) {
          const next = line[++i];
          if (next !== '"' && next !== "\\")
            malformed(
              `malformed paths: array — unsupported escape sequence \\${next} (only \\" and \\\\ are supported)`,
            );
          val += next;
        } else if (item === '"') {
          terminated = true;
          i++;
          break;
        } else val += item;
      }
      if (!terminated)
        malformed("malformed paths: array — unterminated quoted string");
      if (!val) malformed("malformed paths: array — empty path string");
      paths.push(val);
      state = 1;
      continue;
    }
    if (c === "," && state === 1) {
      state = 2;
      i++;
      continue;
    }
    if (c === "]") {
      if (state === 0)
        malformed(
          "malformed paths: array — empty array (schema requires at least one path)",
        );
      const rest = line.slice(i + 1).trimStart();
      if (rest && !rest.startsWith("#"))
        malformed(
          `malformed paths: array — unexpected content after ]: ${rest}`,
        );
      return paths;
    }
    malformed(
      `malformed paths: array — unexpected character outside a quoted string: ${c}`,
    );
  }
  malformed("malformed paths: array — missing closing ]");
}

export function catalogPaths(text: string): string[] {
  let inAreas = false;
  let areasSeen = false;
  let area = "";
  let seenPaths = false;
  let contentSeen = false;
  let documentEnd = false;
  let documentStart = false;
  const areas = new Set<string>();
  const paths: string[] = [];
  const checkPaths = () => {
    if (area && !seenPaths)
      malformed(`malformed catalog — area ${area} has no paths: key: required`);
  };
  for (const [index, line] of lines(text).entries()) {
    const fail = (message: string): never =>
      malformed(`${message} (line ${index + 1}): ${line}`);
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^(---|\.\.\.)(\s|$)/.test(line)) {
      const rest = line.slice(3).trimStart();
      if (rest && !rest.startsWith("#"))
        fail(
          "malformed catalog — a --- or ... marker with trailing scalar content is unsupported",
        );
      if (line.startsWith("...")) {
        documentEnd = true;
        continue;
      }
      if (contentSeen || documentEnd || documentStart)
        fail(
          "malformed catalog — a second --- YAML document-start marker is unsupported",
        );
      documentStart = true;
      continue;
    }
    if (documentEnd)
      fail(
        "malformed catalog — content after a ... YAML document-end marker is unsupported",
      );
    contentSeen = true;
    const root = line.match(/^(?:areas|'areas')\s*:/);
    let rootAfter = root ? line.slice(root[0].length) : undefined;
    if (line.startsWith('"')) {
      const key = quotedKey(line);
      if (key?.name === "areas") rootAfter = key.after;
    }
    if (rootAfter !== undefined) {
      if (disallowedTrailing(rootAfter))
        fail(
          "malformed catalog — areas: key has trailing content, expected a nested mapping or a YAML anchor and/or tag",
        );
      if (areasSeen) fail("malformed catalog — duplicate top-level areas: key");
      areasSeen = true;
      inAreas = true;
      area = "";
      seenPaths = false;
      continue;
    }
    if (/^[&*!?]/.test(line))
      fail(
        "malformed catalog — unsupported YAML node property or explicit key (anchor/alias/tag/`?`) as a top-level key",
      );
    if (inAreas && /^[^\s#]/.test(line)) {
      checkPaths();
      inAreas = false;
    }
    if (!inAreas) continue;
    if (/^ {2}[&*!?]/.test(line))
      fail(
        "malformed catalog — unsupported YAML node property or explicit key (anchor/alias/tag/`?`) on an area declaration",
      );
    if (/^ {4}[&*!?]/.test(line))
      fail(
        "malformed catalog — unsupported YAML node property or explicit key (anchor/alias/tag/`?`) on a paths: declaration",
      );
    if (/^ {2}[^ #]/.test(line)) {
      checkPaths();
      const declaration = line.slice(2);
      if (/^-(\s|$)/.test(declaration))
        fail(
          "malformed catalog — areas: must be a mapping of named areas, not a sequence",
        );
      let name: string;
      let after: string;
      if (/^["']/.test(declaration)) {
        const key = quotedKey(declaration);
        if (!key)
          return fail(
            "malformed catalog — area line has an unterminated or malformed quoted key",
          );
        name = key.name;
        after = key.after;
      } else {
        const comment = declaration.search(/\s#/);
        const before =
          comment < 0 ? declaration : declaration.slice(0, comment);
        const colon = before.indexOf(":");
        if (colon < 0)
          fail("malformed catalog — area line has no key: mapping colon");
        name = declaration.slice(0, colon).trimEnd();
        after = declaration.slice(colon + 1);
      }
      if (disallowedTrailing(after))
        fail(
          "malformed catalog — area declaration has trailing content, expected a nested mapping or a YAML anchor and/or tag",
        );
      if (areas.has(name))
        fail(`malformed catalog — duplicate area identifier ${name}`);
      areas.add(name);
      area = name;
      seenPaths = false;
    }
    const key = line.match(/^ {4}(?:paths|'paths')\s*:/);
    let after = key ? line.slice(key[0].length) : undefined;
    if (/^ {4}"/.test(line)) {
      const quoted = quotedKey(line.slice(4));
      if (quoted?.name === "paths") after = quoted.after;
    }
    if (after !== undefined) {
      if (!area)
        fail(
          "malformed catalog — paths: key inside areas: but outside any area",
        );
      if (seenPaths)
        fail("malformed catalog — duplicate paths: key within the same area");
      seenPaths = true;
      paths.push(...pathArray(after));
    }
  }
  if (inAreas) checkPaths();
  if (!paths.length) malformed("no area paths: values found in catalog");
  return paths;
}

export function literalHead(glob: string): string {
  // Escape-aware first variable construct; only a complete directory head
  // before it can certify coverage. Glob escapes and regex escapes differ.
  let variable = -1;
  for (let i = 0; i < glob.length; i++) {
    if ("*[?{".includes(glob[i] ?? "")) {
      let bs = 0;
      for (let j = i - 1; j >= 0 && glob[j] === "\\"; j--) bs++;
      if (bs % 2 === 0) {
        variable = i;
        break;
      }
    }
  }
  const head =
    variable < 0
      ? glob
      : glob.slice(0, glob.lastIndexOf("/", variable - 1) + 1);
  return head.replace(/\\([*[\]?{}\\])/g, "$1");
}

export function regexPrefix(
  segment: string,
  variable: string,
): { prefix: string; exact: boolean } {
  if (!segment.startsWith("^"))
    malformed(
      `regex alternative in $${variable} is missing a leading ^: '${segment}'`,
    );
  let remainder = segment.slice(1);
  if (remainder.endsWith("/**"))
    malformed(
      `regex alternative in $${variable} ends in /**, which is not reliable regex syntax: '${segment}' — use /.* instead`,
    );
  let exact = false;
  if (remainder.endsWith("$")) {
    let bs = 0;
    for (let i = remainder.length - 2; i >= 0 && remainder[i] === "\\"; i--)
      bs++;
    if (bs % 2)
      malformed(
        `regex alternative in $${variable} ends in an escaped \\$ (a literal $ character, not an end anchor) with no other recognized boundary: '${segment}'`,
      );
    remainder = remainder.slice(0, -1);
    if (remainder.endsWith("/.*")) remainder = remainder.slice(0, -3);
    else if (remainder.endsWith("/"))
      malformed(
        `regex alternative in $${variable} combines a directory suffix with a trailing $ anchor: '${segment}'`,
      );
    else exact = true;
  } else {
    if (remainder.endsWith("/.*")) remainder = remainder.slice(0, -3);
    else if (remainder.endsWith("/")) remainder = remainder.slice(0, -1);
    else
      malformed(
        `regex alternative in $${variable} has no path-component boundary at its end: '${segment}'`,
      );
  }
  if (/[.[\]^$(){}+?*]/.test(remainder.replace(/\\./g, "X")))
    malformed(
      `unsupported regex metacharacter in $${variable} alternative: '${segment}'`,
    );
  if (remainder.replace(/\\([.[\](){}+?*^$\\])/g, "X").includes("\\"))
    malformed(
      `regex alternative in $${variable} contains a backslash escape this gate does not recognize: '${segment}'`,
    );
  const prefix = remainder.replace(/\\(.)/g, "$1");
  if (/^\s|\s$/.test(prefix))
    malformed(
      `regex alternative in $${variable} has leading or trailing whitespace in its normalized prefix: '${segment}'`,
    );
  if (!prefix)
    malformed(
      `empty or unsupported regex alternative in $${variable}: '${segment}'`,
    );
  return { prefix, exact };
}

export function checkCatalogRegexSync(env = process.env): number {
  const filter = env.FILTER_FILE || "tools/ci/detect-changes-filter.sh";
  const catalog = env.CATALOG || "tools/change-areas/catalog.yaml";
  const variable = env.RE_VAR || "CODE_PATH_RE";
  if (!existsSync(filter)) malformed(`filter file not found: ${filter}`);
  if (!existsSync(catalog)) malformed(`catalog not found: ${catalog}`);
  const re = readFilter(readFileSync(filter, "utf8"), variable, filter);
  const globs = catalogPaths(readFileSync(catalog, "utf8"));
  if (globs.some((glob) => /[@!+]\(/.test(glob)))
    malformed(
      `${catalog} has a paths: glob using extglob syntax (@(...), !(...), or +(...)), which this gate's literal-head reduction does not recognize`,
    );
  if (globs.some((glob) => glob.startsWith("!")))
    malformed(
      `${catalog} has a paths: glob starting with ! (leading negation), which this gate's literal-head reduction does not recognize`,
    );
  const heads = globs.map(literalHead);
  const missing = re
    .split("|")
    .map((segment) => regexPrefix(segment, variable))
    .filter(
      ({ prefix, exact }) =>
        !heads.some(
          (head) =>
            head.startsWith(prefix) &&
            (exact
              ? head.length === prefix.length
              : head[prefix.length] === "/"),
        ),
    )
    .map((segment) => segment.prefix);
  if (missing.length) {
    console.log(
      `ERROR: CI code-path regex has prefixes absent from the catalog\n\nEvery path prefix in $${variable} (${filter}) must be a prefix of some\narea's paths: glob in the catalog (${catalog}) — otherwise the fast CI\nshortcut and the change-area source of truth have drifted apart. A\nprefix mentioned only in notes: or elsewhere does not count. Add the\nprefix to an area's paths, or remove it from the regex.\n\nPrefixes matched by no area's paths:\n${missing.map((prefix) => `  ${prefix}`).join("\n")}`,
    );
    return 1;
  }
  console.log(
    `OK — every prefix in $${variable} is a prefix of some area's paths: in ${catalog}`,
  );
  return 0;
}
if (import.meta.main) {
  try {
    process.exitCode = checkCatalogRegexSync();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
