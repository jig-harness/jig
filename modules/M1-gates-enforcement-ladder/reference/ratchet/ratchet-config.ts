import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { canonical, readable, record } from "./ratchet-common.ts";
import type { ConfigFile } from "./ratchet-types.ts";

/** Flags `strict` turns on unless they are set to false themselves. */
const STRICT_FAMILY = [
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "strictBuiltinIteratorReturn",
  "noImplicitThis",
  "useUnknownInCatchVariables",
  "alwaysStrict",
];

const STRICTNESS_FLAGS = [
  "strict",
  ...STRICT_FAMILY,
  "noUncheckedIndexedAccess",
  "noFallthroughCasesInSwitch",
  "noImplicitOverride",
  "noImplicitReturns",
  "noUnusedLocals",
  "noUnusedParameters",
  "exactOptionalPropertyTypes",
  "erasableSyntaxOnly",
  "noPropertyAccessFromIndexSignature",
  "verbatimModuleSyntax",
  "isolatedModules",
];

const SEVERITY: Record<string, number> = {
  off: 0,
  none: 0,
  info: 1,
  on: 2,
  warn: 2,
  error: 3,
};

/** Biome's presets, from none to every rule. */
const PRESET: Record<string, number> = { none: 0, recommended: 1, all: 2 };

/** The keys of a tsconfig that choose its files, taken whole from one file. */
const TSCONFIG_SCOPE = ["files", "include", "exclude", "references"];

/** The scope keys a configuration takes from the one it extends. */
const TSCONFIG_INHERITED_SCOPE = ["files", "include", "exclude"];

/** Index just past the string literal that opens at `start`. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  return i + 1;
}

/** Index of the end of the comment at `i`, or `i` when none starts there. */
function commentEnd(text: string, i: number): number {
  const two = text.slice(i, i + 2);
  if (two === "//") {
    const end = text.indexOf("\n", i);
    return end < 0 ? text.length : end;
  }
  if (two !== "/*") return i;
  const end = text.indexOf("*/", i + 2);
  if (end < 0) throw new Error("unterminated comment");
  return end + 2;
}

/** The first character at or after `i` that is neither space nor comment. */
function nextToken(text: string, i: number): string | undefined {
  while (i < text.length) {
    const end = commentEnd(text, i);
    if (end !== i) i = end;
    else if (/\s/.test(text[i] ?? "")) i++;
    else return text[i];
  }
  return undefined;
}

/** JSON with comments and trailing commas, as tsconfig and fallow allow. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    const end = commentEnd(text, i);
    if (end !== i) {
      i = end;
      continue;
    }
    // A comma before a closing bracket, outside a string, is dropped, also
    // when a comment stands between them.
    const next = text[i] === "," ? nextToken(text, i + 1) : undefined;
    if (next !== "}" && next !== "]") out += text[i];
    i++;
  }
  return JSON.parse(out);
}

function level(v: unknown): number | undefined {
  const name = typeof v === "string" ? v : record(v).level;
  return typeof name === "string" ? SEVERITY[name] : undefined;
}

function severities(rules: Record<string, unknown>, out: Map<string, number>) {
  for (const [rule, v] of Object.entries(rules)) {
    const rank = level(v);
    if (rank !== undefined) out.set(rule, rank);
  }
}

/**
 * The file an `extends` entry names, found as the compiler finds it: a
 * relative path, with `.json` added when the path itself is not a file, or
 * a package's configuration in a `node_modules` at or above the extending
 * file. One that cannot be found is an error, never an empty parent that
 * would read as every inherited flag switched off.
 */
function parentConfig(tree: string, from: string, name: string): string {
  const isFile = (file: string) =>
    existsSync(join(tree, file)) && statSync(join(tree, file)).isFile();
  const found = (
    name.startsWith("./") || name.startsWith("../")
      ? relativeCandidates(relative(tree, resolve(tree, dirname(from), name)))
      : packageCandidates(tree, from, name)
  ).find(isFile);
  if (found === undefined)
    throw new Error(`${from}: cannot resolve extends "${name}"`);
  return found;
}

function relativeCandidates(file: string): string[] {
  return file.endsWith(".json") ? [file] : [file, `${file}.json`];
}

/**
 * In each `node_modules` from the extending file's directory upwards: the
 * named file, then with `.json`, then the file the package's own
 * `package.json` names in its `tsconfig` field, then its `tsconfig.json`.
 */
function packageCandidates(tree: string, from: string, name: string): string[] {
  const out: string[] = [];
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const pkg = join(dir, "node_modules", name);
    out.push(pkg, `${pkg}.json`);
    const manifest = readable(tree, join(pkg, "package.json"));
    const field =
      manifest === undefined
        ? undefined
        : record(parseJsonc(manifest)).tsconfig;
    if (typeof field === "string") out.push(join(pkg, field));
    out.push(join(pkg, "tsconfig.json"));
    if (dir === "." || dir === dirname(dir)) return out;
  }
}

interface Tsconfig {
  options: Record<string, unknown>;
  /** Each file-choosing key, with the file that set it. */
  scope: Record<string, unknown>;
}

/**
 * What a tsconfig resolves to, following its `extends` chain as the
 * compiler does: each parent resolved whole, a later parent's setting over an
 * earlier one's, `references` never inherited. A parent reached through two
 * entries is resolved for each; one that extends itself is an error, as it is
 * for the compiler.
 */
function tsconfigResolved(
  tree: string,
  path: string,
  chain: string[] = [],
): Tsconfig {
  if (chain.includes(path))
    throw new Error(`${[...chain, path].join(" → ")}: extends itself`);
  const text = readable(tree, path);
  if (text === undefined) throw new Error(`${path}: not found`);
  const doc = record(parseJsonc(text));
  const inherited = (Array.isArray(doc.extends) ? doc.extends : [doc.extends])
    .filter((p): p is string => typeof p === "string")
    .map((p) =>
      tsconfigResolved(tree, parentConfig(tree, path, p), [...chain, path]),
    );
  const scope: Record<string, unknown> = {};
  for (const t of inherited)
    for (const key of TSCONFIG_INHERITED_SCOPE)
      if (t.scope[key] !== undefined) scope[key] = t.scope[key];
  for (const key of TSCONFIG_SCOPE)
    if (doc[key] !== undefined) scope[key] = { in: path, value: doc[key] };
  return {
    options: Object.assign(
      {},
      ...inherited.map((t) => t.options),
      record(doc.compilerOptions),
    ),
    scope,
  };
}

function tsconfigStrictness(
  options: Record<string, unknown>,
): Map<string, number> {
  const strict = options.strict === true;
  return new Map(
    STRICTNESS_FLAGS.map((flag) => {
      const set = options[flag];
      const on =
        set === true ||
        (set === undefined && strict && STRICT_FAMILY.includes(flag));
      return [flag, on ? 1 : 0];
    }),
  );
}

/**
 * A file scope as settings: `includes[<owner>]:<pattern>`, a pattern that
 * brings files in at 1 and one that takes them out (`!…`) at 0, so dropping
 * the first or adding the second reads as a loosening.
 */
function scope(owner: string, includes: unknown, out: Map<string, number>) {
  const patterns = Array.isArray(includes) ? includes : ["**"];
  for (const p of patterns)
    if (typeof p === "string")
      out.set(`includes[${owner}]:${p}`, p.startsWith("!") ? 0 : 1);
}

function ruleSeverities(rules: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>();
  // Keyed by rule name alone, across groups: a rule that graduates from one
  // group to another keeps its strictness.
  for (const [group, entries] of Object.entries(rules))
    if (group !== "preset" && group !== "recommended")
      severities(record(entries), out);
  return out;
}

function biomeStrictness(
  doc: Record<string, unknown>,
  where: string,
): Map<string, number> {
  const out = new Map<string, number>();
  const linter = record(doc.linter);
  out.set("linter.enabled", linter.enabled === false ? 0 : 1);
  const rules = record(linter.rules);
  const preset =
    rules.preset ?? (rules.recommended === false ? "none" : "recommended");
  const rank = typeof preset === "string" ? PRESET[preset] : undefined;
  if (rank !== undefined) out.set("preset", rank);
  for (const [rule, rank] of ruleSeverities(rules)) out.set(rule, rank);
  scope("files", record(doc.files).includes, out);
  scope("linter", linter.includes, out);
  plugins(doc.plugins, out, where);
  overrides(doc.overrides, out);
  return out;
}

/**
 * A plugin by its file name: one moved to another directory keeps its
 * strictness, as a rule that graduates to another group does. Two plugins
 * with one file name in different directories would be compared as one, so
 * a configuration that lists them is refused rather than read ambiguously.
 */
const pluginName = (path: string): string => path.split("/").pop() ?? path;

/** A Biome configuration whose plugins the ratchet cannot tell apart. */
class AmbiguousPluginsError extends Error {
  readonly code = "ratchet-ambiguous-plugins";
}

function plugins(list: unknown, out: Map<string, number>, where: string) {
  const seen = new Map<string, string>();
  for (const p of Array.isArray(list) ? list : []) {
    const path = typeof p === "string" ? p : record(p).path;
    if (typeof path !== "string") continue;
    const name = pluginName(path);
    const other = seen.get(name);
    if (other !== undefined)
      throw new AmbiguousPluginsError(
        `${where}: plugins "${other}" and "${path}" share the file name ${name}, so the ratchet cannot tell them apart; rename one`,
      );
    seen.set(name, path);
    out.set(`plugin:${name}`, 3);
    scope(`plugin:${name}`, record(p).includes, out);
  }
}

/**
 * An override's settings hold for its files only: `<setting>@<includes>`,
 * compared against the same setting outside any override when the base has
 * no such override.
 */
function overrides(list: unknown, out: Map<string, number>): void {
  for (const o of Array.isArray(list) ? list : []) {
    const where = record(o).includes;
    const at = Array.isArray(where) ? where.join(",") : "**";
    const own = record(record(o).linter);
    if (own.enabled === false) out.set(`linter.enabled@${at}`, 0);
    const rules = record(own.rules);
    const preset =
      typeof rules.preset === "string" ? PRESET[rules.preset] : undefined;
    if (preset !== undefined) out.set(`preset@${at}`, preset);
    for (const [rule, rank] of ruleSeverities(rules))
      out.set(`${rule}@${at}`, rank);
  }
}

/** The strictness a configuration file declares in `tree`: setting → rank. */
export function strictness(
  kind: ConfigFile["kind"],
  tree: string,
  path: string,
): Map<string, number> | undefined {
  if (kind === "tsconfig")
    return readable(tree, path) === undefined
      ? undefined
      : tsconfigStrictness(tsconfigResolved(tree, path).options);
  const text = readable(tree, path);
  if (text === undefined) return undefined;
  const doc = record(parseJsonc(text));
  if (kind === "biome") return biomeStrictness(doc, path);
  const out = new Map<string, number>();
  severities(record(doc.rules), out);
  return out;
}

/**
 * A value with every empty object dropped and keys in order, so two spellings
 * of one configuration compare equal. Formatting settings change no finding
 * and are left out.
 */
function pruned(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(pruned);
  if (typeof v !== "object" || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(v).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (key === "$schema" || key === "formatter") continue;
    const x = pruned((v as Record<string, unknown>)[key]);
    const empty =
      typeof x === "object" &&
      x !== null &&
      !Array.isArray(x) &&
      Object.keys(x).length === 0;
    if (!empty) out[key] = x;
  }
  return out;
}

function omit(v: unknown, keys: string[]): Record<string, unknown> {
  const out = { ...record(v) };
  for (const key of keys) delete out[key];
  return out;
}

/** Rule entries without the severities `severities` ranks; options stay. */
function withoutLevels(
  rules: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rule, v] of Object.entries(rules)) {
    if (level(v) === undefined) out[rule] = v;
    else if (typeof v !== "string") out[rule] = omit(v, ["level"]);
  }
  return out;
}

/**
 * A Biome rules object without what `ruleSeverities` and the preset rank. A
 * group set as a whole (`security: "off"`) is not ranked, so it stays.
 */
function unrankedRules(
  rules: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [group, entries] of Object.entries(rules)) {
    if (group === "recommended" && typeof entries === "boolean") continue;
    if (group === "preset") {
      if (typeof entries !== "string" || PRESET[entries] === undefined)
        out[group] = entries;
      continue;
    }
    const isGroup =
      typeof entries === "object" &&
      entries !== null &&
      !Array.isArray(entries);
    out[group] = isGroup ? withoutLevels(record(entries)) : entries;
  }
  return out;
}

function unrankedLinter(linter: unknown): Record<string, unknown> {
  const own = omit(linter, ["enabled", "includes", "rules"]);
  return { ...own, rules: unrankedRules(record(record(linter).rules)) };
}

/** A Biome configuration without the settings `biomeStrictness` ranks. */
function biomeUnranked(doc: Record<string, unknown>): unknown {
  const plugins = (Array.isArray(doc.plugins) ? doc.plugins : []).map((p) =>
    typeof p === "string" ? {} : omit(p, ["path", "includes"]),
  );
  const overrides = (Array.isArray(doc.overrides) ? doc.overrides : []).map(
    (o) => ({
      at: record(o).includes,
      rest: {
        ...omit(o, ["includes", "linter"]),
        linter: unrankedLinter(record(o).linter),
      },
    }),
  );
  return {
    ...omit(doc, ["linter", "files", "plugins", "overrides"]),
    linter: unrankedLinter(doc.linter),
    files: omit(doc.files, ["includes"]),
    plugins: plugins.map(pruned).filter((p) => Object.keys(record(p)).length),
    overrides: overrides.filter(
      (o) => Object.keys(record(pruned(o.rest))).length,
    ),
  };
}

/**
 * The lists of a Biome configuration whose order decides what is checked:
 * the include patterns, where a later pattern overrides an earlier one, and
 * the overrides, where a later one wins for the files both cover. Ranking
 * reads their entries, not their order, so the order is compared on its own.
 */
export function ordering(
  kind: ConfigFile["kind"],
  tree: string,
  path: string,
): Map<string, string[]> | undefined {
  const text = kind === "biome" ? readable(tree, path) : undefined;
  if (text === undefined) return undefined;
  const doc = record(parseJsonc(text));
  const patterns = (v: unknown) =>
    (Array.isArray(v) ? v : []).filter(
      (p): p is string => typeof p === "string",
    );
  const out = new Map<string, string[]>([
    ["files.includes", patterns(record(doc.files).includes)],
    ["linter.includes", patterns(record(doc.linter).includes)],
    [
      "overrides",
      // Each override whole: two that cover the same files differ by what
      // they set, and swapping them changes which one wins.
      (Array.isArray(doc.overrides) ? doc.overrides : []).map(canonical),
    ],
  ]);
  for (const p of Array.isArray(doc.plugins) ? doc.plugins : [])
    if (typeof record(p).path === "string")
      out.set(
        `plugins[${pluginName(String(record(p).path))}].includes`,
        patterns(record(p).includes),
      );
  return out;
}

/**
 * The lists whose shared entries stand in another order in head than in
 * base. Entries added or removed are ranked; moving one may change which
 * files a pattern or an override decides, so it counts as a loosening.
 */
export function reordered(
  base: Map<string, string[]>,
  head: Map<string, string[]>,
): string[] {
  const out: string[] = [];
  for (const [list, before] of base) {
    const after = head.get(list) ?? [];
    const shared = (xs: string[], other: string[]) =>
      xs.filter((x) => other.includes(x));
    const a = shared(before, after);
    const b = shared(after, before);
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) out.push(list);
  }
  return out;
}

/**
 * Everything a configuration file sets that `strictness` does not rank, as
 * one comparable string: a compiler configuration's other options and the
 * files it covers, a linter's ignore and file settings, a rule's options. A
 * change here may narrow what is checked without lowering any rank.
 */
export function unranked(
  kind: ConfigFile["kind"],
  tree: string,
  path: string,
): string | undefined {
  const text = readable(tree, path);
  if (text === undefined) return undefined;
  if (kind === "tsconfig") {
    const t = tsconfigResolved(tree, path);
    return JSON.stringify(
      pruned({ options: omit(t.options, STRICTNESS_FLAGS), scope: t.scope }),
    );
  }
  const doc = record(parseJsonc(text));
  if (kind === "biome") return JSON.stringify(pruned(biomeUnranked(doc)));
  return JSON.stringify(
    pruned({ ...doc, rules: withoutLevels(record(doc.rules)) }),
  );
}

/**
 * The rank a setting has where it is not named: an override's setting falls
 * back to the same setting outside the override.
 */
function fallback(
  settings: Map<string, number>,
  setting: string,
): number | undefined {
  const at = setting.indexOf("@");
  return at < 0 || setting.startsWith("includes[")
    ? undefined
    : settings.get(setting.slice(0, at));
}

/** A plugin's file scope is compared only while the plugin itself is. */
function owner(setting: string): string | undefined {
  return /^includes\[(plugin:.*)\]:/.exec(setting)?.[1];
}

/**
 * Settings set less strictly in head than in base. A rule the head turns off
 * that the base never named counts too: naming a rule only to switch it off
 * is never a tightening. So does an override that sets a rule below the rank
 * it has outside the override.
 */
export function loosened(
  base: Map<string, number>,
  head: Map<string, number>,
): string[] {
  const lower = [...base]
    .filter(([setting, rank]) => {
      // A removed plugin is reported once, as the plugin.
      const parent = owner(setting);
      if (parent !== undefined && !head.has(parent)) return false;
      return (head.get(setting) ?? fallback(head, setting) ?? 0) < rank;
    })
    .map(([setting]) => setting);
  const added = [...head]
    .filter(([setting, rank]) => {
      if (base.has(setting)) return false;
      const parent = owner(setting);
      if (parent !== undefined && !base.has(parent)) return false;
      const was = fallback(base, setting);
      return rank === 0 || (was !== undefined && rank < was);
    })
    .map(([setting]) => setting);
  return [...lower, ...added];
}
