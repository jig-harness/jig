/**
 * The plugin's one reader of the consumer's change-area catalog
 * (`drive.change_areas_catalog`): a YAML file whose `areas` map names each
 * area of the repository by key. Every skill that reads the catalog, or
 * matches a path glob, imports this module by sibling path.
 *
 * It reads the part of the catalog the plugin acts on:
 *
 *   areas:
 *     <area key>:
 *       paths: ["src/api/**"]          # globs that define membership
 *       generated: [{ source: [...] }] # optional: generator sources, also members
 *       labels: [delivery]             # optional: the area's own labels
 *       tracker:                       # optional; `linear:` is the older spelling
 *         labels: [area:api]           #   tracker labels for the area
 *         flags: [security]            #   flag labels every change there carries
 *
 * Matching is direct: a path belongs to the areas whose own globs match it.
 * The areas a change implies through other areas are the full resolver's
 * business, not this reader's. Every other field stays available as written
 * (`fields`), for the consumer's own tooling and for skills that read one
 * more field, such as `agent`.
 */
import { readFileSync } from "node:fs";
import { load as loadYaml } from "../../../../shared/yaml.ts";
import { isRecord } from "../../../../shared/guards.ts";

export interface CatalogArea {
  /** `paths` and every `generated[].source`, in that order. */
  globs: string[];
  /** `labels`, then `trackerLabels`. */
  labels: string[];
  /** `tracker.labels`, then `linear.labels`. */
  trackerLabels: string[];
  /** `tracker.flags`, then `linear.flags`. */
  flags: string[];
  /** The area as the catalog writes it. */
  fields: Readonly<Record<string, unknown>>;
}

/** The catalog's areas by key, in the catalog's order. */
export type ChangeAreaCatalog = ReadonlyMap<string, CatalogArea>;

// Only an omitted field reads as empty. A present one, `null` included, must
// have its shape: read as empty, a malformed area would silently drop its
// paths, its labels or its flags.
function stringList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
    throw new Error(`${where}: expected a list of strings`);
  return v as string[];
}

// A list of globs, each compiled: a bad one is named by its field and index.
function globList(v: unknown, where: string): string[] {
  const globs = stringList(v, where);
  globs.forEach((glob, i) => {
    const problem = globProblem(glob);
    if (problem !== null) throw new Error(`${where}[${i}]: ${problem}`);
  });
  return globs;
}

// The tracker block in both spellings, each checked for its shape.
const TRACKER_BLOCKS = ["tracker", "linear"] as const;

function trackerLists(
  area: Record<string, unknown>,
  key: string,
  field: "labels" | "flags",
): string[] {
  return TRACKER_BLOCKS.flatMap((block) => {
    const b = area[block];
    if (b === undefined) return [];
    if (!isRecord(b))
      throw new Error(`catalog area ${key}.${block}: not a mapping`);
    return stringList(b[field], `catalog area ${key}.${block}.${field}`);
  });
}

/** Validate a parsed catalog into its areas. Throws with the field at fault. */
export function parseCatalog(raw: unknown): Map<string, CatalogArea> {
  if (!isRecord(raw) || !isRecord(raw.areas))
    throw new Error("the change-area catalog has no `areas` mapping");
  const out = new Map<string, CatalogArea>();
  for (const [key, area] of Object.entries(raw.areas)) {
    if (!isRecord(area)) throw new Error(`catalog area ${key}: not a mapping`);
    const generated = area.generated === undefined ? [] : area.generated;
    if (!Array.isArray(generated))
      throw new Error(`catalog area ${key}.generated: expected a list`);
    const globs = [
      ...globList(area.paths, `catalog area ${key}.paths`),
      ...generated.flatMap((g, i) => {
        if (!isRecord(g))
          throw new Error(`catalog area ${key}.generated[${i}]: not a mapping`);
        return globList(g.source, `catalog area ${key}.generated[${i}].source`);
      }),
    ];
    const trackerLabels = trackerLists(area, key, "labels");
    const labels = [
      ...stringList(area.labels, `catalog area ${key}.labels`),
      ...trackerLabels,
    ];
    const flags = trackerLists(area, key, "flags");
    out.set(key, { globs, labels, trackerLabels, flags, fields: area });
  }
  return out;
}

/**
 * Validate a catalog's `text`; `label` names it in errors. Throws with the
 * label and the reason.
 */
export function loadCatalogText(
  text: string,
  label: string,
): Map<string, CatalogArea> {
  try {
    return parseCatalog(loadYaml(text));
  } catch (err) {
    throw new Error(
      `the change-area catalog ${label} is not valid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Read and validate the consumer's catalog. Throws with the path and the reason. */
export function loadCatalogFile(path: string): Map<string, CatalogArea> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `the change-area catalog ${path} could not be read (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return loadCatalogText(text, path);
}

const globCache = new Map<string, RegExp>();

// Each helper reads the token starting at `i` and returns its regular
// expression source and how many glob characters it used.

function starToken(glob: string, i: number): [string, number] {
  if (glob.charAt(i + 1) !== "*") return ["[^/]*", 1];
  return glob.charAt(i + 2) === "/" ? ["(?:[^]*/)?", 3] : ["[^]*", 2];
}

// An unclosed `[` is a literal bracket. A leading `!` or `^` negates the
// class; a `]` first among the members (`[]]`, `[!]]`, `[^]]`) is a member,
// not its end. A class never matches `/`, which separates segments, negated
// or not.
function classToken(glob: string, i: number): [string, number] {
  const negated = glob.charAt(i + 1) === "!" || glob.charAt(i + 1) === "^";
  const first = negated ? i + 2 : i + 1;
  const end = glob.indexOf("]", glob.charAt(first) === "]" ? first + 1 : first);
  if (end === -1) return ["\\[", 1];
  const members = glob.slice(first, end).replace(/[\\\]^]/g, "\\$&");
  return [`(?!/)[${negated ? "^" : ""}${members}]`, end - i + 1];
}

/**
 * A path glob as a regular expression over a repository-relative path: `**`
 * spans directories, `*` and `?` stay within one segment, `{a,b}` alternates
 * and `[...]` is a character class (`[!...]` or `[^...]` negates). Dotfiles
 * match like any other name (catalogs list paths such as `.github/**`). Throws
 * on a glob that compiles to no pattern, such as an unclosed `{` or a range
 * like `[z-a]`; `globProblem` says why without throwing. A class never matches
 * `/`, and `**` spans every character a path can hold, newlines included.
 */
export function globToRegExp(glob: string): RegExp {
  const hit = globCache.get(glob);
  if (hit !== undefined) return hit;
  const compiled = compileGlob(glob);
  globCache.set(glob, compiled);
  return compiled;
}

// One token outside a character class or `*`: braces open, separate and
// close an alternation; anything else is a literal.
function plainToken(c: string, depth: number): [GlobToken, number] {
  if (c === "?") return [{ kind: "one", source: "[^/]" }, 0];
  if (c === "{") return [{ kind: "open" }, 1];
  if (c === "}" && depth > 0) return [{ kind: "close" }, -1];
  if (c === "," && depth > 0) return [{ kind: "alt" }, 0];
  return [{ kind: "one", source: c.replace(/[.+^${}()|\\/\]]/g, "\\$&") }, 0];
}

/**
 * One unit of a glob: `one` is a single character, `many` any number of
 * them, each matching the regular-expression `source`; `dirs` is `**\/`,
 * any number of whole directories; `open`, `alt` and `close` are the
 * braces and commas of an alternation.
 */
export type GlobToken =
  | { kind: "one" | "many"; source: string }
  | { kind: "dirs" | "open" | "alt" | "close" };

function starTokenOf(glob: string, i: number): [GlobToken, number] {
  const [source, width] = starToken(glob, i);
  if (width === 3) return [{ kind: "dirs" }, width];
  return [{ kind: "many", source: source.slice(0, -1) }, width];
}

/**
 * The glob's tokens, the one reading of its syntax that matching and every
 * other question about a glob share. Throws on an unclosed `{`.
 */
export function globTokens(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  let depth = 0;
  for (let i = 0; i < glob.length; ) {
    const c = glob.charAt(i);
    let token: GlobToken;
    let width = 1;
    if (c === "*") [token, width] = starTokenOf(glob, i);
    else if (c === "[") {
      const [source, w] = classToken(glob, i);
      [token, width] = [{ kind: "one", source }, w];
    } else {
      let change: number;
      [token, change] = plainToken(c, depth);
      depth += change;
    }
    tokens.push(token);
    i += width;
  }
  if (depth > 0) throw new Error(`"${glob}" is not a valid glob: unclosed {`);
  return tokens;
}

const TOKEN_SOURCE = { dirs: "(?:[^]*/)?", open: "(?:", alt: "|", close: ")" };

function compileGlob(glob: string): RegExp {
  const re = globTokens(glob)
    .map((t) =>
      t.kind === "one"
        ? t.source
        : t.kind === "many"
          ? `${t.source}*`
          : TOKEN_SOURCE[t.kind],
    )
    .join("");
  try {
    return new RegExp(`^${re}$`);
  } catch (err) {
    throw new Error(
      `"${glob}" is not a valid glob: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// A glob as a nondeterministic automaton over single UTF-16 code units, as
// its regular expression (compiled without the `u` flag) reads them, built
// from the same tokens and as large as the glob: an alternation is a
// branch, never spelt out. Each step records which characters of the plain
// alphabet pass it: `/`, `.`, and the characters of `NAME_CHARS`.
interface Automaton {
  empty: number[][];
  steps: {
    test: RegExp;
    slash: boolean;
    dot: boolean;
    names: string[];
    to: number;
  }[][];
  accept: number;
}

// The characters a plain file name is built from. A name of these that
// neither starts nor ends with `.`, and whose part before its first `.` is
// not a Windows device name, is one git lists on every platform: it is never
// `.`, `..` or a form of `.git` (`.GIT`, `.git.`, `git~1`, …), whose exact
// set git widens per platform, and Git for Windows accepts it.
const NAME_CHARS = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-",
];

// The device names Windows reserves in any case and with any extension
// (`CON`, `con.txt`): written in `NAME_CHARS`, they are the only plain stems
// Git for Windows refuses to check out. Its set is `COM1` to `COM9` but
// `LPT0` to `LPT9`, so `COM0` is a plain name.
const DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...[..."123456789"].map((d) => `com${d}`),
  ...[..."0123456789"].map((d) => `lpt${d}`),
]);
const DEVICE_PREFIXES = new Set(
  [...DEVICE_NAMES].flatMap((n) => [...n].map((_, i) => n.slice(0, i + 1))),
);

const automata = new Map<string, Automaton>();

function automatonOf(glob: string): Automaton {
  const hit = automata.get(glob);
  if (hit !== undefined) return hit;
  const tokens = globTokens(glob);
  const a: Automaton = { empty: [], steps: [], accept: 0 };
  const state = () => {
    a.steps.push([]);
    return a.empty.push([]) - 1;
  };
  const step = (from: number, source: string, to: number) => {
    const test = new RegExp(`^(?:${source})$`);
    a.steps[from]?.push({
      test,
      slash: test.test("/"),
      dot: test.test("."),
      names: NAME_CHARS.filter((c) => test.test(c)),
      to,
    });
  };
  const free = (from: number, to: number) => a.empty[from]?.push(to);
  let i = 0;
  const sequence = (start: number): number => {
    let at = start;
    for (; i < tokens.length; i++) {
      const t = tokens[i] as GlobToken;
      if (t.kind === "alt" || t.kind === "close") return at;
      const next = state();
      if (t.kind === "one") step(at, t.source, next);
      else if (t.kind === "many") {
        free(at, next);
        step(next, t.source, next);
      } else if (t.kind === "dirs") {
        const inside = state();
        free(at, next);
        free(at, inside);
        step(inside, "[^]", inside);
        step(inside, "/", next);
      } else {
        const from = at;
        do {
          i++;
          free(sequence(from), next);
        } while ((tokens[i] as GlobToken | undefined)?.kind === "alt");
      }
      at = next;
    }
    return at;
  };
  a.accept = sequence(state());
  automata.set(glob, a);
  return a;
}

/**
 * Whether `glob` matches some file under the directory `dir`: a path
 * `<dir>/…` whose segments are plain names, built from `NAME_CHARS` and
 * `.`, neither starting nor ending with `.`, and not a Windows device name
 * before their first `.`, which git lists on every platform. It is
 * conservative: a glob that reaches `dir` only through a dotfile, a device
 * name or a name outside that alphabet reads as matching nothing. Decided on
 * the glob's automaton, by reading `<dir>/` and then asking whether the
 * accepting state is reachable, so it agrees with `matchesGlob` on every
 * token and costs time in proportion to the glob, braces included.
 */
export function globMatchesUnder(glob: string, dir: string): boolean {
  const a = automatonOf(glob);
  return endsInName(a, statesAfter(a, `${dir}/`));
}

/** The states the automaton reaches without reading a character more. */
function closure(a: Automaton, states: Iterable<number>): Set<number> {
  const seen = new Set(states);
  for (const s of seen) for (const t of a.empty[s] ?? []) seen.add(t);
  return seen;
}

/** The states the automaton is in after reading `text`. */
function statesAfter(a: Automaton, text: string): Set<number> {
  let at = closure(a, [0]);
  for (const c of text.split("")) {
    const next = [...at].flatMap((s) =>
      (a.steps[s] ?? []).filter((e) => e.test.test(c)).map((e) => e.to),
    );
    at = closure(a, next);
  }
  return at;
}

/**
 * Whether, from `states` just after a `/`, some plain names lead to the
 * accepting state: searched over (state, how far the current segment has
 * read), since a segment begins with a `NAME_CHARS` character, takes a `.`
 * only after that, and a `/` or the end of the path closes it only when it
 * is a plain name.
 */
function endsInName(a: Automaton, states: Set<number>): boolean {
  const seen = new Set<string>();
  const queue: Position[] = [...states].map((s) => [s, EMPTY]);
  for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
    if (seen.has(`${at}`)) continue;
    seen.add(`${at}`);
    if (at[0] === a.accept && closes(at[1])) return true;
    queue.push(...successors(a, at));
  }
  return false;
}

/**
 * How far the segment being read has got: `""` before its first character,
 * `s:<stem>` inside its stem (before its first `.`), the stem lower-cased
 * while it may still become a device name and `*` once it cannot, `.` just
 * after a `.`, and `n` after a name character that follows one.
 */
type Segment = string;
const EMPTY: Segment = "";

/** A state, and how far the current segment has got. */
type Position = [number, Segment];

function inStem(stem: string): Segment {
  return `s:${DEVICE_PREFIXES.has(stem) ? stem : "*"}`;
}

function afterName(segment: Segment, c: string): Segment {
  if (segment === EMPTY) return inStem(c.toLowerCase());
  if (segment.startsWith("s:")) {
    const stem = segment.slice(2);
    return stem === "*" ? segment : inStem(stem + c.toLowerCase());
  }
  return "n";
}

/** Whether a segment that has got this far may take a `.`. */
function takesDot(segment: Segment): boolean {
  return segment !== EMPTY && !DEVICE_NAMES.has(segment.slice(2));
}

/** Whether a segment that has got this far is a plain name. */
function closes(segment: Segment): boolean {
  return segment === "n" || (segment.startsWith("s:") && takesDot(segment));
}

function successors(a: Automaton, [s, segment]: Position): Position[] {
  const next: Position[] = (a.empty[s] ?? []).map((t) => [t, segment]);
  for (const e of a.steps[s] ?? []) {
    for (const c of e.names) next.push([e.to, afterName(segment, c)]);
    if (e.dot && takesDot(segment)) next.push([e.to, "."]);
    if (e.slash && closes(segment)) next.push([e.to, EMPTY]);
  }
  return next;
}

/** Why `glob` cannot be compiled, or `null` when it can. */
export function globProblem(glob: string): string | null {
  try {
    globToRegExp(glob);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function matchesGlob(file: string, glob: string): boolean {
  return globToRegExp(glob).test(file);
}

/** The keys of the areas whose own globs claim `file`, in catalog order. */
export function areasOf(file: string, catalog: ChangeAreaCatalog): string[] {
  const out: string[] = [];
  for (const [key, area] of catalog)
    if (area.globs.some((g) => matchesGlob(file, g))) out.push(key);
  return out;
}
