#!/usr/bin/env bun
/**
 * The follow-up's protocol: what a pass after a merge (or a preview before
 * it) does in the same order whatever repository it runs in.
 *
 * Usage:
 *   bun followup.ts facts <PR>
 *   bun followup.ts arms [--pr <n>] [--json]
 *   bun followup.ts record <arm> <owed|not-owed|pending|unread> --evidence <text> [--item <ref>]... [--pr <n>]
 *   bun followup.ts check <arm> [--pr <n>]
 *   bun followup.ts instructions <arm> [--pr <n>]
 *   bun followup.ts guard <PR> --comment <marker> [--repo owner/name]
 *   bun followup.ts settle [--pr <n>] [--json]
 *   bun followup.ts authority [--pr <n>] [--json]
 *   bun followup.ts release [--pr <n>]
 *
 * - `facts` reads the merge facts (JSON) and starts the run's ledger under
 *   `.context/scratch/followup/`: a merged pull request is followed up, an
 *   open one previewed, any other refused.
 * - `arms` lists the arms the run settles: the core arms minus
 *   `followup.off`, with the repository's own (`followup.arms`) before the
 *   next step, and the ones it skips with why.
 * - `record` writes one arm's verdict with its evidence; empty evidence is
 *   refused.
 * - `check` runs a repository arm's check command, as the integration
 *   branch's configuration names it, and records its verdict; a check that
 *   does not answer is recorded `unread`.
 * - `instructions` prints a repository arm's instructions file as the
 *   integration branch holds it.
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
 * `settle`: an arm has no verdict, `instructions`: the integration branch's
 * file could not be read; 2 usage, a refused verdict or an invalid
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
  remoteName,
  siblingSkill,
} from "../../../shared/consumer.ts";
import { valueAt } from "../../../shared/config-layers.ts";
import { attempt, failed, type Outcome } from "../../../shared/outcome.ts";
import { ghRunFailure } from "../../../shared/outbound/github.ts";
import {
  ghCall,
  git,
  gitIdentityEnv,
  run,
  tsArgv,
} from "../../../shared/proc.ts";
import {
  runRepoCommand,
  withDefaultBranchTree,
} from "../../../shared/repo-command.ts";
import { type ArmPlan, inOrca, planArms, repoArmOf } from "./lib/arms.ts";
import {
  type CheckAnswer,
  checkInstructionFiles,
  describeArm,
  type RepoArm,
  recordCheck,
  runCheck,
  withRepoArms,
} from "./lib/repo-arms.ts";
import {
  authorityTable,
  LEVEL_WORDS,
  renderAuthority,
} from "./lib/authority.ts";
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
import { verifyRemoteIsPrRepo } from "../../drive-pr/scripts/lib/base-drift.ts";
import {
  shellArgv,
  validationPlanCommand,
} from "../../drive-pr/scripts/lib/overlay.ts";

const USAGE = [
  "usage: followup.ts facts <PR>",
  "       followup.ts arms [--pr <n>] [--json]",
  "       followup.ts record <arm> <owed|not-owed|pending|unread> --evidence <text> [--item <ref>]... [--pr <n>]",
  "       followup.ts check <arm> [--pr <n>]",
  "       followup.ts instructions <arm> [--pr <n>]",
  "       followup.ts guard <PR> --comment <marker> [--repo owner/name]",
  "       followup.ts settle [--pr <n>] [--json]",
  "       followup.ts authority [--pr <n>] [--json]",
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
  /** Configuration read from the integration branch, never the preview tree. */
  values: Record<string, unknown>;
  origin: Facts["configOrigin"];
  /** The integration branch's ref the settings were read from, where `origin` says so. */
  ref: string;
  /** Whether the repository sets `changelog.file`. */
  changelog: boolean;
}

async function settingsFor(
  dir: string,
  remote: string,
  integration: string,
): Promise<RunSettings> {
  const ref = `${remote}/${integration}`;
  const show = showFile(dir);
  const config = must(await runConfig(dir, ref, show), 2);
  const settings = must(parseFollowupSettings(config.values), 2);
  if (config.origin === "integration branch")
    must(
      await checkInstructionFiles(config.values, settings.arms, ref, show),
      2,
    );
  const file = valueAt(config.values, "changelog.file");
  return {
    settings,
    values: config.values,
    origin: config.origin,
    ref,
    changelog: typeof file === "string" && file !== "",
  };
}

/** The arms a run over `facts` settles under `read`: the core arms, with the repository's own before the next step. */
function planOf(read: RunSettings, facts: Facts): ArmPlan {
  const core = planArms({
    mode: facts.mode,
    changelog: read.changelog,
    orca: inOrca(process.env),
    off: read.settings.off,
  });
  return withRepoArms(core, read.settings.arms, facts.mode, facts.changeAreas);
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

/** The settings a freshly fetched snapshot of `branch` holds; a failed fetch or an unreadable snapshot stops the run. */
async function fetchedPolicy(
  dir: string,
  remote: string,
  branch: string,
): Promise<RunSettings> {
  const policyRef = `${remote}/${branch}`;
  const refspec = `+refs/heads/${branch}:refs/remotes/${policyRef}`;
  const fetch = gitIn(dir, FETCH_TIMEOUT_SEC);
  const fetched = await fetch(["fetch", "--no-tags", remote, refspec]);
  if (fetched.code !== 0)
    stop(
      1,
      `the fetch of ${policyRef} exited ${fetched.code}: its policy may be stale`,
    );
  const read = await settingsFor(dir, remote, branch);
  const unread =
    read.origin !== "integration branch" && !process.env.JIG_OVERLAY;
  if (unread) stop(1, `the configuration at ${policyRef} cannot be read`);
  return read;
}

/** The `repository.base_branch` a snapshot names when it is not `head`. */
function otherBranch(
  values: Record<string, unknown>,
  head: string,
): string | null {
  const named = valueAt(values, "repository.base_branch");
  return typeof named === "string" && named !== "" && named !== head
    ? named
    : null;
}

/**
 * The integration branch and the settings its snapshot holds.  The remote's
 * HEAD bootstraps the choice, since the working tree and the pull request are
 * the preview's own; the configuration read from that branch may name another
 * `repository.base_branch`, whose snapshot then decides.
 */
async function trustedPolicy(
  dir: string,
  remote: string,
): Promise<{ integration: string; read: RunSettings }> {
  const head = await integrationBranchOf({}, remote, gitIn(dir));
  if (head === null)
    return stop(
      2,
      `the remote's HEAD is unknown: run git remote set-head ${remote} -a`,
    );
  const first = await fetchedPolicy(dir, remote, head);
  const named = otherBranch(first.values, head);
  return named === null
    ? { integration: head, read: first }
    : { integration: named, read: await fetchedPolicy(dir, remote, named) };
}

/** Stops unless `remote` fetches from the repository the pull request belongs to. */
async function bindRemoteToPr(
  dir: string,
  remote: string,
  prUrl: string,
): Promise<void> {
  const repo = /^https?:\/\/[^/]+\/([^/\s]+\/[^/\s]+)\/pull\/\d+\/?$/.exec(
    prUrl,
  );
  if (repo === null)
    return stop(
      1,
      `cannot tell the repository of the pull request from ${prUrl}`,
    );
  const check = await verifyRemoteIsPrRepo(
    (args, opts) =>
      git(args, {
        cwd: dir,
        timeoutSec: opts?.timeoutSec ?? GIT_TIMEOUT_SEC,
        env: gitIdentityEnv(),
      }),
    dir,
    repo[1] as string,
    undefined,
    remote,
    prUrl,
  );
  if (!check.ok) stop(2, `cannot trust the policy of ${remote}: ${check.why}`);
}

async function factsCommand(args: string[]): Promise<number> {
  const facts = "facts takes one PR number";
  const pr = numberArg(exactly(args, 1, facts)[0], facts);
  const dir = root();
  const remote = must(
    attempt("config-invalid", "repository.remote", () => remoteName(dir)),
    2,
  );
  const local = gitIn(dir);
  const viewed = await viewPr(pr);
  if (!viewed.ok) stop(FACTS_EXIT[viewed.failure.code], viewed.failure.reason);
  await bindRemoteToPr(dir, remote, viewed.value.url);
  const { integration, read } = await trustedPolicy(dir, remote);
  const gathered = await gatherFacts(pr, integration, {
    view: async () => viewed,
    git: local,
    fetch: gitIn(dir, FETCH_TIMEOUT_SEC),
    areas: (files) => changeAreasOf(dir, files),
    values: read.values,
    remote,
    configOrigin: read.origin,
  });
  if (!gathered.ok)
    stop(FACTS_EXIT[gathered.failure.code], gathered.failure.reason);
  startRun(dir, gathered.value, planOf(read, gathered.value));
  console.log(JSON.stringify(gathered.value, null, 2));
  return 0;
}

/** The plan as lines for a person. */
function armLines(run: RunFile): string[] {
  return [
    `Arms of the follow-up of PR #${run.pr} (${run.facts.mode}):`,
    ...run.arms.apply.map((id) => {
      const repo = repoArmOf(run.arms, id);
      return repo === undefined ? `- ${id}` : `- ${id}: ${describeArm(repo)}`;
    }),
    ...run.arms.skipped.map((s) => `- ${s.id}: skipped, ${s.reason}`),
  ];
}

/**
 * The run's verdicts that still stand under the replanned `arms`: a
 * repository arm whose declaration changed (its check command, instructions
 * or skill) has to be settled again, and a verdict of an arm the plan no
 * longer applies is dropped.
 */
function keepCurrentVerdicts(run: RunFile, arms: ArmPlan): RunFile["verdicts"] {
  return Object.fromEntries(
    Object.entries(run.verdicts).filter(
      ([id]) =>
        arms.apply.includes(id) &&
        JSON.stringify(repoArmOf(run.arms, id) ?? null) ===
          JSON.stringify(repoArmOf(arms, id) ?? null),
    ),
  );
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
  const arms = planOf(read, facts);
  const updated = {
    ...loaded,
    arms,
    verdicts: keepCurrentVerdicts(loaded, arms),
  };
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

/**
 * Repository arm `id` of the run, as the configuration declares it now (from
 * the integration branch where the clone has it), with the settings it was
 * read with; the command stops when the run does not settle it.
 */
async function declaredArm(
  dir: string,
  loaded: RunFile,
  id: string,
): Promise<{ arm: RepoArm; read: RunSettings }> {
  const skipped = loaded.arms.skipped.find((s) => s.id === id);
  if (skipped !== undefined)
    usage(`${id} is not an arm of this run: ${skipped.reason}`);
  if (!loaded.arms.apply.includes(id))
    usage(
      `${JSON.stringify(id)} is not an arm of this run (${loaded.arms.apply.join(", ")}); run arms again after a change to followup.arms`,
    );
  const { remote, integrationBranch } = loaded.facts;
  const read = await settingsFor(dir, remote, integrationBranch);
  const arm =
    read.settings.arms.find((a) => a.id === id) ??
    usage(`${id} is no repository arm (followup.arms) of the configuration`);
  return { arm, read };
}

/** The positional arm of `check` or `instructions`, and `--pr`. */
function armArgs(args: string[], name: string) {
  const { values, positionals } = parseArgs({
    args,
    options: { pr: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const [id = ""] = exactly(positionals, 1, `${name} takes one arm`);
  return { id, pr: values.pr };
}

/**
 * What running `arm`'s check command answers. The command and the program it
 * runs both come from the integration branch's files, copied to a directory
 * of their own: a pull request's edit of the script never executes. It runs
 * only where `followup.authority.read-only-checks` leaves it to the
 * follow-up.
 */
async function checkAnswer(
  dir: string,
  loaded: RunFile,
  arm: RepoArm,
  command: string,
  read: RunSettings,
): Promise<CheckAnswer> {
  const refusal = checkRefusal(arm, read);
  if (refusal !== null)
    return { verdict: "unread", evidence: refusal, items: [] };
  const commit = await gitIn(dir)([
    "rev-parse",
    "--verify",
    "-q",
    `${read.ref}^{commit}`,
  ]);
  const id = commit.stdout.trim();
  const ran =
    commit.code === 0 && id !== ""
      ? await withDefaultBranchTree(dir, id, (tree) =>
          runCheck(
            { ...arm, checkCommand: command },
            loaded.facts,
            tree,
            runRepoCommand,
          ),
        )
      : failed("unreadable", `${read.ref} could not be resolved to a commit`);
  return ran.ok
    ? ran.value
    : {
        verdict: "unread",
        evidence: `${arm.id}'s check command was not run: ${ran.failure.reason}`,
        items: [],
      };
}

/** Why `arm`'s check command may not run under `read`; `null` when it may. */
function checkRefusal(arm: RepoArm, read: RunSettings): string | null {
  if (read.origin !== "integration branch")
    return `${read.ref} could not be read, so no check command was run: the working tree's configuration is not the reviewed one`;
  const level = read.settings.authority["read-only-checks"] ?? "own";
  return level === "own"
    ? null
    : `followup.authority.read-only-checks is ${level} (${LEVEL_WORDS[level]}), so the check command of ${arm.id} was not run: a person runs it, or moves the act back to own`;
}

async function checkCommand(args: string[]): Promise<number> {
  const { id, pr } = armArgs(args, "check");
  const { dir, run: loaded } = loadRun(pr);
  const { arm, read } = await declaredArm(dir, loaded, id);
  const command =
    arm.checkCommand ?? usage(`${id} has no check_command to run`);
  const answer = await checkAnswer(dir, loaded, arm, command, read);
  const recorded = must(recordCheck(loaded, id, answer), 2);
  writeRun(dir, recorded);
  console.log(JSON.stringify({ arm: id, ...recorded.verdicts[id] }, null, 2));
  return 0;
}

async function instructionsCommand(args: string[]): Promise<number> {
  const { id, pr } = armArgs(args, "instructions");
  const { dir, run: loaded } = loadRun(pr);
  const { arm, read } = await declaredArm(dir, loaded, id);
  const path = arm.instructions ?? usage(`${id} has no instructions file`);
  const unreadable = `${id}'s instructions (${path}) are read from ${read.ref} alone`;
  if (read.origin !== "integration branch")
    stop(1, `${unreadable}, which could not be read: record ${id} unread`);
  const text = await showFile(dir)(read.ref, path);
  if (typeof text !== "string")
    stop(1, `${unreadable}, where it could not be read: record ${id} unread`);
  process.stdout.write(text);
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
    options: { json: { type: "boolean" }, pr: { type: "string" } },
    strict: true,
  });
  const { dir, run: loaded } = loadRun(values.pr);
  const read = await settingsFor(
    dir,
    loaded.facts.remote,
    loaded.facts.integrationBranch,
  );
  const table = authorityTable(read.settings.authority);
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
  const integrationRef = `${facts.remote}/${facts.integrationBranch}`;
  const fetched = await gitIn(
    dir,
    FETCH_TIMEOUT_SEC,
  )([
    "fetch",
    "--no-tags",
    facts.remote,
    `+refs/heads/${facts.integrationBranch}:refs/remotes/${integrationRef}`,
  ]);
  const local = gitIn(dir);
  const notesDir = notesDirOf(
    (await settingsFor(dir, facts.remote, facts.integrationBranch)).values,
  );
  const notes =
    fetched.code !== 0
      ? {
          notes: [],
          error: `the fetch of ${integrationRef} exited ${fetched.code}, so its state is stale`,
        }
      : facts.range === null
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
  check: checkCommand,
  instructions: instructionsCommand,
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
