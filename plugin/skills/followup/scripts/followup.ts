#!/usr/bin/env bun
/**
 * The follow-up's protocol: what a pass after a merge (or a preview before
 * it) does in the same order whatever repository it runs in.
 *
 * Usage:
 *   bun followup.ts facts <PR>
 *   bun followup.ts arms [--pr <n>] [--json]
 *   bun followup.ts record <arm> <owed|not-owed|pending|unread> --evidence <text> [--item <ref>]... [--pr <n>]
 *   bun followup.ts guard <PR> --comment <marker> [--repo owner/name]
 *   bun followup.ts settle [--pr <n>] [--json]
 *   bun followup.ts authority [--json]
 *   bun followup.ts release [--pr <n>]
 *
 * - `facts` reads the merge facts (JSON) and starts the run's ledger under
 *   `.context/scratch/followup/`: a merged pull request is followed up, an
 *   open one previewed, any other refused.
 * - `arms` lists the core arms the run settles, minus `followup.off`, and
 *   the ones it skips with why.
 * - `record` writes one arm's verdict with its evidence; empty evidence is
 *   refused.
 * - `guard` checks the run still holds the follow-up's marker before an act
 *   outside the pull request; a preview is refused before anything is asked.
 * - `settle` prints one report row per arm and how the run ends, and
 *   refuses while an arm has no verdict.
 * - `authority` prints what the follow-up may do, as the repository's
 *   `followup.authority` tightens the fixed table.
 * - `release` prints what the release arm reads (JSON): the merge's change
 *   notes, whether each still waits on the integration branch, and the
 *   changelog skill's `status.ts` report from a throwaway checkout of it.
 *
 * Exit codes: 0 done; 1 `facts`: the forge or the clone could not be read,
 * `settle`: an arm has no verdict; 2 usage, a refused verdict or an invalid
 * configuration; 3 `facts`: the pull request is neither merged nor open, or
 * its base is not the integration branch; 4 `guard` in a preview; 5 `facts`:
 * the forge refused for its rate limit (`RATE-LIMITED until <time>`).
 * `guard` otherwise exits as `jig dispatch marker check` did: 1 the forge
 * could not be read, 2 the marker is missing or not trusted, 3 an earlier
 * marker holds the follow-up.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fail, isDigits, runMain } from "../../../shared/cli.ts";
import {
  consumerRoot,
  readConfig,
  remoteName,
  siblingSkill,
} from "../../../shared/consumer.ts";
import { valueAt } from "../../../shared/config-layers.ts";
import { attempt, type Outcome } from "../../../shared/outcome.ts";
import { ghRunFailure } from "../../../shared/outbound/github.ts";
import {
  ghCall,
  git,
  gitIdentityEnv,
  run,
  tsArgv,
} from "../../../shared/proc.ts";
import { type ArmPlan, inOrca, planArms } from "./lib/arms.ts";
import { authorityTable, renderAuthority } from "./lib/authority.ts";
import {
  areasFromPlan,
  type ChangeAreas,
  type Facts,
  type FactsFailure,
  gatherFacts,
  integrationBranchOf,
  PR_VIEW_FIELDS,
  prViewOf,
  type PrView,
} from "./lib/facts.ts";
import { guard } from "./lib/guard.ts";
import {
  readRun,
  recordVerdict,
  type RunFile,
  startRun,
  writeRun,
} from "./lib/run.ts";
import {
  type FollowupSettings,
  parseFollowupSettings,
  runConfig,
  type ShowFile,
} from "./lib/settings.ts";
import { mergeNotes, statusInCheckout } from "./lib/release.ts";
import { renderSettled, settle } from "./lib/settle.ts";
import {
  shellArgv,
  validationPlanCommand,
} from "../../drive-pr/scripts/lib/overlay.ts";

const USAGE = [
  "usage: followup.ts facts <PR>",
  "       followup.ts arms [--pr <n>] [--json]",
  "       followup.ts record <arm> <owed|not-owed|pending|unread> --evidence <text> [--item <ref>]... [--pr <n>]",
  "       followup.ts guard <PR> --comment <marker> [--repo owner/name]",
  "       followup.ts settle [--pr <n>] [--json]",
  "       followup.ts authority [--json]",
  "       followup.ts release [--pr <n>]",
].join("\n");

/** How long a local git call may take. */
const GIT_TIMEOUT_SEC = 60;
/** How long a fetch may take. */
const FETCH_TIMEOUT_SEC = 300;
/** How long the change-area resolver may take. */
const AREAS_TIMEOUT_SEC = 120;
/** How long `status.ts` may take: it asks the forge about the release run and the tags. */
const STATUS_TIMEOUT_SEC = 300;

/** Stop the command with `code`, its reason on standard error. */
function stop(code: number, message: string): never {
  return fail(code, `followup: ${message}`);
}

function usage(message: string): never {
  return fail(2, `followup: ${message}`, USAGE);
}

/** An outcome's value, or the command stopped with `code` and its reason. */
function must<T>(outcome: Outcome<T>, code: number): T {
  if (!outcome.ok) stop(code, outcome.failure.reason);
  return outcome.value;
}

const root = (): string => consumerRoot();

/** The merged configuration of the working tree's layers. */
function workingConfig(): Record<string, unknown> {
  return must(attempt("config-invalid", "the configuration", readConfig), 2);
}

function gitIn(dir: string, timeoutSec = GIT_TIMEOUT_SEC) {
  return (args: string[]) =>
    git(args, { cwd: dir, timeoutSec, env: gitIdentityEnv() });
}

/** A file as a revision holds it, through git. */
function showFile(dir: string): ShowFile {
  const g = gitIn(dir);
  return async (ref, path) => {
    const commit = await g(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
    if (commit.code !== 0) return undefined;
    const exists = await g(["cat-file", "-e", `${ref}:${path}`]);
    if (exists.code !== 0) return null;
    const shown = await g(["show", `${ref}:${path}`]);
    return shown.code === 0 ? shown.stdout : undefined;
  };
}

/** The pull request, through `gh`; a rate limit names when it clears. */
async function viewPr(
  pr: number,
): Promise<Outcome<PrView, "unreadable" | "rate-limited">> {
  const r = await ghCall(["pr", "view", String(pr), "--json", PR_VIEW_FIELDS]);
  return prViewOf(pr, ghRunFailure(r), r.stdout);
}

/** The command that resolves changed files to change areas, and what to call it. */
function areasCommand(): { argv: string[]; by: string } {
  const command = validationPlanCommand();
  if (command !== undefined)
    return { argv: shellArgv(command), by: "drive.validation_plan_command" };
  const resolver = resolve(
    siblingSkill("change-areas", resolve(import.meta.dir)),
    "scripts",
    "resolve.ts",
  );
  return {
    argv: tsArgv(resolver, [
      "--files",
      "-",
      "--format",
      "json",
      "--no-validation",
    ]),
    by: "the change-areas resolver",
  };
}

/**
 * The change areas `files` touch: from the repository's validation plan
 * command (`drive.validation_plan_command`) where it names one, as a drive
 * reads them, else from the change-areas skill's resolver.
 */
async function changeAreasOf(
  dir: string,
  files: string[],
): Promise<ChangeAreas> {
  const { argv, by } = areasCommand();
  const r = await run(argv, {
    cwd: dir,
    stdin: `${files.join("\n")}\n`,
    timeoutSec: AREAS_TIMEOUT_SEC,
  });
  if (r.code === 0) return areasFromPlan(r.stdout, by);
  const said = (r.stderrTail || r.stderr).trim().split("\n")[0] ?? "";
  return { known: false, reason: `${by} exited ${r.code}: ${said}` };
}

/** The follow-up's settings as a run reads them: from the integration branch where the clone has it. */
interface RunSettings {
  settings: FollowupSettings;
  origin: Facts["configOrigin"];
  /** Whether the repository sets `changelog.file`. */
  changelog: boolean;
}

async function settingsFor(
  dir: string,
  remote: string,
  integration: string,
): Promise<RunSettings> {
  const config = must(
    await runConfig(dir, `${remote}/${integration}`, showFile(dir)),
    2,
  );
  const settings = must(parseFollowupSettings(config.values), 2);
  const file = valueAt(config.values, "changelog.file");
  return {
    settings,
    origin: config.origin,
    changelog: typeof file === "string" && file !== "",
  };
}

/** The arms a run of `mode` settles under `read`. */
function planOf(read: RunSettings, mode: Facts["mode"]): ArmPlan {
  return planArms({
    mode,
    changelog: read.changelog,
    orca: inOrca(process.env),
    off: read.settings.off,
  });
}

/** `args` when there are exactly `n` of them; the command stops with `message` otherwise. */
function exactly(args: string[], n: number, message: string): string[] {
  return args.length === n ? args : usage(message);
}

/** A positive whole number, or the command stopped with `message`. */
function numberArg(text: string | undefined, message: string): number {
  return prNumber(text) ?? usage(message);
}

function prNumber(text: string | undefined): number | null {
  return text !== undefined && isDigits(text) && Number(text) > 0
    ? Number(text)
    : null;
}

/** The run `--pr` names, else the newest; the command stops when there is none. */
function loadRun(prFlag: string | undefined): { dir: string; run: RunFile } {
  const pr = prFlag === undefined ? null : prNumber(prFlag);
  if (prFlag !== undefined && pr === null) usage("--pr takes a number");
  const dir = root();
  return { dir, run: must(readRun(dir, pr), 2) };
}

/** The exit of each way `facts` fails. */
const FACTS_EXIT: Record<FactsFailure, number> = {
  unreadable: 1,
  refused: 3,
  "rate-limited": 5,
};

async function factsCommand(args: string[]): Promise<number> {
  const facts = "facts takes one PR number";
  const pr = numberArg(exactly(args, 1, facts)[0], facts);
  const dir = root();
  const values = workingConfig();
  const remote = must(
    attempt("config-invalid", "repository.remote", () => remoteName(dir)),
    2,
  );
  const local = gitIn(dir);
  const integration =
    (await integrationBranchOf(values, remote, local)) ??
    stop(
      2,
      `cannot tell the integration branch: set repository.base_branch, or give the clone a ${remote}/HEAD`,
    );
  const read = await settingsFor(dir, remote, integration);
  const gathered = await gatherFacts(pr, integration, {
    view: viewPr,
    git: local,
    fetch: gitIn(dir, FETCH_TIMEOUT_SEC),
    areas: (files) => changeAreasOf(dir, files),
    values,
    remote,
    configOrigin: read.origin,
  });
  if (!gathered.ok)
    stop(FACTS_EXIT[gathered.failure.code], gathered.failure.reason);
  startRun(dir, gathered.value, planOf(read, gathered.value.mode));
  console.log(JSON.stringify(gathered.value, null, 2));
  return 0;
}

/** The plan as lines for a person. */
function armLines(run: RunFile): string[] {
  return [
    `Arms of the follow-up of PR #${run.pr} (${run.facts.mode}):`,
    ...run.arms.apply.map((id) => `- ${id}`),
    ...run.arms.skipped.map((s) => `- ${s.id}: skipped, ${s.reason}`),
  ];
}

async function armsCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { pr: { type: "string" }, json: { type: "boolean" } },
    strict: true,
  });
  const { dir, run: loaded } = loadRun(values.pr);
  const { facts } = loaded;
  const read = await settingsFor(dir, facts.remote, facts.integrationBranch);
  const updated = { ...loaded, arms: planOf(read, facts.mode) };
  writeRun(dir, updated);
  console.log(
    values.json
      ? JSON.stringify(updated.arms, null, 2)
      : armLines(updated).join("\n"),
  );
  return 0;
}

async function recordCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      evidence: { type: "string" },
      item: { type: "string", multiple: true, default: [] },
      pr: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const [arm = "", verdict = ""] = exactly(
    positionals,
    2,
    "record takes an arm and a verdict",
  );
  const evidence =
    values.evidence ??
    usage("record needs --evidence <the checkable fact that settled it>");
  const { dir, run: loaded } = loadRun(values.pr);
  const recorded = recordVerdict(loaded, arm, verdict, evidence, values.item);
  writeRun(dir, must(recorded, 2));
  console.log(`recorded ${arm}: ${verdict}`);
  return 0;
}

async function guardCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { comment: { type: "string" }, repo: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const message = "guard takes a PR number and --comment <marker id>";
  const pr = numberArg(exactly(positionals, 1, message)[0], message);
  const marker = numberArg(values.comment, message);
  const { dir, run: loaded } = loadRun(String(pr));
  const answer = await guard(pr, marker, {
    mode: loaded.facts.mode,
    repo: values.repo,
  });
  if (answer.exit !== 0) stop(answer.exit, answer.message);
  writeRun(dir, { ...loaded, marker });
  console.log(answer.message);
  return 0;
}

async function settleCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { pr: { type: "string" }, json: { type: "boolean" } },
    strict: true,
  });
  const settled = must(settle(loadRun(values.pr).run), 1);
  console.log(
    values.json ? JSON.stringify(settled, null, 2) : renderSettled(settled),
  );
  return 0;
}

async function authorityCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { json: { type: "boolean" } },
    strict: true,
  });
  const settings = must(parseFollowupSettings(workingConfig()), 2);
  const table = authorityTable(settings.authority);
  console.log(
    values.json ? JSON.stringify(table, null, 2) : renderAuthority(table),
  );
  return 0;
}

/** `changelog.notes_dir`, else the changelog skill's default. */
function notesDirOf(values: Record<string, unknown>): string {
  const configured = valueAt(values, "changelog.notes_dir");
  return typeof configured === "string" && configured !== ""
    ? configured
    : "changes";
}

async function releaseCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { pr: { type: "string" } },
    strict: true,
  });
  const { dir, run: loaded } = loadRun(values.pr);
  const { facts } = loaded;
  const notesDir = notesDirOf(workingConfig());
  const integrationRef = `${facts.remote}/${facts.integrationBranch}`;
  await gitIn(
    dir,
    FETCH_TIMEOUT_SEC,
  )([
    "fetch",
    "--no-tags",
    facts.remote,
    `+refs/heads/${facts.integrationBranch}:refs/remotes/${integrationRef}`,
  ]);
  const local = gitIn(dir);
  const notes =
    facts.range === null
      ? { notes: [], error: "the facts hold no diff range" }
      : await mergeNotes(local, facts.range, notesDir, integrationRef);
  const statusScript = resolve(
    siblingSkill("changelog", resolve(import.meta.dir)),
    "scripts",
    "status.ts",
  );
  const status = await statusInCheckout(local, integrationRef, (checkout) =>
    run(tsArgv(statusScript, ["--root", checkout, "--json"]), {
      cwd: dir,
      timeoutSec: STATUS_TIMEOUT_SEC,
    }),
  );
  const report = { notesDir, notes: notes.notes, notesRead: notes.error };
  console.log(JSON.stringify({ ...report, status }, null, 2));
  return 0;
}

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  facts: factsCommand,
  arms: armsCommand,
  record: recordCommand,
  guard: guardCommand,
  settle: settleCommand,
  authority: authorityCommand,
  release: releaseCommand,
};

/** Whether `error` is `node:util`'s refusal of an unknown or malformed option. */
function refusedOption(error: unknown): error is TypeError {
  return error instanceof TypeError && "code" in error;
}

async function help(_args: string[]): Promise<number> {
  console.log(USAGE);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [name = "", ...rest] = argv;
  const handler =
    { ...COMMANDS, "--help": help, "-h": help }[name] ??
    usage(`unknown command ${JSON.stringify(name)}`);
  return handler(rest).catch(usageOrRethrow);
}

/** `node:util`'s refusal of an option as a usage error; anything else rethrown. */
function usageOrRethrow(error: unknown): never {
  if (refusedOption(error)) usage(error.message);
  throw error;
}

if (import.meta.main) runMain("followup", () => main(process.argv.slice(2)));
