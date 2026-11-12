#!/usr/bin/env bun
/**
 * Keep every open issue's type, priority and size where the repository keeps
 * them (design/tracker-facets.md in the Jig repository): the weekly sweep
 * for issues filed without them, and the move from one facet store to
 * another. Run from the repository's root; it reads `.config/jig.yaml`
 * through the plugin's configuration reader and reaches the tracker only
 * through the tracker interface.
 *
 * Usage:
 *     bun check-fields.ts [check] [--yes] [--json]
 *     bun check-fields.ts move --target <file> --record <file> [--json]
 *     bun check-fields.ts move --record <file> [--copy | --retire] [--yes] [--json]
 *     bun check-fields.ts move --restore <file> [--yes] [--json]
 *
 * `check` (the sweep) lists every open issue outside triage that lacks a
 * type, a priority or a size (an epic needs no size) or carries a label of a
 * facet kept elsewhere; with `--yes` it moves each one not yet started back
 * to triage with a comment naming what it lacks, at most 50 a run, and lists
 * the started ones without moving them. It prints issue keys, never a title
 * or a body.
 *
 * `move` previews by default and writes nothing without `--yes`. The preview
 * (`--target` with the `issue_tracker.facets` section the repository will
 * commit) writes the move record: the section in force now and the target.
 * `--copy --yes` sets every open issue's destination from its source;
 * `--retire --yes`, after the target section is committed, takes the source
 * off each issue whose destination holds its value; `--restore <record>
 * --yes` puts back every value the record says the move changed. Each run
 * writes at most one update per open issue, is paced at 30 writes a minute,
 * and is resumed by running it again.
 *
 * Exit codes: 0 done (or nothing left to do; a sweep's report without
 * `--yes` may still name a store problem); 3 the run finished and something
 * is left: an issue for a person, or one the next run finishes (the move),
 * or a phase that refused to start; 1 a read or a write failed, or a store
 * problem kept the sweep from reading anything or, with `--yes`, from moving
 * anything; 2 usage.
 */

import { existsSync, realpathSync, mkdirSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { withFileLock } from "../../../shared/file-lock.ts";
import { parseArgs } from "node:util";
import { ExitError, fail, runMain } from "../../../shared/cli.ts";
import { consumerRoot, readOverlay } from "../../../shared/consumer.ts";
import {
  facetsOf,
  trackerConfigFrom,
} from "../../do-item/scripts/lib/tracker/config.ts";
import { TrackerConfigError } from "../../do-item/scripts/lib/tracker/config-error.ts";
import { openTracker } from "../../do-item/scripts/lib/tracker/index.ts";
import type { Facet } from "../../do-item/scripts/lib/tracker/port.ts";
import {
  copy,
  type MoveReport,
  type MoveSides,
  movedFacets,
  restore,
  retire,
} from "./lib/move.ts";
import {
  MOVE_RECORD_KIND,
  MOVE_RECORD_VERSION,
  type MoveRecord,
  MoveRecordError,
  readMoveRecord,
  writeMoveRecord,
} from "./lib/move-record.ts";
import { moveProblem } from "./lib/move-safety.ts";
import { failureLine, pacedWriter } from "./lib/pace.ts";
import {
  readTarget,
  retiredLabels,
  SectionError,
  sectionInForce,
  storeName,
  withSection,
} from "./lib/sections.ts";
import { sweep, sweepLines } from "./lib/sweep.ts";

const USAGE = `usage:
  check-fields.ts [check] [--yes] [--json] [--retired-from <file>]
  check-fields.ts move --target <file> --record <file> [--json]
  check-fields.ts move --record <file> [--copy | --retire] [--yes] [--json]
  check-fields.ts move --restore <file> [--yes] [--json]`;

function usage(message: string): never {
  return fail(2, message, USAGE);
}

/** Print a report as JSON or as its lines. */
function print(json: boolean, report: unknown, lines: string[]): void {
  console.log(json ? JSON.stringify(report, null, 2) : lines.join("\n"));
}

async function check(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      yes: { type: "boolean" },
      json: { type: "boolean" },
      "retired-from": { type: "string" },
    },
    strict: true,
  });
  const overlay = readOverlay();
  const config = trackerConfigFrom(overlay);
  const root = consumerRoot();
  const tracker = openTracker(config, root);
  const former =
    values["retired-from"] === undefined
      ? undefined
      : readTarget(
          values["retired-from"],
          config.adapter,
          facetsOf(config, root),
        );
  const report = await sweep(tracker, {
    apply: values.yes === true,
    retired: (stores) => retiredLabels(overlay, config, root, stores, former),
    writer: pacedWriter(),
    progress: (line) => console.error(line),
  });
  print(values.json === true, report, sweepLines(report));
  if (report.stopped !== null) return 1;
  // A store problem fails a run asked to move, or one that could read nothing.
  if (report.storeProblem !== null && (report.apply || !report.read)) return 1;
  return 0;
}

/** "a → b" for each moved facet. */
function movedLine(record: MoveRecord, sides: MoveSides): string {
  return record.moved
    .map(
      (f) =>
        `${f}: ${storeName(sides.sourceFacets[f])} → ${storeName(sides.targetFacets[f])}`,
    )
    .join("; ");
}

function valuesLine(values: Partial<Record<Facet, string | null>>): string {
  return Object.entries(values)
    .map(([f, v]) => `${f} ${v ?? "none"}`)
    .join(", ");
}

/** A heading and one line per issue under it, or nothing when there are none. */
function section(
  heading: string,
  items: Array<{ issue: string; why: string }>,
): string[] {
  return items.length === 0
    ? []
    : [heading, ...items.map((i) => `  ${i.issue}  ${i.why}`)];
}

/** One planned write: each facet it sets, or takes off, and what it held. */
function writeLine(w: MoveReport["writes"][number]): string {
  const set = Object.entries(w.set).map(([f, v]) => {
    const was = w.replaces[f as Facet] ?? null;
    const held = was === null ? "" : ` (was ${was})`;
    if (v !== null) return `${f} ${v}${held}`;
    return `${f} off its ${w.tracker === "source" ? "source" : "store"}${held}`;
  });
  return `  ${w.issue}  ${set.join(", ")}`;
}

/** Why the run did not start, what it wrote, what the next run finishes, and why it stopped. */
function moveOutcome(report: MoveReport): string[] {
  const lines: string[] = [];
  if (report.problem !== null)
    lines.push(`refused to start: ${report.problem}`);
  else if (report.apply) lines.push(`wrote ${report.written.length} issue(s)`);
  if (report.again.length > 0)
    lines.push(
      `run --${report.phase} again for ${report.again.length} issue(s) ${report.apply ? "whose value this run copied" : "that would need retirement after copying"}: ${report.again.join(", ")}`,
    );
  if (report.stopped !== null) lines.push(`stopped: ${report.stopped}`);
  if (!report.apply) lines.push("nothing written (--yes writes)");
  return lines;
}

/** The move's report as lines of text: keys, facets and values only. */
function moveLines(
  report: MoveReport,
  record: MoveRecord,
  sides: MoveSides,
): string[] {
  const gets =
    report.phase === "preview"
      ? [
          "what each open issue holds once the move is done:",
          ...report.gets.map((g) => `  ${g.issue}  ${valuesLine(g.values)}`),
        ]
      : [];
  const skipped =
    report.skipped.length === 0
      ? []
      : [
          `read in one store but not the other (opened or closed during the read; run again): ${report.skipped.join(", ")}`,
        ];
  return [
    `move ${movedLine(record, sides)}`,
    `${report.phase}: ${report.open} open issue(s) read in both stores`,
    ...gets,
    ...section(
      report.phase === "restore"
        ? "left as they are:"
        : "unresolved (a person settles each one first):",
      report.unresolved,
    ),
    ...section("conflicts, left as they are for a person:", report.conflicts),
    ...skipped,
    `${report.writes.length} update(s) ${report.apply ? "to make" : "this phase would make"}:`,
    ...report.writes.map(writeLine),
    ...moveOutcome(report),
  ];
}

/** The two trackers of `record`'s move, refusing a record of another repository. */
function sidesOf(
  overlay: Record<string, unknown>,
  root: string,
  record: MoveRecord,
): MoveSides {
  const sourceConfig = withSection(overlay, record.source);
  const targetConfig = withSection(overlay, record.target);
  const sides: MoveSides = {
    source: openTracker(sourceConfig, root),
    target: openTracker(targetConfig, root),
    sourceFacets: facetsOf(sourceConfig, root),
    targetFacets: facetsOf(targetConfig, root),
  };
  if (
    record.adapter !== sourceConfig.adapter ||
    record.team !== sides.source.team
  )
    throw new MoveRecordError(
      `the move record is of ${record.adapter} ${record.team}, and this repository's tracker is ${sourceConfig.adapter} ${sides.source.team}`,
    );
  const moved = movedFacets(sides.sourceFacets, sides.targetFacets);
  if (JSON.stringify(moved) !== JSON.stringify(record.moved))
    throw new MoveRecordError(
      "the record's moved facets disagree with the resolved source and target",
    );
  return sides;
}

/** The preview: the record written with the section in force and the target. */
async function preview(
  overlay: Record<string, unknown>,
  root: string,
  target: string,
  path: string,
): Promise<{ record: MoveRecord; sides: MoveSides } | null> {
  const config = trackerConfigFrom(overlay);
  const current = openTracker(config, root);
  const source = sectionInForce(
    config,
    await current.facetStores({ discovery: false }),
  );
  const sourceFacets = facetsOf(withSection(overlay, source), root);
  const targetEntries = readTarget(target, config.adapter, sourceFacets);
  const targetFacets = facetsOf(withSection(overlay, targetEntries), root);
  const moved = movedFacets(sourceFacets, targetFacets);
  if (moved.length === 0) {
    console.log(
      `nothing to move: the target keeps every facet where ${current.team} keeps it now`,
    );
    return null;
  }
  if (existsSync(path) && readMoveRecord(path).changes.length > 0)
    throw new MoveRecordError(
      `${path} records changes a move made, so it is not replaced: preview it with move --record ${path}, or give a new file`,
    );
  const record: MoveRecord = {
    kind: MOVE_RECORD_KIND,
    version: MOVE_RECORD_VERSION,
    team: current.team,
    adapter: config.adapter,
    source,
    target: targetEntries,
    moved,
    previewedAt: new Date().toISOString(),
    snapshots: {},
    changes: [],
  };
  const sides = sidesOf(overlay, root, record);
  const problem = moveProblem(sides, moved);
  if (problem !== null) throw new MoveRecordError(problem);
  writeMoveRecord(path, record);
  return { record, sides };
}

/** Whether a finished run left something for a person or another run. */
function leftOver(report: MoveReport): boolean {
  return (
    report.problem !== null ||
    report.unresolved.length > 0 ||
    report.conflicts.length > 0 ||
    report.again.length > 0 ||
    report.skipped.length > 0
  );
}

/** What one `move` command asks for. */
interface MoveOptions {
  phase: "preview" | "copy" | "retire" | "restore";
  /** The target section's file, for a preview that writes the record. */
  target?: string;
  /** The record, absolute. */
  record: string;
  apply: boolean;
  json: boolean;
}

/** The options of `move`, refusing a combination it cannot take. */
function moveOptions(argv: string[]): MoveOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: "string" },
      record: { type: "string" },
      restore: { type: "string" },
      copy: { type: "boolean" },
      retire: { type: "boolean" },
      yes: { type: "boolean" },
      json: { type: "boolean" },
    },
    strict: true,
  });
  const phases = (["copy", "retire", "restore"] as const).filter(
    (p) => values[p] !== undefined,
  );
  if (phases.length > 1)
    usage("move takes one of --copy, --retire and --restore");
  const path = values.restore ?? values.record;
  if (path === undefined)
    usage("move needs --record <file>, or --restore <file>");
  if (values.restore !== undefined && values.record !== undefined)
    usage("--restore names the record itself; leave --record out");
  if (values.target !== undefined && phases.length > 0)
    usage(
      "--target is for the preview; copy, retire and restore read the record",
    );
  const apply = values.yes === true;
  if (values.target !== undefined && apply)
    usage("the preview writes nothing to the tracker; leave --yes out");
  if (apply && phases.length === 0)
    usage("--yes writes a phase: give --copy, --retire or --restore with it");
  return {
    phase: phases[0] ?? "preview",
    ...(values.target === undefined ? {} : { target: values.target }),
    record: resolve(path),
    apply,
    json: values.json === true,
  };
}

/** Run the phase `opts` names over `sides`. */
function runPhase(
  opts: MoveOptions,
  sides: MoveSides,
  rec: Parameters<typeof copy>[1],
): Promise<MoveReport> {
  const writer = pacedWriter();
  const run = { apply: opts.apply, writer };
  if (opts.phase === "restore") return restore(sides, rec, run);
  if (opts.phase === "retire") return retire(sides, rec, run);
  return copy(sides, rec, { ...run, preview: opts.phase === "preview" });
}

async function move(argv: string[]): Promise<number> {
  const opts = moveOptions(argv);
  mkdirSync(dirname(opts.record), { recursive: true });
  const path = existsSync(opts.record)
    ? realpathSync(opts.record)
    : resolve(realpathSync(dirname(opts.record)), basename(opts.record));
  opts.record = path;
  const locked = await withFileLock(path, () => moveLocked(opts), {
    root: dirname(path),
    name: "facet-move",
    waitMs: 0,
  });
  if (locked === null)
    throw new MoveRecordError(
      "another command holds this move record; wait for it to finish",
    );
  return locked.value;
}

async function moveLocked(opts: MoveOptions): Promise<number> {
  const overlay = readOverlay();
  const root = consumerRoot();
  const made =
    opts.target === undefined
      ? (() => {
          const record = readMoveRecord(opts.record);
          return { record, sides: sidesOf(overlay, root, record) };
        })()
      : await preview(overlay, root, opts.target, opts.record);
  if (made === null) return 0;
  const { record, sides } = made;
  const report = await runPhase(opts, sides, {
    record,
    save: (r: MoveRecord) => writeMoveRecord(opts.record, r),
    now: () => new Date().toISOString(),
    progress: (line: string) => console.error(line),
  });
  print(opts.json, report, moveLines(report, record, sides));
  if (report.stopped !== null) return 1;
  return leftOver(report) ? 3 : 0;
}

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  try {
    if (first === "move") return await move(rest);
    if (first === "check") return await check(rest);
    if (first === undefined || first.startsWith("--")) return await check(argv);
    return usage(`unknown mode: ${first}`);
  } catch (err) {
    if (err instanceof ExitError) throw err;
    if (
      err instanceof MoveRecordError ||
      err instanceof SectionError ||
      err instanceof TrackerConfigError ||
      (err instanceof TypeError &&
        (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") === true)
    )
      return usage(err.message);
    return fail(1, `ERROR: ${failureLine("check-fields", err)}`);
  }
}

if (import.meta.main)
  runMain("check-fields", () => main(process.argv.slice(2)));

export { main };
