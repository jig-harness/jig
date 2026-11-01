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
    const char = String.fromCodePoint(quoted.codePointAt(i) ?? 0);
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      i += char.length - 1;
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

type Side = keyof FileLines;
/** Per side, the lines the hunk still holds and the next line's number. */
type Counts = Record<Side, { left: number; next: number }>;
const SIDES: Record<string, Side> = { "-": "removed", "+": "added" };

function hunkCounts(header: string): Counts {
  const match = HUNK.exec(header);
  if (!match) throw new DiffError(`malformed hunk header: ${header}`);
  return {
    removed: { left: Number(match[2] ?? 1), next: Number(match[1]) },
    added: { left: Number(match[4] ?? 1), next: Number(match[3]) },
  };
}

/** The side a hunk line belongs to, or null when the hunk has no room left there. */
function sideOf(line: string, counts: Counts): Side | null {
  const side = SIDES[line.charAt(0)];
  return side !== undefined && counts[side].left > 0 ? side : null;
}

function takeLine(cursor: Cursor, counts: Counts, file: FileLines): void {
  const line = cursor.lines[cursor.at++];
  if (line === undefined) throw new DiffError("a hunk ends early");
  if (line.startsWith("\\")) return;
  const side = sideOf(line, counts);
  if (side === null) throw new DiffError(`unexpected line in a hunk: ${line}`);
  file[side].push({ number: counts[side].next++, text: line.slice(1) });
  counts[side].left--;
}

/** Read one hunk's lines into `file`, by the counts its header gives. */
function readHunk(cursor: Cursor, header: string, file: FileLines): void {
  const counts = hunkCounts(header);
  while (counts.removed.left > 0 || counts.added.left > 0)
    takeLine(cursor, counts, file);
}

/** Where the parse stands: the file a hunk adds to, and the old path read before it. */
interface State {
  files: Map<string, FileLines>;
  known: ReadonlySet<string>;
  current: FileLines | null;
  oldPath: string | null;
}

function openFile(state: State, path: string | null): FileLines {
  if (path === null || !state.known.has(path))
    throw new DiffError(
      `the diff names a path the effective file list does not hold: ${path}`,
    );
  const file = state.files.get(path) ?? { added: [], removed: [] };
  state.files.set(path, file);
  return file;
}

const FILE_HEADER = "diff --git ";

/** A line outside any hunk: a file's first header line, or its paths. */
function readHeader(line: string, state: State): void {
  if (line.startsWith(FILE_HEADER)) {
    state.current = null;
    state.oldPath = null;
  } else if (state.current !== null) return;
  else if (line.startsWith("--- ")) state.oldPath = pathOf(line.slice(4), "a/");
  else if (line.startsWith("+++ "))
    state.current = openFile(
      state,
      pathOf(line.slice(4), "b/") ?? state.oldPath,
    );
}

function hunkFile(state: State, header: string): FileLines {
  if (state.current === null)
    throw new DiffError(`a hunk comes before its file's header: ${header}`);
  return state.current;
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
  const state: State = {
    files: new Map(),
    known,
    current: null,
    oldPath: null,
  };
  const cursor: Cursor = { lines: text.split("\n"), at: 0 };
  while (cursor.at < cursor.lines.length) {
    const line = cursor.lines[cursor.at++] ?? "";
    if (line.startsWith("@@ ")) readHunk(cursor, line, hunkFile(state, line));
    else readHeader(line, state);
  }
  return state.files;
}
