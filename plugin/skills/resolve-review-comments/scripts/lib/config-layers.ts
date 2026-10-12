/**
 * Jig's configuration, read in layers.
 *
 * One repository's values belong in its own `.config/jig.yaml`, but some
 * values belong to a person or a machine instead (a folder shared by every
 * repository, a personal default), and some to a single run. Each of those
 * is a layer; a higher layer overrides a lower one, key by key:
 *
 *   1. user         `~/.jig/jig.yaml` (`JIG_HOME` moves `~/.jig`)
 *   2. repository   `.config/jig.yaml` at the repository root (`JIG_OVERLAY`
 *                   names another file instead)
 *   3. environment  `JIG__<SECTION>__<FIELD>=<value>` variables
 *
 * Mappings merge key by key; any other value (text, number, list, null)
 * replaces the lower layer's value whole, so a list is never half one
 * layer's and half another's. Command-line flags, where a script has them,
 * override all three.
 *
 * A few fields describe one repository (its gate command, its base branch,
 * its tracker team). Set in the user layer they would apply to every
 * repository on the machine, which is never what was meant, so the user layer
 * refuses them; the environment layer may still override them for one run.
 *
 * `JIG_USER_LAYER=off` leaves the user layer out entirely, for a command
 * whose policy must come from one repository's file alone (an independent
 * review reading the base branch's snapshot).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { load } from "./yaml.ts";

/** The repository layer's file, relative to the repository root. */
export const OVERLAY_RELPATH = ".config/jig.yaml";

/** The user layer's file name, inside the Jig home directory. */
export const USER_CONFIG_FILE = "jig.yaml";

/** The prefix of an environment-layer variable; `__` separates the levels. */
export const ENV_PREFIX = "JIG__";

/** Set to `off`, the user layer is not read. */
export const USER_LAYER_SWITCH = "JIG_USER_LAYER";

/** Fields only a repository (or one run) may set; the user layer refuses them. */
export const REPOSITORY_ONLY_FIELDS: readonly string[] = [
  "gates.command",
  "repository.base_branch",
  "issue_tracker.team",
  "review.repo_slug",
  "review.repo_label",
  "ci.required_checks",
];

export type LayerName = "user" | "repository" | "environment";

export interface ConfigLayer {
  name: LayerName;
  /** The file the layer came from; for the environment, `environment`. */
  source: string;
  /** Environment layer only: the variable that set each dotted field. */
  variables?: Record<string, string>;
  values: Record<string, unknown>;
}

export interface LayeredConfig {
  /** Every layer merged. */
  values: Record<string, unknown>;
  /** The layers that are present, lowest first. */
  layers: ConfigLayer[];
  /** The repository layer's path, whether or not the file exists. */
  repositoryPath: string;
  /** Whether the repository layer's file exists. */
  hasRepository: boolean;
}

type Env = Record<string, string | undefined>;

/**
 * A mapping: a plain object, as YAML builds one. A list is not, and neither
 * is a `Date`, which YAML builds from an unquoted timestamp
 * (`drive: 2026-10-12`); both are values that replace a lower layer's whole.
 */
export function isMapping(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** The Jig home directory: `JIG_HOME`, else `~/.jig`. */
export function jigHome(env: Env = process.env): string {
  const explicit = nonEmpty(env.JIG_HOME);
  return explicit === undefined ? join(homedir(), ".jig") : resolve(explicit);
}

/** The user layer's file. */
export function userConfigPath(env: Env = process.env): string {
  return join(jigHome(env), USER_CONFIG_FILE);
}

/** Whether the user layer is read: always, unless `JIG_USER_LAYER=off`. */
export function userLayerEnabled(env: Env = process.env): boolean {
  const value = nonEmpty(env[USER_LAYER_SWITCH])?.trim();
  if (value === undefined) return true;
  if (value === "off") return false;
  throw new Error(
    `${USER_LAYER_SWITCH} must be off or unset (got ${JSON.stringify(value)})`,
  );
}

/**
 * The repository layer's file: `JIG_OVERLAY` when set, else
 * `.config/jig.yaml` under `root`.
 */
export function repositoryConfigPath(
  root: string,
  env: Env = process.env,
): string {
  return nonEmpty(env.JIG_OVERLAY) ?? join(root, OVERLAY_RELPATH);
}

/**
 * A field path for a message: segments joined by `.`, a segment that holds
 * anything but letters, digits, `_` and `-` written as a JSON string
 * (`do_item.agents.title_keywords."node.js"`), so the path reads back
 * unambiguously with `parseField`.
 */
export function formatField(path: readonly string[]): string {
  return path
    .map((key) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)))
    .join(".");
}

/** The segment of `field` that starts at `start`, and where it ends. */
function readSegment(field: string, start: number): [string, number] {
  if (field[start] !== '"') {
    const end = field.indexOf(".", start);
    const stop = end === -1 ? field.length : end;
    return [field.slice(start, stop), stop];
  }
  const match = /^"(?:[^"\\]|\\.)*"/.exec(field.slice(start));
  if (match === null) throw new Error(`unterminated quote in field ${field}`);
  const segment: unknown = JSON.parse(match[0]);
  if (typeof segment !== "string")
    throw new Error(`invalid quoted key in field ${field}`);
  return [segment, start + match[0].length];
}

/** The segments of a field written as `formatField` writes it. */
export function parseField(field: string): string[] {
  const path: string[] = [];
  let i = 0;
  while (i < field.length) {
    const [segment, end] = readSegment(field, i);
    path.push(segment);
    i = end;
    if (i === field.length) break;
    if (field[i] !== ".") throw new Error(`malformed field ${field}`);
    i++;
    if (i === field.length) path.push("");
  }
  return path;
}

function toPath(field: string | readonly string[]): readonly string[] {
  return typeof field === "string" ? parseField(field) : field;
}

/**
 * The most values one configuration layer may hold when every alias is
 * expanded: a file, or the environment's variables taken together. Every
 * reader walks the expanded, merged form, so this bounds each of them.
 */
export const MAX_CONFIG_VALUES = 10_000;

/**
 * Refuse what a configuration value must not hold: a `__proto__` key, which
 * an assignment would take as the object's prototype rather than a field;
 * a mapping or list that contains itself (a recursive YAML alias), which no
 * reader could walk to an end; and more than `MAX_CONFIG_VALUES` values once
 * aliases are expanded, which a few lines of aliases that each repeat the one
 * before reach. A value shared by two fields (an ordinary alias) is fine.
 */
function checkShape(value: unknown, source: string): void {
  const open = new Set<object>();
  let count = 0;
  const walk = (node: unknown, path: string[]): void => {
    count += 1;
    if (count > MAX_CONFIG_VALUES)
      throw new Error(
        `Jig configuration holds more than ${MAX_CONFIG_VALUES} values with its aliases expanded: ${source}`,
      );
    if (typeof node !== "object" || node === null) return;
    if (open.has(node))
      throw new Error(
        `Jig configuration must not contain itself: ${formatField(path)} in ${source}`,
      );
    open.add(node);
    if (Array.isArray(node))
      node.forEach((item, i) => {
        walk(item, [...path, String(i)]);
      });
    else
      for (const key of Object.keys(node)) {
        if (key === "__proto__")
          throw new Error(
            `__proto__ is not a configuration field: ${formatField([...path, key])} in ${source}`,
          );
        walk((node as Record<string, unknown>)[key], [...path, key]);
      }
    open.delete(node);
  };
  walk(value, []);
}

/**
 * One layer's file, parsed; `null` when it does not exist. An empty file is
 * an empty mapping. A file that cannot be parsed, that holds anything but
 * a mapping, or whose shape `checkShape` refuses is an error naming the file.
 */
export function readConfigFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = load(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `Jig configuration could not be parsed: ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isMapping(parsed))
    throw new Error(`Jig configuration must be a mapping: ${path}`);
  checkShape(parsed, path);
  return parsed;
}

/**
 * The value at a field, or `undefined`: a dotted field (see `parseField`) or
 * its segments.
 */
export function valueAt(
  values: Record<string, unknown>,
  field: string | readonly string[],
): unknown {
  let current: unknown = values;
  for (const key of toPath(field)) {
    if (!isMapping(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function refuseRepositoryOnly(
  values: Record<string, unknown>,
  path: string,
): void {
  for (const field of REPOSITORY_ONLY_FIELDS)
    if (valueAt(values, field) !== undefined)
      throw new Error(
        `${field} describes one repository, so ${path} cannot set it: set it in the repository's ${OVERLAY_RELPATH}`,
      );
}

/**
 * An environment variable's value. A list or mapping in YAML flow form
 * (`[a, b]`, `{k: v}`), `true`, `false`, `null` and decimal numbers
 * (`400`, `+400`, `-0.5`, `.5`, `1e3`) take their YAML type, and a value in quotes (`"true"`, `'1.10'`) is the text inside them;
 * anything else is text as written, so a command such as
 * `bun run gates: all` is not misread as a mapping. A value that takes the
 * wrong type for its field is refused by the field's own check, which names
 * the variable; quoting it keeps it text.
 */
function environmentValue(name: string, raw: string): unknown {
  const text = raw.trim();
  const quoted = /^(?:"[\s\S]*"|'[\s\S]*')$/.test(text);
  const typed =
    quoted ||
    text.startsWith("[") ||
    text.startsWith("{") ||
    /^(?:true|false|null|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)$/.test(
      text,
    );
  if (!typed) return raw;
  let value: unknown;
  try {
    value = load(text);
  } catch (err) {
    throw new Error(
      `${name} could not be parsed: ${err instanceof Error ? err.message : String(err)}; quote the value to keep it text`,
    );
  }
  if (quoted && typeof value !== "string")
    throw new Error(
      `${name} must be one quoted text value: put quotes around the whole value`,
    );
  checkShape(value, name);
  return value;
}

/** The lowercased levels a `JIG__<SECTION>__<FIELD>` variable names. */
function environmentKeys(name: string): string[] {
  const keys = name.slice(ENV_PREFIX.length).toLowerCase().split("__");
  if (keys.some((key) => !/^[a-z0-9_]+$/.test(key)))
    throw new Error(
      `${name} is not a configuration field: write JIG__<SECTION>__<FIELD>, levels separated by two underscores`,
    );
  return keys;
}

/**
 * Each variable sets its field whole, so one that names a field inside
 * another's (or the same field, in other letter case) is refused whatever
 * the other's value is.
 */
function refuseOverlap(
  name: string,
  field: string,
  variables: Record<string, string>,
): void {
  for (const [set, other] of Object.entries(variables))
    if (
      set === field ||
      set.startsWith(`${field}.`) ||
      field.startsWith(`${set}.`)
    )
      throw new Error(
        `${name} and ${other} both set ${set.length < field.length ? set : field}: set a value or the fields inside it, not both`,
      );
}

/** Set `value` at `keys` in `values`, creating the mappings on the way. */
function setAt(
  values: Record<string, unknown>,
  keys: readonly string[],
  value: unknown,
): void {
  let target = values;
  for (const key of keys.slice(0, -1)) {
    if (!Object.hasOwn(target, key)) target[key] = {};
    target = target[key] as Record<string, unknown>;
  }
  target[keys[keys.length - 1] as string] = value;
}

/**
 * The environment layer: every nonempty `JIG__<SECTION>__<FIELD>` variable,
 * the levels lowercased (`JIG__ISSUE_TRACKER__TEAM` sets
 * `issue_tracker.team`). `null` when no such variable is set.
 */
export function environmentLayer(env: Env = process.env): ConfigLayer | null {
  const values: Record<string, unknown> = {};
  const variables: Record<string, string> = {};
  const names = Object.keys(env)
    .filter((name) => name.startsWith(ENV_PREFIX))
    .sort();
  for (const name of names) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;
    const keys = environmentKeys(name);
    const field = keys.join(".");
    refuseOverlap(name, field, variables);
    setAt(values, keys, environmentValue(name, raw));
    variables[field] = name;
  }
  if (Object.keys(variables).length === 0) return null;
  // Each variable passed on its own; the layer they make is bounded too.
  checkShape(values, `the ${ENV_PREFIX}* environment variables together`);
  return { name: "environment", source: "environment", variables, values };
}

/** `higher` laid over `lower`: mappings merge, anything else replaces. */
export function mergeLayers(
  lower: Record<string, unknown>,
  higher: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...lower };
  for (const [key, value] of Object.entries(higher)) {
    const below = merged[key];
    merged[key] =
      isMapping(below) && isMapping(value) ? mergeLayers(below, value) : value;
  }
  return merged;
}

/** Every layer for the repository at `root`, read and merged. */
export function loadLayeredConfig(
  root: string,
  env: Env = process.env,
): LayeredConfig {
  const layers: ConfigLayer[] = [];
  const userPath = userConfigPath(env);
  const user = userLayerEnabled(env) ? readConfigFile(userPath) : null;
  if (user !== null) {
    refuseRepositoryOnly(user, userPath);
    layers.push({ name: "user", source: userPath, values: user });
  }
  const repositoryPath = repositoryConfigPath(root, env);
  const repository = readConfigFile(repositoryPath);
  if (repository !== null)
    layers.push({
      name: "repository",
      source: repositoryPath,
      values: repository,
    });
  const environment = environmentLayer(env);
  if (environment !== null) layers.push(environment);
  return {
    values: layers.reduce<Record<string, unknown>>(
      (merged, layer) => mergeLayers(merged, layer.values),
      {},
    ),
    layers,
    repositoryPath,
    hasRepository: repository !== null,
  };
}

/**
 * The highest layer that sets `field` (dotted, or its segments), or
 * `undefined` when none does. A layer sets a field when it holds a value at
 * it, or a non-mapping value at one of its parents.
 */
export function layerOf(
  config: LayeredConfig,
  field: string | readonly string[],
): ConfigLayer | undefined {
  const path = toPath(field);
  for (const layer of [...config.layers].reverse()) {
    let current: unknown = layer.values;
    for (const key of path) {
      if (!isMapping(current)) return layer;
      if (!Object.hasOwn(current, key)) {
        current = undefined;
        break;
      }
      current = current[key];
    }
    if (current !== undefined) return layer;
  }
  return undefined;
}

/**
 * Where `field`'s value came from, for a message: the file that set it, or
 * the environment variable; the repository's file when no layer sets it.
 */
export function sourceOf(
  config: LayeredConfig,
  field: string | readonly string[],
): string {
  // A field no layer sets (a message's path read short, at a key holding a
  // character a plain field cannot) is attributed through the deepest part
  // of it some layer does set.
  let path = toPath(field);
  let layer = layerOf(config, path);
  while (layer === undefined && path.length > 1) {
    path = path.slice(0, -1);
    layer = layerOf(config, path);
  }
  if (layer === undefined) return config.repositoryPath;
  if (layer.name !== "environment") return layer.source;
  const variables = layer.variables ?? {};
  // Environment fields are plain `a.b.c` paths (see `environmentLayer`).
  const dotted = path.join(".");
  const exact = variables[dotted];
  if (exact !== undefined) return `$${exact}`;
  const inside = Object.keys(variables)
    .filter(
      (set) => set.startsWith(`${dotted}.`) || dotted.startsWith(`${set}.`),
    )
    .map((set) => `$${variables[set]}`);
  return inside.length > 0 ? inside.join(", ") : "environment";
}

/**
 * The field a validation message is about, for finding the layer that set
 * it. The configuration's validators open each message with the field at
 * fault (`pull_requests.size_budget must be …`, `decide.policy_files[0]
 * must be …`), a key written as `formatField` writes it; that leading field,
 * list positions dropped, when it lies inside one of `sections`, else the
 * first section.
 */
export function fieldInMessage(
  message: string,
  sections: string | readonly string[],
): string {
  const within = typeof sections === "string" ? [sections] : sections;
  const match =
    /^([A-Za-z0-9_-]+(?:\.(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*")|\[\d+\])*)/.exec(
      message,
    );
  // List positions go; a quoted key is kept verbatim, brackets and all.
  const field = match?.[1]?.replace(/"(?:[^"\\]|\\.)*"|\[\d+\]/g, (token) =>
    token.startsWith('"') ? token : "",
  );
  return field !== undefined &&
    within.some(
      (section) => field === section || field.startsWith(`${section}.`),
    )
    ? field
    : (within[0] as string);
}

/**
 * A key that changes whenever any layer could have: each file's path, size
 * and modification time, and the environment layer's variables. For callers
 * that cache the merged values across many reads.
 */
export function layersFingerprint(
  root: string,
  env: Env = process.env,
): string {
  const stamp = (path: string): string => {
    try {
      const st = statSync(path);
      return `${path}\0${st.size}\0${st.mtimeMs}`;
    } catch {
      return `${path}\0absent`;
    }
  };
  const variables = Object.keys(env)
    .filter((name) => name.startsWith(ENV_PREFIX))
    .sort()
    .map((name) => `${name}=${env[name]}`);
  return [
    `${USER_LAYER_SWITCH}=${env[USER_LAYER_SWITCH] ?? ""}`,
    stamp(userConfigPath(env)),
    stamp(repositoryConfigPath(root, env)),
    ...variables,
  ].join("\n");
}
