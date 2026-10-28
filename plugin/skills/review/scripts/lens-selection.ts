/**
 * Which review lenses a change selects: a lens runs when a changed file
 * matches its paths and none of its excludes, and, when it gives line
 * patterns, an added or removed line of such a file matches one. Selection
 * errs towards running: a lens that runs with nothing to find reports
 * nothing, while one that is skipped finds nothing in silence.
 */
import { isRecord } from "../../../shared/guards.ts";
import type { FileLines } from "./diff-lines.ts";
import {
  compilePattern,
  type Lens,
  LensConfigError,
  onlyKeys,
  stringList,
  type Trigger,
  TRIGGER_KEYS,
  triggerOf,
} from "./lens-file.ts";

/** `review.lenses` from the base branch's configuration. */
export interface LensConfig {
  dir: string | null;
  off: string[];
  triggers: Record<string, Trigger>;
}

export function parseLensConfig(value: unknown): LensConfig {
  if (value === undefined || value === null)
    return { dir: null, off: [], triggers: {} };
  const where = "review.lenses";
  if (!isRecord(value)) throw new LensConfigError(`${where} must be a mapping`);
  onlyKeys(value, ["dir", "off", "triggers"], where);
  if (
    value.dir !== undefined &&
    (typeof value.dir !== "string" || value.dir.trim() === "")
  )
    throw new LensConfigError(`${where}.dir must be a path`);
  const triggers = value.triggers ?? {};
  if (!isRecord(triggers))
    throw new LensConfigError(
      `${where}.triggers must map lens ids to triggers`,
    );
  return {
    dir: typeof value.dir === "string" ? value.dir : null,
    off: stringList(value.off, `${where}.off`),
    triggers: Object.fromEntries(
      Object.entries(triggers).map(([id, trigger]) => [
        id,
        triggerOf(trigger, `${where}.triggers.${id}`),
      ]),
    ),
  };
}

/** Where a lens matched: the path, and the line when its trigger has line patterns. */
export interface Match {
  path: string;
  line?: number;
  side?: "added" | "removed";
  pattern?: string;
}

export interface LensResult {
  /** Null for a lens the change proposes, which has no base version to read. */
  id: string | null;
  version: number | null;
  source: Lens["source"];
  file: string;
  runs: boolean;
  reason: string;
  match?: Match;
}

export interface Selection {
  lenses: LensResult[];
}

/** Refuse an id that names no lens: a mistyped id would otherwise do nothing. */
export function requireKnownIds(
  lenses: readonly Lens[],
  config: LensConfig,
  forced: readonly string[],
): void {
  const known = new Set(lenses.map((lens) => lens.id));
  const named: [string, readonly string[]][] = [
    ["review.lenses.off", config.off],
    ["review.lenses.triggers", Object.keys(config.triggers)],
    ["--lens", forced],
  ];
  for (const [where, ids] of named)
    for (const id of ids)
      if (!known.has(id))
        throw new LensConfigError(
          `${where} names ${id}, which is no lens (known: ${[...known].join(", ") || "none"})`,
        );
}

function merged(lens: Lens, extra: Trigger | undefined): Trigger {
  return Object.fromEntries(
    TRIGGER_KEYS.map((key) => [
      key,
      [...lens.trigger[key], ...(extra?.[key] ?? [])],
    ]),
  ) as Trigger;
}

function lineMatch(
  path: string,
  lines: FileLines | undefined,
  side: "added" | "removed",
  patterns: readonly RegExp[],
): Match | null {
  for (const line of lines?.[side] ?? [])
    for (const pattern of patterns)
      if (pattern.test(line.text))
        return { path, line: line.number, side, pattern: pattern.source };
  return null;
}

/** The first path, and line where the trigger asks for one, that matches. */
export function firstMatch(
  trigger: Trigger,
  where: string,
  files: readonly string[],
  diff: ReadonlyMap<string, FileLines>,
): Match | null {
  const globs = (list: string[]) => list.map((glob) => new Bun.Glob(glob));
  const paths = globs(trigger.paths);
  const exclude = globs(trigger.exclude);
  const added = trigger.added_lines.map((p) => compilePattern(p, where));
  const removed = trigger.removed_lines.map((p) => compilePattern(p, where));
  for (const path of files) {
    if (!paths.some((g) => g.match(path)) || exclude.some((g) => g.match(path)))
      continue;
    if (added.length === 0 && removed.length === 0) return { path };
    const match =
      lineMatch(path, diff.get(path), "added", added) ??
      lineMatch(path, diff.get(path), "removed", removed);
    if (match) return match;
  }
  return null;
}

function describeMatch(match: Match): string {
  return match.line === undefined
    ? `${match.path} matched`
    : `${match.path}:${match.line} ${match.side} line matches ${match.pattern}`;
}

/** One lens's result: forced by `--lens`, off, matched, or no trigger matched. */
export function selectLens(
  lens: Lens,
  config: LensConfig,
  forced: boolean,
  files: readonly string[],
  diff: ReadonlyMap<string, FileLines>,
): LensResult {
  const base = {
    id: lens.id,
    version: lens.version,
    source: lens.source,
    file: lens.file,
  };
  const off = config.off.includes(lens.id);
  const match =
    off && !forced
      ? null
      : firstMatch(
          merged(lens, config.triggers[lens.id]),
          lens.file,
          files,
          diff,
        );
  if (match)
    return { ...base, runs: true, reason: describeMatch(match), match };
  if (forced) return { ...base, runs: true, reason: "--lens" };
  return { ...base, runs: false, reason: off ? "off" : "no trigger matched" };
}

/** A lens file the change adds: reviewed as part of the diff, never run. */
export function proposedLens(path: string): LensResult {
  return {
    id: null,
    version: null,
    source: "repository",
    file: path,
    runs: false,
    reason: "proposed",
  };
}

export function lensLabel(result: LensResult): string {
  return result.id === null ? result.file : `${result.id}@${result.version}`;
}

/** One line per lens: whether it runs, the lens, and why. */
export function renderSelection(selection: Selection): string {
  return selection.lenses
    .map(
      (lens) =>
        `${lens.runs ? "run " : "skip"}  ${lensLabel(lens)}  ${lens.reason}\n`,
    )
    .join("");
}
