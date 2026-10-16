#!/usr/bin/env bun
/**
 * The audit sheet: check a report source, render it with the audit record
 * into a self-contained HTML sheet and a Markdown copy, and recover from a
 * sheet what it was rendered from. What a report source holds, and how to
 * write one: `references/report-sheet.md`.
 *
 * Usage (from anywhere inside the repository under audit):
 *   bun report.ts validate <source.json> [--record <path>] [--fit <fit.json>]
 *       the source alone; with --record, also against the record (and with
 *       --fit, against the configuration-fit report), warning of each gap
 *       within the target no recommendation covers
 *   bun report.ts render <source.json> [--record <path>] [--fit <fit.json>]
 *                        [--prior <record>] [--history <record>]… [--out <dir>]
 *       writes jig-audit-<date>.html and jig-audit-<date>.md into --out
 *       (default: a new temporary folder) and prints their paths
 *   bun report.ts extract <sheet.html>
 *       prints the source, record, fit report, prior record and history
 *       records the sheet embeds, as JSON
 *
 * --record defaults to the repository's .config/jig-audit.yaml; during an
 * audit, name the draft record of this run. --fit is the output of
 * `config-fit.ts --json`; --prior is the record of the last audit, which adds
 * the "since the last audit" section. --history, once per record, names
 * older records of the same repository; with --prior, they add the trend of
 * each module's level.
 *
 * A source is refused when it is malformed, when a recommendation names a
 * criterion the record did not score or a configuration finding the fit
 * report does not hold, when any ref of a recommendation is one the team
 * declined and still holds, when its profile disagrees with the record, when
 * the record itself is incomplete, or when a history record is newer than it.
 *
 * Exit codes: 0 done; 1 the source was refused (nothing written); 2 usage,
 * or an input that cannot be read.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractEmbedded } from "../../decide/scripts/sheet-kit/html.ts";
import { consumerRoot } from "../../../shared/consumer.ts";
import { loadModules } from "./lib/criteria.ts";
import { loadProfiles } from "./lib/profiles.ts";
import { type AuditRecord, parseRecord, RECORD_RELPATH } from "./lib/record.ts";
import { today } from "./lib/repo.ts";
import { loadSchema } from "./lib/schema.ts";
import { DATA_BLOCK_ID, parseEmbedded } from "./report/data.ts";
import { renderReportHtml } from "./report/html.ts";
import { fileStem, renderReportMarkdown } from "./report/markdown.ts";
import {
  inputProblems,
  mapRows,
  type ReportInput,
  targetsOf,
  uncoveredGaps,
} from "./report/model.ts";
import {
  parseFit,
  parseReportSource,
  ReportSourceError,
} from "./report/source.ts";

class UsageError extends Error {}

const USAGE = `usage:
  report.ts validate <source.json> [--record <path>] [--fit <fit.json>]
  report.ts render <source.json> [--record <path>] [--fit <fit.json>] [--prior <record> [--history <record>]...] [--out <dir>]
  report.ts extract <sheet.html>`;

/** The flags each command accepts; every flag takes a value. */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  validate: ["--record", "--fit"],
  render: ["--record", "--fit", "--prior", "--history", "--out"],
  extract: [],
};

/** The flag that may be given more than once, one record each time. */
const REPEATABLE = "--history";

interface Args {
  file: string;
  flags: Map<string, string>;
  /** The older records `--history` names, in the order given. */
  history: string[];
}

/** Check one flag against the command's and the ones already given, and return its value. */
function flagValue(
  command: string,
  flag: string,
  value: string | undefined,
  given: Map<string, string>,
): string {
  const allowed = COMMAND_FLAGS[command] ?? [];
  if (!allowed.includes(flag))
    throw new UsageError(
      `unknown flag for ${command}: ${flag}${allowed.length ? `; it accepts ${allowed.join(", ")}` : "; it takes no flags"}`,
    );
  if (given.has(flag)) throw new UsageError(`${flag} given more than once`);
  if (value === undefined || value.startsWith("--"))
    throw new UsageError(`${flag} needs a value`);
  return value;
}

/** One file and the command's flags; an unknown, repeated or empty flag is a usage error. */
function parseArgs(command: string, args: string[]): Args {
  const flags = new Map<string, string>();
  const history: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === REPEATABLE)
      history.push(flagValue(command, arg, args[++i], new Map()));
    else if (arg.startsWith("--"))
      flags.set(arg, flagValue(command, arg, args[++i], flags));
    else files.push(arg);
  }
  if (files.length !== 1)
    throw new UsageError(`${command} takes one file, not ${files.length}`);
  // The trend sits in the comparison with the last audit, which --prior adds.
  if (history.length > 0 && !flags.has("--prior"))
    throw new UsageError(
      "--history needs --prior: the trend is part of the comparison with the last audit",
    );
  return { file: files[0] as string, flags, history };
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read ${path}`, { cause: error });
  }
}

function readJson(path: string): unknown {
  const text = readText(path);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`${path} is not valid JSON`, { cause: error });
  }
}

const readRecord = (path: string): AuditRecord =>
  parseRecord(readText(path), path);

/** Everything `render` needs, read from the files the flags name. */
function readInput(args: Args): ReportInput {
  const source = parseReportSource(readJson(args.file));
  const modules = loadModules();
  const fitPath = args.flags.get("--fit");
  const priorPath = args.flags.get("--prior");
  return {
    source,
    record: readRecord(
      args.flags.get("--record") ?? join(consumerRoot(), RECORD_RELPATH),
    ),
    fit: fitPath ? parseFit(readJson(fitPath), fitPath) : null,
    prior: priorPath ? readRecord(priorPath) : null,
    history: args.history.map(readRecord),
    modules,
    profiles: loadProfiles(modules),
    schema: loadSchema(),
    today: today(),
  };
}

function checked(input: ReportInput): ReportInput {
  const problems = inputProblems(input);
  if (problems.length > 0)
    throw new ReportSourceError(
      problems,
      "the report source does not fit the record",
    );
  return input;
}

function validate(args: Args): number {
  if (!args.flags.has("--record")) {
    const source = parseReportSource(readJson(args.file));
    console.log(
      JSON.stringify({
        ok: true,
        checked: "source",
        recommendations: source.recommendations.length,
      }),
    );
    return 0;
  }
  const input = checked(readInput(args));
  const targets = targetsOf(input);
  const uncovered = uncoveredGaps(mapRows(input, targets));
  // A gap no recommendation covers is a warning, not a refusal: the team may
  // leave it deliberately, and the sheet lists it either way.
  for (const c of uncovered)
    console.error(
      `warning: ${c.criterion.key} is within the ${targets.profile?.name ?? ""} target and not met, and no recommendation covers it: ${c.criterion.statement}`,
    );
  console.log(
    JSON.stringify({
      ok: true,
      checked: input.fit ? "source, record, fit" : "source, record",
      recommendations: input.source.recommendations.length,
      uncovered: uncovered.map((c) => c.criterion.key),
    }),
  );
  return 0;
}

function render(args: Args): number {
  const input = checked(readInput(args));
  const outFlag = args.flags.get("--out");
  const out = outFlag
    ? resolve(outFlag)
    : mkdtempSync(join(tmpdir(), "jig-audit-"));
  mkdirSync(out, { recursive: true });
  const files = {
    sheet: join(out, `${fileStem(input)}.html`),
    markdown: join(out, `${fileStem(input)}.md`),
  };
  writeFileSync(files.sheet, renderReportHtml(input));
  writeFileSync(files.markdown, renderReportMarkdown(input));
  console.log(JSON.stringify(files, null, 2));
  return 0;
}

function extract(args: Args): number {
  const html = readText(args.file);
  const data = parseEmbedded(
    extractEmbedded(html, DATA_BLOCK_ID, "audit data").value,
  );
  console.log(JSON.stringify(data, null, 2));
  return 0;
}

const COMMANDS = new Map<string, (args: Args) => number>([
  ["validate", validate],
  ["render", render],
  ["extract", extract],
]);

export function main(argv = process.argv.slice(2)): number {
  const [command, ...rest] = argv;
  const run = command === undefined ? undefined : COMMANDS.get(command);
  if (run === undefined || command === undefined)
    throw new UsageError(
      command === undefined ? "missing command" : `unknown command ${command}`,
    );
  return run(parseArgs(command, rest));
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ReportSourceError) {
      console.error(message);
      process.exitCode = 1;
    } else {
      console.error(
        error instanceof UsageError
          ? `${message}\n${USAGE}`
          : `ERROR: ${message}`,
      );
      process.exitCode = 2;
    }
  }
}
