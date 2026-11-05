#!/usr/bin/env bun
/**
 * Select the review lenses a change gives something to check.
 *
 *   bun select-lenses.ts <effective-files> <effective-diff> [--json] [--lens=<id>]...
 *
 * `<effective-files>` is the NUL-separated list of changed paths and
 * `<effective-diff>` the diff `review`'s setup writes. Run it inside the base
 * snapshot with the enumerated environment: the configuration
 * (`review.lenses`) and the repository's lens directory are read from there,
 * the seed lenses from the plugin. A lens file the change adds is reported
 * as `proposed` and never run. Prints one line per lens (whether it runs and
 * why), or the same as JSON with `--json`. `--lens=<id>` runs a lens whatever
 * its trigger or `off` says.
 *
 * Exit 0 with the selection; 2 on a configuration or usage error, named on
 * stderr, so a mistyped id or pattern stops the review instead of doing
 * nothing.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fail, runMain } from "../../../shared/cli.ts";
import { consumerRoot, readConfig } from "../../../shared/consumer.ts";
import { isRecord } from "../../../shared/guards.ts";
import { DiffError, diffLines } from "./diff-lines.ts";
import { EffectiveDiffError, nulSeparated } from "./effective-diff.ts";
import {
  isLensFileName,
  type Lens,
  LensConfigError,
  readLensDir,
} from "./lens-file.ts";
import {
  type LensConfig,
  parseLensConfig,
  proposedLens,
  renderSelection,
  requireKnownIds,
  type Selection,
  selectLens,
} from "./lens-selection.ts";

/** The seed lenses the plugin ships. */
const SEED_DIR = join(import.meta.dir, "../lenses");
const USAGE =
  "usage: select-lenses.ts <effective-files> <effective-diff> [--json] [--lens=<id>]...";

interface Options {
  files: string;
  diff: string;
  json: boolean;
  forced: string[];
}

/** The command line, or null when it is not one this script takes. */
export function options(args: string[]): Options | null {
  const [files, diff, ...rest] = args.filter((arg) => !arg.startsWith("--"));
  const flags = args.filter((arg) => arg.startsWith("--"));
  const known = flags.every(
    (flag) => flag === "--json" || /^--lens=.+/.test(flag),
  );
  if (files === undefined || diff === undefined || rest.length || !known)
    return null;
  return {
    files,
    diff,
    json: flags.includes("--json"),
    forced: flags.filter((f) => f.startsWith("--lens=")).map((f) => f.slice(7)),
  };
}

function escapes(part: string): boolean {
  return part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part);
}

/** The lens directory, which must stay inside the base snapshot. */
function lensDir(root: string, dir: string): string {
  const absolute = resolve(root, dir);
  // A directory that does not exist yet is resolved from its nearest
  // existing ancestor, so a link above it is followed like any other.
  let existing = absolute;
  while (!existsSync(existing)) existing = dirname(existing);
  const real = resolve(realpathSync(existing), relative(existing, absolute));
  if (isAbsolute(dir) || escapes(relative(realpathSync(root), real)))
    throw new LensConfigError(
      `review.lenses.dir must stay inside the repository: ${dir}`,
    );
  return absolute;
}

/** The changed paths that are lens files the base does not hold. */
function proposed(
  root: string,
  dir: string,
  files: readonly string[],
): string[] {
  const folder = posix.normalize(dir.replaceAll("\\", "/")).replace(/\/$/, "");
  return files.filter(
    (file) =>
      posix.dirname(file) === folder &&
      isLensFileName(posix.basename(file)) &&
      !existsSync(join(root, file)),
  );
}

function allLenses(root: string, config: LensConfig): Lens[] {
  const lenses = [
    ...readLensDir(SEED_DIR, "seed"),
    ...(config.dir === null
      ? []
      : readLensDir(lensDir(root, config.dir), "repository", root)),
  ];
  const seen = new Set<string>();
  for (const lens of lenses) {
    if (seen.has(lens.id))
      throw new LensConfigError(`two lens files carry the id ${lens.id}`);
    seen.add(lens.id);
  }
  return lenses;
}

/**
 * Refuse a `review.lenses` section that review would stop on: a malformed
 * entry, an unreadable lens file, or an id that names no lens.
 */
export function checkLensConfig(root: string, review: unknown): void {
  const config = parseLensConfig(isRecord(review) ? review.lenses : undefined);
  requireKnownIds(allLenses(root, config), config, []);
}

export function select(opts: Options): Selection {
  const files = nulSeparated(readFileSync(opts.files, "utf8"));
  const diff = diffLines(readFileSync(opts.diff, "utf8"), new Set(files));
  const review = readConfig().review;
  const config = parseLensConfig(isRecord(review) ? review.lenses : undefined);
  const root = consumerRoot();
  const lenses = allLenses(root, config);
  requireKnownIds(lenses, config, opts.forced);
  return {
    lenses: [
      ...lenses.map((lens) =>
        selectLens(lens, config, opts.forced.includes(lens.id), files, diff),
      ),
      ...(config.dir === null
        ? []
        : proposed(root, config.dir, files).map((path) => proposedLens(path))),
    ],
  };
}

/** What a failure to select says, or null for one that is not the input's fault. */
export function refusal(error: unknown): string | null {
  if (error instanceof LensConfigError)
    return `select-lenses: configuration error: ${error.message}`;
  if (error instanceof DiffError || error instanceof EffectiveDiffError)
    return `select-lenses: ${error.message}`;
  return null;
}

function selectOrFail(opts: Options): Selection {
  try {
    return select(opts);
  } catch (error) {
    const message = refusal(error);
    if (message) fail(2, message);
    throw error;
  }
}

async function main(): Promise<number> {
  const opts = options(process.argv.slice(2)) ?? fail(2, USAGE);
  const selection = selectOrFail(opts);
  process.stdout.write(
    opts.json
      ? `${JSON.stringify(selection, null, 2)}\n`
      : renderSelection(selection),
  );
  return 0;
}

if (import.meta.main) runMain("select-lenses", main);
