#!/usr/bin/env bun
/**
 * Read audit records (`.config/jig-audit.yaml`): check one before it is
 * committed, compare a new one with the prior, summarise the levels one
 * attains, set several repositories' records side by side, fill a draft's
 * scores from an answers file or from partial drafts, and record the team's
 * decisions from the audit sheet.
 *
 * Usage (from anywhere inside the repository; <record> defaults to
 * .config/jig-audit.yaml). Run inside a git repository, check, compare and
 * summary refuse a record whose commit the repository does not hold: it was
 * made for another repository.
 *   bun record.ts check [<record>]
 *       every criterion scored with evidence, every key a current criterion;
 *       with a profile declared, none within its target (or a condition's,
 *       or heading_to's) left not-examined. Warns, without failing, about
 *       evidence naming a path the record's commit does not hold or a line
 *       past its file's end. Not read as paths: code identifiers, fragments
 *       of a name, the audit's scratch files (fit.json, jig-audit.next.yaml),
 *       what a clause says is missing or proposed (after `no`, `missing`,
 *       `would`, `proposed`, …; `add` or `create` proposes only the paths
 *       right after it, one or a list joined by commas, `and` or `or`, and
 *       nothing when it is a program's command such as `git add`), and a
 *       Jig plugin file a possessive of the plugin or Jig directly precedes
 *       (`the plugin's scripts/x.ts`); `a.md/b.md` names two alternatives
 *   bun record.ts compare <prior> <current> [--json] [--date YYYY-MM-DD]
 *       fixed, regressed, still open, new, added by Jig since the prior
 *       audit's plugin version, removed, and apart from those, examined
 *       since or no longer examined (against a prior record that examined
 *       every criterion, the no-longer-examined ones are counted in one
 *       line, not listed);
 *       configuration fields added since;
 *       each declined recommendation held, due, resolved or stale; refuses
 *       a current record that check finds incomplete
 *   bun record.ts summary [<record>] [--profile <id> [--conditions M12,M3]]
 *       the level each module attains, and its target and gap under the
 *       record's profile, or under the one --profile names without editing
 *       the record
 *   bun record.ts fill <draft> <answers> [--into <file>]
 *       write answers into a draft, keeping its comments: one per line,
 *       `M1/ci-runs-gates-on-pr: mechanical | evidence text` (blank lines
 *       and # comments skipped), or JSON { "M1/x": { "score": …,
 *       "evidence": … } }. Refuses unknown criteria, invalid scores, empty
 *       evidence, a change to a probe's score and a change to an answer the
 *       draft already holds; lists what is still null
 *   bun record.ts merge <draft> <partial>... [--into <file>]
 *       take each score the partials (copies of the draft, each scored by
 *       one worker) set; refuses a partial of another draft, a criterion two
 *       partials score differently, a change to a probe's score and a change
 *       to an answer the draft already holds; lists
 *       what is still null. fill and merge write the draft in place unless
 *       --into names another file
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
 * record unfit to commit, a record names a commit this repository does not
 * hold, fill or merge refused the answers, or apply-feedback refused the
 * feedback; 2 usage, an
 * unreadable record, report or feedback file, or a record edit that would not
 * check.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs as parseOptions } from "node:util";
import { consumerRoot } from "../../../shared/consumer.ts";
import {
  gaps,
  loadProfiles,
  type ModuleGap,
  type Profiles,
  selectProfiles,
  targetsFor,
} from "./lib/profiles.ts";
import {
  attained,
  type Level,
  loadModules,
  type Module,
  NOT_EXAMINED,
  type Score,
} from "./lib/criteria.ts";
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
  type Answer,
  type AuditRecord,
  attainmentText,
  checkAnswers,
  checkRecord,
  compare,
  DraftEditRefused,
  evidenceWarnings,
  mergePartials,
  parseAnswers,
  parseRecord,
  RECORD_RELPATH,
  renderComparison,
  renderPortfolio,
  scoresOf,
  setScores,
  unscored,
} from "./lib/record.ts";
import { hasCommit, isDate, run, today } from "./lib/repo.ts";
import { loadSchema } from "./lib/schema.ts";

const USAGE = `usage:
  record.ts check [<record>]
  record.ts compare <prior> <current> [--json] [--date YYYY-MM-DD]
  record.ts summary [<record>] [--profile <id> [--conditions M12,M3]]
  record.ts portfolio <name>=<record> ...
  record.ts fill <draft> <answers> [--into <file>]
  record.ts merge <draft> <partial>... [--into <file>]
  record.ts apply-feedback <feedback-file|-> --report <source.json> [<record>] [--dry-run] [--json] [--date YYYY-MM-DD]`;

function read(path: string): AuditRecord {
  return parseRecord(readFileSync(path, "utf8"), path);
}

function defaultRecord(): string {
  return join(consumerRoot(), RECORD_RELPATH);
}

/** The repository the command runs in, or null outside a git repository. */
function gitRoot(): string | null {
  const top = run("git", ["rev-parse", "--show-toplevel"], {
    cwd: consumerRoot(),
  });
  return top.code === 0 ? top.stdout.trim() : null;
}

/**
 * Why `record` cannot be read here: run inside a git repository that does
 * not hold its commit, it was made for another repository, as a draft left
 * in a scratch folder several audits share is. Null when it can.
 */
function foreignRecord(record: AuditRecord, path: string): string | null {
  const root = gitRoot();
  if (root === null || hasCommit(root, record.commit)) return null;
  return `${path} audits commit ${record.commit}, which the repository at ${root} does not hold: it is another repository's record (a draft from a shared scratch folder?). Run record.ts inside the repository it audits, or score this one again`;
}

/**
 * The record at `path`, or null, said on standard error, when it was made
 * for another repository.
 */
function readOwn(path: string): AuditRecord | null {
  const record = read(path);
  const foreign = foreignRecord(record, path);
  if (foreign === null) return record;
  console.error(foreign);
  return null;
}

/** How many of a record's criteria it left unexamined. */
const unexaminedIn = (record: AuditRecord): number =>
  [...record.criteria.values()].filter((e) => e.score === NOT_EXAMINED).length;

/** The closing line of `check`: what the record holds, or how much is left to fix. */
function checkVerdict(
  record: AuditRecord,
  problems: number,
  warnings: number,
): string {
  if (problems > 0)
    return `${problems} problem(s): fill or fix them before committing the record`;
  const unexamined = unexaminedIn(record);
  const examined = unexamined > 0 ? ` (${unexamined} not examined)` : "";
  const warned =
    warnings > 0 ? `; ${warnings} evidence warning(s) to look at` : "";
  return `record complete: ${record.criteria.size} criteria scored${examined}, ${record.declined.length} declined${warned}`;
}

/** One subcommand's input: its words, its flags and the current criteria. */
interface Invocation {
  positional: string[];
  json: boolean;
  dryRun: boolean;
  date: string;
  /** The report source `--report` names. */
  report: string | undefined;
  /** The profile `--profile` names, and the conditions `--conditions` lists. */
  profile: string | undefined;
  conditions: string[] | undefined;
  /** Where `--into` writes a filled draft. */
  into: string | undefined;
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
  const record = readOwn(positional[0] ?? defaultRecord());
  if (record === null) return 1;
  const problems = checkRecord(record, modules, profiles);
  for (const p of problems) console.log(`- ${p}`);
  const root = gitRoot();
  const warnings = root === null ? [] : evidenceWarnings(record, root);
  for (const w of warnings) console.log(`warning: ${w}`);
  console.log(checkVerdict(record, problems.length, warnings.length));
  return problems.length === 0 ? 0 : 1;
}

function compareCommand(inv: Invocation): number {
  if (inv.positional.length !== 2)
    return inv.usage("compare takes two records");
  const [priorPath, currentPath] = inv.positional as [string, string];
  // A prior record of another repository would invent fixes and regressions.
  const prior = readOwn(priorPath);
  const current = readOwn(currentPath);
  if (prior === null || current === null) return 1;
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

/**
 * The profile a summary measures against: the one `--profile` names, with
 * the conditions `--conditions` lists, or else the record's own.
 */
function summaryProfile(
  record: AuditRecord,
  inv: Invocation,
): SummaryProfile | { error: string } | null {
  if (inv.profile === undefined && inv.conditions === undefined)
    return declaredProfile(record, inv.profiles);
  const id = inv.profile ?? record.profile;
  if (id === undefined)
    return { error: "--conditions needs a profile: give --profile" };
  const conditions =
    inv.conditions ??
    (inv.profile === record.profile ? (record.profile_conditions ?? []) : []);
  const chosen = selectProfiles(inv.profiles, { profile: id, conditions });
  if ("error" in chosen) return chosen;
  return {
    name: chosen.profile.name,
    targets: targetsFor(chosen.profile, conditions),
  };
}

interface SummaryProfile {
  name: string;
  targets: Map<string, Level>;
}

/**
 * The record's own profile, or null when it declares none the plugin ships.
 * Its conditions are check's to judge; a summary applies those that fit.
 */
function declaredProfile(
  record: AuditRecord,
  profiles: Profiles,
): SummaryProfile | null {
  const profile =
    record.profile === undefined
      ? undefined
      : profiles.profiles.get(record.profile);
  return profile
    ? {
        name: profile.name,
        targets: targetsFor(profile, record.profile_conditions),
      }
    : null;
}

/** Each module's level, without a profile. */
function levelsTable(modules: Module[], scores: Map<string, Score>): string {
  return `| Module | Level attained |\n|--------|----------------|\n${modules
    .map(
      (m) =>
        `| ${m.module} ${m.name} | ${attainmentText(attained(m, scores))} |`,
    )
    .join("\n")}`;
}

/**
 * What a module still needs to reach its target, as the Gap cell says it. A
 * criterion within the target left `not-examined` is counted apart: it is
 * not known to be missing, so it is never a gap.
 */
function gapText(g: ModuleGap, scores: Map<string, Score>): string {
  if (g.target === null) return "—";
  const unexamined = g.missing.filter(
    (c) => scores.get(c.key) === NOT_EXAMINED,
  ).length;
  const toGo = g.missing.length - unexamined;
  const parts = [
    ...(toGo > 0 ? [`${toGo} to go`] : []),
    ...(unexamined > 0 ? [`${unexamined} not examined`] : []),
  ];
  return parts.length === 0 ? "reached" : parts.join(", ");
}

/** Each module's level, target and gap under `profile`, in adoption order. */
function gapsTable(
  modules: Module[],
  scores: Map<string, Score>,
  profile: SummaryProfile,
  order: readonly string[],
): string {
  const rows = gaps(modules, scores, profile.targets, order).map(
    (g) =>
      `| ${g.module.module} ${g.module.name} | ${attainmentText(g.attained)} | ${g.target ?? "—"} | ${gapText(g, scores)} |`,
  );
  return `| Module | Level attained | Target | Gap |\n|--------|----------------|--------|-----|\n${rows.join("\n")}`;
}

function summaryCommand(inv: Invocation): number {
  const { positional, modules, profiles, usage } = inv;
  if (positional.length > 1) return usage("summary takes one record");
  const record = readOwn(positional[0] ?? defaultRecord());
  if (record === null) return 1;
  const profile = summaryProfile(record, inv);
  if (profile !== null && "error" in profile) return usage(profile.error);
  const scores = scoresOf(record);
  const unexamined = unexaminedIn(record);
  const footer =
    unexamined > 0 ? `\n\n${unexamined} criteria not examined.` : "";
  if (profile === null) {
    console.log(`${levelsTable(modules, scores)}${footer}`);
    return 0;
  }
  const given =
    inv.profile !== undefined && inv.profile !== record.profile
      ? ` (from --profile; the record declares ${record.profile ?? "none"})`
      : "";
  console.log(
    `Profile: ${profile.name}${given}, modules in adoption order.\n\n${gapsTable(modules, scores, profile, profiles.order)}${footer}`,
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

/**
 * Write `answers` into the draft at `draftPath` (or the file `into` names),
 * then say how many were written and which criteria are still unscored. On a
 * refusal nothing is written.
 */
function writeAnswers(
  draftPath: string,
  source: string,
  answers: ReadonlyMap<string, Answer>,
  problems: readonly string[],
  inv: Invocation,
  done: string,
): number {
  const target = inv.into ?? draftPath;
  let text: string;
  try {
    if (problems.length > 0) throw new DraftEditRefused(problems.join("\n"));
    text = answers.size > 0 ? setScores(source, answers, draftPath) : source;
  } catch (error) {
    if (!(error instanceof DraftEditRefused)) throw error;
    for (const p of error.message.split("\n")) console.error(`- ${p}`);
    console.error(`refused: ${target} is unchanged`);
    return 1;
  }
  writeFileSync(target, text);
  const open = unscored(parseRecord(text, target), inv.modules);
  console.log(`${done.replace("{n}", String(answers.size))} into ${target}`);
  console.log(
    open.length === 0
      ? "every criterion is scored: run record.ts check"
      : `${open.length} still null: ${open.slice(0, 20).join(", ")}${open.length > 20 ? ", …" : ""}`,
  );
  return 0;
}

function fillCommand(inv: Invocation): number {
  if (inv.positional.length !== 2)
    return inv.usage("fill takes a draft and an answers file");
  const [draftPath, answersPath] = inv.positional as [string, string];
  const source = readFileSync(draftPath, "utf8");
  const draft = parseRecord(source, draftPath);
  let given: ReturnType<typeof parseAnswers>;
  try {
    given = parseAnswers(readFileSync(answersPath, "utf8"), answersPath);
  } catch (error) {
    if (!(error instanceof DraftEditRefused)) throw error;
    console.error(
      `- ${error.message}\nrefused: ${inv.into ?? draftPath} is unchanged`,
    );
    return 1;
  }
  const { answers, problems } = checkAnswers(given, draft, inv.modules);
  return writeAnswers(
    draftPath,
    source,
    answers,
    problems,
    inv,
    "filled {n} criteria",
  );
}

function mergeCommand(inv: Invocation): number {
  if (inv.positional.length < 2)
    return inv.usage("merge takes a draft and one or more partial drafts");
  const [draftPath, ...partialPaths] = inv.positional as [string, ...string[]];
  const source = readFileSync(draftPath, "utf8");
  const draft = parseRecord(source, draftPath);
  const partials = partialPaths.map((path) => ({ path, record: read(path) }));
  const { answers, problems } = mergePartials(draft, partials);
  return writeAnswers(
    draftPath,
    source,
    answers,
    problems,
    inv,
    `merged {n} criteria from ${partials.length} partial draft(s)`,
  );
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
  ["fill", fillCommand],
  ["merge", mergeCommand],
]);

const OPTIONS = {
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  date: { type: "string" },
  report: { type: "string" },
  profile: { type: "string" },
  conditions: { type: "string" },
  into: { type: "string" },
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
    profile: values.profile,
    conditions: values.conditions
      ?.split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    into: values.into,
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
