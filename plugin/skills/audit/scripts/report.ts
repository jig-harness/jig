#!/usr/bin/env bun
/**
 * The audit sheet: check a report source, render it with the audit record
 * into a self-contained HTML sheet and a Markdown copy, and recover from a
 * sheet what it was rendered from. What a report source holds, and how to
 * write one: `references/report-sheet.md`.
 *
 * Usage (from anywhere inside the repository under audit):
 *   bun report.ts validate <source.json> [--record <path>] [--fit <fit.json>]
 *                          [--profile <id> [--conditions M3,M12]]
 *                          [--other-repository]
 *       the source alone; with --record, also against the record (and with
 *       --fit, against the configuration-fit report), warning of each gap
 *       within the target no recommendation covers or leaves on purpose
 *   bun report.ts render <source.json> [--record <path>] [--fit <fit.json>]
 *                        [--profile <id> [--conditions M3,M12]]
 *                        [--prior <record>] [--history <record>]… [--out <dir>]
 *                        [--other-repository]
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
 * each module's level. --profile measures against another profile than the
 * record's, with the conditional targets --conditions names (none when it is
 * left out), without changing the record or the source: a way to see the
 * targets and gaps a profile would set before the team chooses it.
 *
 * Run inside a git repository, both commands that read a record refuse
 * (exit 2) a record (`--record`, `--prior` or `--history`) whose commit that
 * repository does not hold, and a source whose repository name is not the
 * path one of its remotes names: either file was written for another
 * repository. `--other-repository` renders another repository's audit on
 * purpose (an example, a calibration run) and skips both checks.
 *
 * A source is refused when it is malformed, when a recommendation names a
 * criterion the record did not score or a configuration finding the fit
 * report does not hold, when any ref of a recommendation is one the team
 * declined and still holds, when it leaves on purpose a criterion the
 * record did not score or a recommendation moves, when its profile disagrees
 * with the record, when the record itself is incomplete, or when a history
 * record is newer than it.
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
import {
  type AuditRecord,
  checkProfile,
  parseRecord,
  RECORD_RELPATH,
} from "./lib/record.ts";
import { hasCommit, run, today } from "./lib/repo.ts";
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
  type ReportSource,
  ReportSourceError,
} from "./report/source.ts";

class UsageError extends Error {}

/** A record or source written for another repository than the one the command runs in. */
class ForeignInputError extends Error {
  override name = "ForeignInputError";
}

const USAGE = `usage:
  report.ts validate <source.json> [--record <path>] [--fit <fit.json>] [--profile <id> [--conditions M3,M12]] [--other-repository]
  report.ts render <source.json> [--record <path>] [--fit <fit.json>] [--profile <id> [--conditions M3,M12]] [--prior <record> [--history <record>]...] [--out <dir>] [--other-repository]
  report.ts extract <sheet.html>`;

/** The flags each command accepts; every flag but a switch takes a value. */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  validate: [
    "--record",
    "--fit",
    "--profile",
    "--conditions",
    "--other-repository",
  ],
  render: [
    "--record",
    "--fit",
    "--profile",
    "--conditions",
    "--prior",
    "--history",
    "--out",
    "--other-repository",
  ],
  extract: [],
};

/** The flags that take no value. */
const SWITCHES = new Set(["--other-repository"]);

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
  if (SWITCHES.has(flag)) return "";
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
    else if (SWITCHES.has(arg))
      flags.set(arg, flagValue(command, arg, undefined, flags));
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
  if (flags.has("--conditions") && !flags.has("--profile"))
    throw new UsageError(
      "--conditions needs --profile: they are the conditional targets of the profile it explores",
    );
  if (
    command === "validate" &&
    flags.has("--profile") &&
    !flags.has("--record")
  )
    throw new UsageError(
      "--profile needs --record: the targets are measured against the record's scores",
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

/**
 * The repository a remote URL names, as its path on the host
 * (`example/web`); null for a URL of another shape.
 */
export function remotePath(url: string): string | null {
  const m =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?[^/]+\/(.+)$/i.exec(url) ??
    /^(?:[^@/]+@)?[^/:]+:(?!\/)(.+)$/.exec(url);
  const path = m?.[1]?.replace(/\/+$/, "").replace(/\.git$/, "");
  return path ? path : null;
}

/**
 * Whether a report's repository name is the repository a remote's `path`
 * names: the whole name, ignoring letter case, as the path or as its last
 * parts, since some hosts put more before the owner (`group/sub/web`) or a
 * `_git` part before the name (`org/project/_git/web`). Owners are compared
 * too, so `alice/web` is not `bob/web`; a fork is recognized by the remote
 * that names its upstream.
 */
export const namesRepository = (name: string, path: string): boolean => {
  const parts = (p: string) =>
    p
      .trim()
      .toLowerCase()
      .split("/")
      .filter((s) => s !== "" && s !== "_git");
  const want = parts(name);
  const have = parts(path);
  return (
    want.length > 0 &&
    want.length <= have.length &&
    want.every((s, i) => s === have[have.length - want.length + i])
  );
};

/** The repository paths the checkout's remotes name, one per remote. */
function remotePaths(root: string): string[] {
  const remotes = run("git", ["remote"], { cwd: root });
  if (remotes.code !== 0) return [];
  return remotes.stdout
    .split("\n")
    .filter(Boolean)
    .map((name) => run("git", ["remote", "get-url", name], { cwd: root }))
    .map((url) => (url.code === 0 ? remotePath(url.stdout.trim()) : null))
    .filter((path): path is string => path !== null);
}

/**
 * Refuse records or a source written for another repository: run inside a
 * git repository, each record's commit must be one it holds, and the
 * source's repository name must be the one one of its remotes names. Outside
 * a repository, or without a remote, nothing is known and nothing is
 * refused.
 */
function checkIdentity(
  records: readonly { flag: string; record: AuditRecord }[],
  source: ReportSource,
): void {
  const root = consumerRoot();
  const inside = run("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
  });
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return;
  for (const { flag, record } of records)
    if (!hasCommit(root, record.commit))
      throw new ForeignInputError(
        `the ${flag === "--record" ? "record" : `${flag} record`} audits commit ${record.commit.slice(0, 12)}, which the repository at ${root} does not hold: run from the repository it audits, name that repository's records, or pass --other-repository to render another repository's audit on purpose`,
      );
  const paths = remotePaths(root);
  if (
    paths.length > 0 &&
    !paths.some((path) => namesRepository(source.repository.name, path))
  )
    throw new ForeignInputError(
      `the report source is for ${source.repository.name}, and the repository at ${root} is ${paths.join(" or ")} (its remotes): render each repository's source with its own record`,
    );
}

/** The profile `--profile` explores and the conditional targets `--conditions` says apply under it. */
function exploredOf(
  args: Args,
  record: AuditRecord,
  profiles: ReportInput["profiles"],
): ReportInput["explored"] {
  const id = args.flags.get("--profile");
  if (id === undefined) return undefined;
  if (!profiles.profiles.has(id))
    throw new UsageError(
      `--profile ${id} is not one of ${[...profiles.profiles.keys()].join(", ")}`,
    );
  const conditions = (args.flags.get("--conditions") ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m !== "");
  const problems = checkProfile(
    { ...record, profile: id, profile_conditions: conditions },
    profiles,
  );
  if (problems.length > 0)
    throw new UsageError(`--profile ${id}: ${problems.join("; ")}`);
  return { id, conditions };
}

/** Everything `render` needs, read from the files the flags name. */
function readInput(args: Args): ReportInput {
  const source = parseReportSource(readJson(args.file));
  const modules = loadModules();
  const profiles = loadProfiles(modules);
  const fitPath = args.flags.get("--fit");
  const priorPath = args.flags.get("--prior");
  const record = readRecord(
    args.flags.get("--record") ?? join(consumerRoot(), RECORD_RELPATH),
  );
  const prior = priorPath ? readRecord(priorPath) : null;
  const history = args.history.map(readRecord);
  if (!args.flags.has("--other-repository"))
    checkIdentity(
      [
        { flag: "--record", record },
        ...(prior ? [{ flag: "--prior", record: prior }] : []),
        ...history.map((h) => ({ flag: "--history", record: h })),
      ],
      source,
    );
  const explored = exploredOf(args, record, profiles);
  return {
    source,
    record,
    fit: fitPath ? parseFit(readJson(fitPath), fitPath) : null,
    prior,
    history,
    modules,
    profiles,
    schema: loadSchema(),
    today: today(),
    ...(explored ? { explored } : {}),
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
  // leave it deliberately, and the sheet lists it either way. A gap the
  // source leaves on purpose is covered.
  for (const c of uncovered)
    console.error(
      `warning: ${c.criterion.key} is within the ${targets.profile?.name ?? ""} target and not met, and no recommendation covers it: ${c.criterion.statement}`,
    );
  console.log(
    JSON.stringify({
      ok: true,
      checked: input.fit ? "source, record, fit" : "source, record",
      recommendations: input.source.recommendations.length,
      ...(input.explored ? { explored: input.explored } : {}),
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
