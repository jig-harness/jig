#!/usr/bin/env bun
/**
 * Record an item's predicted footprint, the paths its change is expected to
 * touch, as a `tracker-footprint` record on the item.
 *
 * Usage:
 *     bun write-footprint.ts <issue-key> --source <pickup|scout|filing>
 *         (--paths <file> | --diff) [--base <ref>] [--dry-run]
 *
 * `--paths` names a file of repository paths, one per line (a directory ends
 * in `/`, or is one in the working tree; blank lines and `#` comments are
 * skipped). `--diff` takes the workspace's change against the base instead,
 * tracked and untracked, as `change-areas`' resolver reads it. `--base` is
 * the ref the prediction read, `<remote>/<base branch>` by default; its
 * commit is recorded. The areas are the catalog areas the paths' files match
 * directly. A changed file whose name a footprint cannot carry (a glob
 * character) stands as its nearest parent directory that it can. A `pickup`
 * record names the session it runs in, as the claim
 * marker does. `--dry-run` prints the payload and writes nothing; the
 * payload is also valid input to `tracker.ts footprint <KEY> --input`.
 *
 * Exits: 0 written (or printed); 2 usage, or a path or base it cannot use,
 * nothing written; 3 no path to record, nothing written; 1 any other
 * failure; 5 to 11 a failed call to the tracker, by its failure class, as
 * `tracker.ts` exits.
 */
import { readFile } from "node:fs/promises";
import { consumerRoot, remoteName } from "../../../shared/consumer.ts";
import { recordKind } from "../../../shared/records/registry.ts";
import {
  baseBranch,
  baseBranchUnknown,
} from "../../drive-pr/scripts/lib/overlay.ts";
import { defaultGitRunner } from "../../change-areas/scripts/lib/resolve.ts";
import { parseArgs, runEntry } from "./lib/cli.ts";
import { claimSession } from "./lib/claim-marker.ts";
import { ownCatalog, predictionRecord } from "./lib/footprint-ops.ts";
import {
  type Prediction,
  PredictionError,
  predictFootprint,
  WRITER_SOURCES,
  type WriterSource,
} from "./lib/footprint-writer.ts";
import { openTracker } from "./lib/tracker/index.ts";
import type { Tracker } from "./lib/tracker/port.ts";
import { failureExit } from "./tracker.ts";

const USAGE =
  "usage: write-footprint.ts <issue-key> --source <pickup|scout|filing> (--paths <file> | --diff) [--base <ref>] [--dry-run]";
const PATHS_LIMIT = 2_000_000;

export interface WriteDeps {
  tracker: () => Pick<Tracker, "writeFootprint">;
  readPaths: (path: string) => Promise<string>;
  defaultBase: () => Promise<string>;
  predict: typeof predictFootprint;
  root: () => string;
}

async function readPathsFile(path: string): Promise<string> {
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > PATHS_LIMIT)
    throw new PredictionError(
      "input",
      "the paths file exceeds 2,000,000 bytes",
    );
  return text;
}

async function defaultBaseRef(): Promise<string> {
  const root = consumerRoot();
  const remote = remoteName(root);
  const branch = await baseBranch(root, 30);
  if (branch === null)
    throw new PredictionError("input", baseBranchUnknown(remote));
  return `${remote}/${branch}`;
}

const defaultDeps: WriteDeps = {
  tracker: openTracker,
  readPaths: readPathsFile,
  defaultBase: defaultBaseRef,
  predict: predictFootprint,
  root: consumerRoot,
};

function usage(message: string): number {
  console.error(message.includes("usage:") ? message : `${message}\n${USAGE}`);
  return 2;
}

export async function main(
  argv: string[],
  deps: WriteDeps = defaultDeps,
): Promise<number> {
  const parsed = parseArgs(argv, {
    flags: ["diff", "dry-run"],
    values: ["source", "paths", "base"],
    usage: USAGE,
  });
  if (!parsed.ok) return usage(parsed.message);
  const { flags, values, positional: key } = parsed.args;
  if (!recordKind("tracker-footprint")?.key?.test(key))
    return usage(`expected an item key like #123 or ENG-123, got ${key}`);
  const source = values.get("source");
  if (!WRITER_SOURCES.includes(source as WriterSource))
    return usage("--source must be pickup, scout or filing");
  const pathsFile = values.get("paths");
  if ((pathsFile === undefined) === !flags.has("diff"))
    return usage("give exactly one of --paths <file> and --diff");
  let prediction: Prediction;
  try {
    const baseRef = values.get("base") ?? (await deps.defaultBase());
    const paths =
      pathsFile === undefined
        ? ("diff" as const)
        : { list: await deps.readPaths(pathsFile) };
    const root = deps.root();
    prediction = deps.predict(
      { key, source: source as WriterSource, baseRef, paths },
      {
        git: defaultGitRunner,
        catalog: ownCatalog,
        session: () => claimSession(),
        root,
      },
    );
  } catch (error) {
    if (!(error instanceof PredictionError)) {
      console.error(
        `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
    console.error(error.message);
    return error.code === "nothing" ? 3 : 2;
  }
  if (flags.has("dry-run")) {
    console.log(JSON.stringify(prediction, null, 2));
    return 0;
  }
  try {
    const record = predictionRecord(key, prediction);
    await deps.tracker().writeFootprint(record);
  } catch (error) {
    const { code, line } = failureExit(error);
    console.error(line);
    return code;
  }
  console.log(
    JSON.stringify({
      issue: key,
      written: true,
      source: prediction.source,
      base: prediction.base,
      paths: prediction.paths.length,
      areas: prediction.areas,
    }),
  );
  return 0;
}

if (import.meta.main) runEntry(() => main(process.argv.slice(2)));
