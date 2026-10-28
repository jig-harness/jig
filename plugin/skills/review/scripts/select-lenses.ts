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
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
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

function options(args: string[]): Options {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const flags = args.filter((arg) => arg.startsWith("--"));
  const unknown = flags.filter(
    (flag) => flag !== "--json" && !/^--lens=.+/.test(flag),
  );
  const [files, diff] = positional;
  if (
    positional.length !== 2 ||
    files === undefined ||
    diff === undefined ||
    unknown.length
  )
    fail(2, USAGE);
  return {
    files,
    diff,
    json: flags.includes("--json"),
    forced: flags.filter((f) => f.startsWith("--lens=")).map((f) => f.slice(7)),
  };
}

/** The lens directory, which must stay inside the base snapshot. */
function lensDir(root: string, dir: string): string {
  const absolute = resolve(root, dir);
  const real = existsSync(absolute) ? realpathSync(absolute) : absolute;
  const part = relative(realpathSync(root), real);
  if (
    isAbsolute(dir) ||
    part === ".." ||
    part.startsWith(`..${sep}`) ||
    isAbsolute(part)
  )
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
      : readLensDir(lensDir(root, config.dir), "repository")),
  ];
  const seen = new Set<string>();
  for (const lens of lenses) {
    if (seen.has(lens.id))
      throw new LensConfigError(`two lens files carry the id ${lens.id}`);
    seen.add(lens.id);
  }
  return lenses;
}

function select(opts: Options): Selection {
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
        : proposed(root, config.dir, files).map(proposedLens)),
    ],
  };
}

async function main(): Promise<number> {
  const opts = options(process.argv.slice(2));
  let selection: Selection;
  try {
    selection = select(opts);
  } catch (error) {
    if (
      error instanceof LensConfigError ||
      error instanceof DiffError ||
      error instanceof EffectiveDiffError
    )
      fail(
        2,
        `select-lenses: ${error instanceof LensConfigError ? "configuration error: " : ""}${error.message}`,
      );
    throw error;
  }
  process.stdout.write(
    opts.json
      ? `${JSON.stringify(selection, null, 2)}\n`
      : renderSelection(selection),
  );
  return 0;
}

if (import.meta.main) runMain("select-lenses", main);
