#!/usr/bin/env bun
/**
 * Read audit records (`.config/jig-audit.yaml`): check one before it is
 * committed, compare a new one with the prior, summarise the levels one
 * attains, set several repositories' records side by side, and record the
 * team's decisions from the audit sheet.
 *
 * Usage (from anywhere inside the repository; <record> defaults to
 * .config/jig-audit.yaml):
 *   bun record.ts check [<record>]
 *       every criterion scored with evidence, every key a current criterion
 *   bun record.ts compare <prior> <current> [--json] [--date YYYY-MM-DD]
 *       fixed, regressed, still open, new, added by Jig since the prior
 *       audit's plugin version, removed; configuration fields added since;
 *       each declined recommendation held, due, resolved or stale; refuses
 *       a current record that check finds incomplete
 *   bun record.ts summary [<record>]
 *       the level each module attains
 *   bun record.ts portfolio <name>=<record> <name>=<record> ...
 *       levels and scores of several repositories, side by side
 *   bun record.ts apply-feedback <feedback-file|-> --report <source.json>
 *                 [<record>] [--dry-run] [--json] [--date YYYY-MM-DD]
 *       record the decisions the sheet's copy button wrote (read from
 *       standard input with -): each decline into declined:, a chosen
 *       profile into profile: and chosen conditional targets into
 *       profile_conditions:, keeping every comment in the record; then
 *       print the accepted and refined work, ranked as the sheet's Start
 *       here ranks it, and each "wrong" recommendation or score as a
 *       calibration note. Refuses a block written for another repository,
 *       commit or report, and accepted or refined work on a criterion the
 *       record holds declined. --dry-run writes nothing; --json prints the
 *       plan instead of the report.
 *
 * Exit codes: 0 done; 1 check (or compare, for the current record) found the
 * record unfit to commit, or apply-feedback refused the feedback; 2 usage, an
 * unreadable record, report or feedback file, or a record edit that would not
 * check.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs as parseOptions } from "node:util";
import { consumerRoot } from "../../resolve-review-comments/scripts/lib/consumer.ts";
import {
  gaps,
  loadProfiles,
  type Profiles,
  targetsFor,
} from "./lib/profiles.ts";
import { attained, loadModules, type Module } from "./lib/criteria.ts";
import {
  changesRecord,
  checkEdited,
  editRecordText,
  FeedbackRefused,
  type FeedbackPlan,
  parseFeedback,
  planFeedback,
  readReportView,
  renderPlan,
} from "./lib/feedback.ts";
import {
  type AuditRecord,
  checkRecord,
  compare,
  parseRecord,
  RECORD_RELPATH,
  renderComparison,
  renderPortfolio,
  scoresOf,
} from "./lib/record.ts";
import { isDate, today } from "./lib/repo.ts";
import { loadSchema } from "./lib/schema.ts";

const USAGE = `usage:
  record.ts check [<record>]
  record.ts compare <prior> <current> [--json] [--date YYYY-MM-DD]
  record.ts summary [<record>]
  record.ts portfolio <name>=<record> ...
  record.ts apply-feedback <feedback-file|-> --report <source.json> [<record>] [--dry-run] [--json] [--date YYYY-MM-DD]`;

function read(path: string): AuditRecord {
  return parseRecord(readFileSync(path, "utf8"), path);
}

function defaultRecord(): string {
  return join(consumerRoot(), RECORD_RELPATH);
}

/** One subcommand's input: its words, its flags and the current criteria. */
interface Invocation {
  positional: string[];
  json: boolean;
  dryRun: boolean;
  date: string;
  /** The report source `--report` names. */
  report: string | undefined;
  modules: Module[];
  profiles: Profiles;
  usage: (why: string) => number;
}

function checkCommand({
  positional,
  modules,
  profiles,
  usage,
}: Invocation): number {
  if (positional.length > 1) return usage("check takes one record");
  const record = read(positional[0] ?? defaultRecord());
  const problems = checkRecord(record, modules, profiles);
  for (const p of problems) console.log(`- ${p}`);
  console.log(
    problems.length === 0
      ? `record complete: ${record.criteria.size} criteria scored, ${record.declined.length} declined`
      : `${problems.length} problem(s): fill or fix them before committing the record`,
  );
  return problems.length === 0 ? 0 : 1;
}

function compareCommand(inv: Invocation): number {
  if (inv.positional.length !== 2)
    return inv.usage("compare takes two records");
  const [priorPath, currentPath] = inv.positional as [string, string];
  const prior = read(priorPath);
  const current = read(currentPath);
  // A criterion missing from the new record would drop out of the changes
  // unseen, so the comparison waits until the record is complete.
  const problems = checkRecord(current, inv.modules, inv.profiles);
  if (problems.length > 0) {
    for (const p of problems) console.error(`- ${p}`);
    console.error(
      `${currentPath} is incomplete: complete it (record.ts check) before comparing`,
    );
    return 1;
  }
  const result = compare(prior, current, inv.modules, loadSchema(), inv.date);
  console.log(
    inv.json
      ? JSON.stringify(result, null, 2)
      : renderComparison(result, prior),
  );
  return 0;
}

function summaryCommand({
  positional,
  modules,
  profiles,
  usage,
}: Invocation): number {
  if (positional.length > 1) return usage("summary takes one record");
  const record = read(positional[0] ?? defaultRecord());
  const scores = scoresOf(record);
  const profile = record.profile
    ? profiles.profiles.get(record.profile)
    : undefined;
  if (!profile) {
    console.log(
      `| Module | Level attained |\n|--------|----------------|\n${modules
        .map(
          (m) =>
            `| ${m.module} ${m.name} | ${attained(m, scores) ?? "incomplete"} |`,
        )
        .join("\n")}`,
    );
    return 0;
  }
  const targets = targetsFor(profile, record.profile_conditions);
  const rows = gaps(modules, scores, targets, profiles.order).map(
    (g) =>
      `| ${g.module.module} ${g.module.name} | ${g.attained ?? "incomplete"} | ${g.target ?? "—"} | ${g.target === null ? "—" : g.missing.length === 0 ? "reached" : `${g.missing.length} to go`} |`,
  );
  console.log(
    `Profile: ${profile.name}, modules in adoption order.\n\n| Module | Level attained | Target | Gap |\n|--------|----------------|--------|-----|\n${rows.join("\n")}`,
  );
  return 0;
}

function portfolioCommand({ positional, modules, usage }: Invocation): number {
  if (positional.length < 2)
    return usage("portfolio compares two or more records");
  const records = positional.map((arg) => {
    const at = arg.indexOf("=");
    if (at <= 0) throw new Error(`${arg}: write <name>=<record>`);
    return { name: arg.slice(0, at), record: read(arg.slice(at + 1)) };
  });
  console.log(renderPortfolio(records, modules));
  return 0;
}

/** The feedback block, from a file or, for `-`, from standard input. */
function readFeedback(path: string): string {
  return readFileSync(path === "-" ? 0 : path, "utf8");
}

/**
 * The edited record's text, checked as it would be read back: on any problem
 * the edit fails before anything is written.
 */
function editChecked(
  path: string,
  original: string,
  before: AuditRecord,
  plan: FeedbackPlan,
  catalog: Invocation,
): string {
  const edited = editRecordText(original, plan);
  const problems = checkEdited(before, edited, path, plan, catalog);
  if (problems.length > 0)
    throw new Error(
      `${path}: the edit would leave the record unfit (${problems.join("; ")}); the record is unchanged`,
    );
  return edited;
}

function applyFeedbackCommand(inv: Invocation): number {
  const { positional, report, usage } = inv;
  if (positional.length < 1 || positional.length > 2)
    return usage("apply-feedback takes a feedback file (or -) and a record");
  if (report === undefined)
    return usage("apply-feedback needs --report <source.json>");
  const [feedbackPath, recordPath = defaultRecord()] = positional as [
    string,
    string?,
  ];
  const original = readFileSync(recordPath, "utf8");
  const record = parseRecord(original, recordPath);
  const view = readReportView(readFileSync(report, "utf8"), report);
  const feedback = readFeedback(feedbackPath);
  let plan: FeedbackPlan;
  try {
    plan = planFeedback(parseFeedback(feedback), {
      record,
      report: view,
      modules: inv.modules,
      profiles: inv.profiles,
      today: inv.date,
    });
  } catch (error) {
    if (!(error instanceof FeedbackRefused)) throw error;
    for (const p of error.problems) console.error(`- ${p}`);
    console.error("feedback refused: nothing was recorded");
    return 1;
  }
  // The edit is made and checked before anything is written, and on a dry
  // run too, so a dry run fails where the real one would.
  if (changesRecord(plan)) {
    const edited = editChecked(recordPath, original, record, plan, inv);
    if (!inv.dryRun) writeFileSync(recordPath, edited);
  }
  console.log(
    inv.json
      ? JSON.stringify(plan, null, 2)
      : renderPlan(plan, { record: recordPath, dryRun: inv.dryRun }),
  );
  return 0;
}

const COMMANDS = new Map<string, (inv: Invocation) => number>([
  ["check", checkCommand],
  ["compare", compareCommand],
  ["summary", summaryCommand],
  ["portfolio", portfolioCommand],
  ["apply-feedback", applyFeedbackCommand],
]);

const OPTIONS = {
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  date: { type: "string" },
  report: { type: "string" },
} as const;

/** The flags, the values of `--date` and `--report`, and the words that are neither. */
function readOptions(rest: string[]) {
  const { values, positionals, tokens } = parseOptions({
    args: rest,
    options: OPTIONS,
    allowPositionals: true,
    tokens: true,
  });
  const names = tokens.flatMap((t) => (t.kind === "option" ? [t.rawName] : []));
  const repeated = names.find((n, i) => names.indexOf(n) !== i);
  if (repeated) throw new Error(`${repeated} given twice`);
  return {
    json: values.json === true,
    dryRun: values["dry-run"] === true,
    date: values.date,
    report: values.report,
    positional: positionals,
  };
}

/**
 * The parsed options, or why they do not parse. A misspelt or repeated flag
 * is refused rather than skipped: `--dryrun` must not write.
 */
function parseArgs(rest: string[]) {
  try {
    return readOptions(rest);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function main(argv = process.argv.slice(2)): number {
  const [op, ...rest] = argv;
  const usage = (why: string) => {
    console.error(`${why}\n${USAGE}`);
    return 2;
  };
  const parsed = parseArgs(rest);
  if ("error" in parsed) return usage(parsed.error);
  const { date = today(), report, ...args } = parsed;
  if (!isDate(date)) return usage("--date must be a calendar date, YYYY-MM-DD");
  const modules = loadModules();
  const profiles = loadProfiles(modules);
  const command = op === undefined ? undefined : COMMANDS.get(op);
  if (command === undefined)
    return usage(
      op === undefined ? "missing command" : `unknown command ${op}`,
    );
  return command({ ...args, date, report, modules, profiles, usage });
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
