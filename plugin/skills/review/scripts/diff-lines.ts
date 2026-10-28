/**
 * The added and removed lines of each file in an effective diff (git's
 * unified format with no context lines), keyed by the path git names in the
 * file's `---` and `+++` lines.
 */

/** One added or removed line, numbered in the file it belongs to. */
export interface DiffLine {
  number: number;
  text: string;
}

export interface FileLines {
  added: DiffLine[];
  removed: DiffLine[];
}

export class DiffError extends Error {
  override name = "DiffError";
}

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/** A path git wrote in double quotes with C escapes, as the text it stands for. */
export function unquote(quoted: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 1; i < quoted.length - 1; i++) {
    const char = quoted[i] ?? "";
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const next = quoted[i + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(quoted.slice(i + 1, i + 4))?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      i += 3;
    } else if (next in ESCAPES) {
      bytes.push(ESCAPES[next] ?? 0);
      i += 1;
    } else throw new DiffError(`unknown escape in a quoted path: ${quoted}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    new Uint8Array(bytes),
  );
}

/**
 * The path of a `---` or `+++` line's name, or null for `/dev/null`. Git
 * appends a tab to an unquoted name that holds a space.
 */
function pathOf(name: string, prefix: string): string | null {
  if (name === "/dev/null") return null;
  const path =
    name.startsWith('"') && name.endsWith('"')
      ? unquote(name)
      : name.replace(/\t$/, "");
  if (!path.startsWith(prefix))
    throw new DiffError(`a diff path lacks its ${prefix} prefix: ${name}`);
  return path.slice(prefix.length);
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface Cursor {
  lines: string[];
  at: number;
}

/** Read one hunk's lines into `file`, by the counts its header gives. */
function readHunk(cursor: Cursor, header: string, file: FileLines): void {
  const match = HUNK.exec(header);
  if (!match) throw new DiffError(`malformed hunk header: ${header}`);
  let removed = Number(match[2] ?? 1);
  let added = Number(match[4] ?? 1);
  let oldLine = Number(match[1]);
  let newLine = Number(match[3]);
  while (removed > 0 || added > 0) {
    const line = cursor.lines[cursor.at++];
    if (line === undefined) throw new DiffError("a hunk ends early");
    if (line.startsWith("\\")) continue;
    if (line.startsWith("-") && removed > 0) {
      file.removed.push({ number: oldLine++, text: line.slice(1) });
      removed--;
    } else if (line.startsWith("+") && added > 0) {
      file.added.push({ number: newLine++, text: line.slice(1) });
      added--;
    } else throw new DiffError(`unexpected line in a hunk: ${line}`);
  }
}

/**
 * Each file's added and removed lines. A path that is not one of `known`
 * (the effective file list) stops the parse: the diff and the list must
 * describe the same change.
 */
export function diffLines(
  text: string,
  known: ReadonlySet<string>,
): Map<string, FileLines> {
  const files = new Map<string, FileLines>();
  const cursor: Cursor = { lines: text.split("\n"), at: 0 };
  let current: FileLines | null = null;
  let oldPath: string | null = null;
  while (cursor.at < cursor.lines.length) {
    const line = cursor.lines[cursor.at++] ?? "";
    if (line.startsWith("diff --git ")) {
      current = null;
      oldPath = null;
    } else if (current === null && line.startsWith("--- "))
      oldPath = pathOf(line.slice(4), "a/");
    else if (current === null && line.startsWith("+++ ")) {
      const path = pathOf(line.slice(4), "b/") ?? oldPath;
      if (path === null || !known.has(path))
        throw new DiffError(
          `the diff names a path the effective file list does not hold: ${path}`,
        );
      current = files.get(path) ?? { added: [], removed: [] };
      files.set(path, current);
    } else if (line.startsWith("@@ ")) {
      if (current === null)
        throw new DiffError(`a hunk comes before its file's header: ${line}`);
      readHunk(cursor, line, current);
    }
  }
  return files;
}
