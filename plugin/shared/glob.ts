/**
 * Path globs over repository-relative paths, as the change-area catalog
 * (`drive.change_areas_catalog`) and every configuration field that matches
 * changed paths read them: one compiler, so a glob means the same wherever a
 * repository writes it.
 */
import { JigError } from "./outcome.ts";

// A long-lived process (the dispatcher) sees many configurations over its
// lifetime; a cache holds the most recent globs only, oldest dropped first.
const CACHE_LIMIT = 1024;

function remember<T>(cache: Map<string, T>, glob: string, value: T): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(glob, value);
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
  remember(globCache, glob, compiled);
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
type GlobToken =
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
function globTokens(glob: string): GlobToken[] {
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
  if (depth > 0)
    throw new JigError(
      "glob-invalid",
      `"${glob}" is not a valid glob: unclosed {`,
    );
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
    throw new JigError(
      "glob-invalid",
      `"${glob}" is not a valid glob: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
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
    /** Literal and punctuation characters this token accepts, beyond plain names. */
    chars: string[];
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

// Characters a class may accept beyond its own members, so a negated or
// ranged class reaches punctuation, a non-ASCII letter, and each half of a
// supplementary character (the automaton reads UTF-16 code units).
const EXTRA_CHARS = [
  ...".~@+= !\"#$%&'()*,:;<>?[\\]^`{|}",
  "é",
  "中",
  "\ud83d",
  "\ude00",
];

/**
 * The sampled characters a token accepts besides `/`. When none of the sample
 * passes, the first code unit that does stands in, found over the whole
 * UTF-16 domain, so a class that accepts only characters outside the sample
 * is never read as empty. U+0000 is never a witness: git cannot store it in a
 * file name. A source with no regular-expression syntax is a literal, whose
 * characters the sample already holds, so it is never searched.
 */
function acceptedChars(source: string, test: RegExp): string[] {
  const sampled = [...new Set([...source, ...EXTRA_CHARS])].filter(
    (c) => c !== "/" && c !== "\0" && test.test(c),
  );
  if (sampled.length > 0 || !/[\\[\]().*+?{}|^$]/.test(source)) return sampled;
  const hit = fallbackChars.get(source);
  if (hit !== undefined) return hit;
  let found: string[] = [];
  for (let unit = 1; unit <= 0xffff; unit++) {
    const c = String.fromCharCode(unit);
    if (c !== "/" && test.test(c)) {
      found = [c];
      break;
    }
  }
  remember(fallbackChars, source, found);
  return found;
}

const fallbackChars = new Map<string, string[]>();

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
      chars: acceptedChars(source, test),
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
  remember(automata, glob, a);
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
  return endsInPlainName(a, statesAfter(a, `${dir}/`));
}

/**
 * Whether `glob` can match some path under `dir`, including dotfiles and
 * punctuation. This is intentionally broader than `globMatchesUnder`: a
 * serialized-work guard must hold when any supported path may intersect.
 */
export function globMayMatchUnder(glob: string, dir: string): boolean {
  const a = automatonOf(glob);
  return endsInPathSegment(a, statesAfter(a, `${dir}/`));
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
function endsInPlainName(a: Automaton, states: Set<number>): boolean {
  const seen = new Set<string>();
  const queue: Position[] = [...states].map((s) => [s, EMPTY]);
  for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
    if (seen.has(`${at}`)) continue;
    seen.add(`${at}`);
    if (at[0] === a.accept && closes(at[1])) return true;
    queue.push(...plainSuccessors(a, at));
  }
  return false;
}

function endsInPathSegment(a: Automaton, states: Set<number>): boolean {
  const seen = new Set<string>();
  const queue: Position[] = [...states].map((s) => [s, EMPTY]);
  for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
    if (seen.has(`${at}`)) continue;
    seen.add(`${at}`);
    if (at[0] === a.accept && at[1] !== EMPTY) return true;
    queue.push(...pathSuccessors(a, at));
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

function plainSuccessors(a: Automaton, [s, segment]: Position): Position[] {
  const next: Position[] = (a.empty[s] ?? []).map((t) => [t, segment]);
  for (const e of a.steps[s] ?? []) {
    for (const c of e.names) next.push([e.to, afterName(segment, c)]);
    if (e.dot && takesDot(segment)) next.push([e.to, "."]);
    if (e.slash && closes(segment)) next.push([e.to, EMPTY]);
  }
  return next;
}

function pathSuccessors(a: Automaton, [s, segment]: Position): Position[] {
  const next: Position[] = (a.empty[s] ?? []).map((t) => [t, segment]);
  for (const e of a.steps[s] ?? []) {
    for (const c of e.names) next.push([e.to, afterName(segment, c)]);
    for (const c of e.chars) next.push([e.to, afterName(segment, c)]);
    if (e.dot) next.push([e.to, "."]);
    if (e.slash && segment !== EMPTY) next.push([e.to, EMPTY]);
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

/** Whether `glob` claims the repository-relative path `file`. */
export function matchesGlob(file: string, glob: string): boolean {
  return globToRegExp(glob).test(file);
}
