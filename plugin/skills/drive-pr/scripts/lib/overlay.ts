import { shellQuote } from "../../../../shared/cli.ts";
import { definedFields } from "../../../../shared/defined-fields.ts";
/**
 * The consumer repository's drive-loop values, read from its Jig
 * configuration (every layer, `.config/jig.yaml` among them) through the
 * review skill's reader.
 *
 * Every field here is optional and has a mechanism default, so a repository
 * without the file still drives: the review skill that each round spawns is
 * what refuses to run in a repository that has not adopted the plugin. A file
 * that exists but cannot be parsed, or a field of the wrong type, is an error
 * rather than a silent default.
 */
import { isAbsolute, join } from "node:path";
import { layersFingerprint } from "../../../../shared/config-layers.ts";
import { DecodeError, isDistinctNameList } from "../../../../shared/guards.ts";
import {
  botEntries,
  configSource,
  consumerRoot,
  readConfig,
  readRemoteName,
  remoteName,
  type ReviewBot,
} from "../../../../shared/consumer.ts";
import { verifyRemoteIsPrRepo } from "./base-drift.ts";
import { attachedTree } from "./driven-branch.ts";
import { ghCall, git, gitCallTimeoutSeconds } from "./proc.ts";

let cache: { key: string; value: Record<string, unknown> } | undefined;

/**
 * The merged configuration, or `{}` when no layer exists. Re-read only when a
 * layer's path, size or modification time, or a `JIG__` variable, changes:
 * evidence predicates ask once per comment.
 */
export function readOptionalOverlay(): Record<string, unknown> {
  const root = consumerRoot();
  const key = `${root}\0${layersFingerprint(root)}`;
  if (cache?.key === key) return cache.value;
  const value = readConfig();
  cache = { key, value };
  return value;
}

function section(name: string): Record<string, unknown> {
  const value = readOptionalOverlay()[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object: ${configSource(name)}`);
  return value as Record<string, unknown>;
}

/** A nonempty string field of one overlay section, if set. */
export function optionalOverlayString(
  sectionName: string,
  key: string,
): string | undefined {
  return optionalString(sectionName, key);
}

function optionalString(sectionName: string, key: string): string | undefined {
  const value = section(sectionName)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(
      `${sectionName}.${key} must be a nonempty string: ${configSource(`${sectionName}.${key}`)}`,
    );
  return value;
}

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * The check-run app slug whose runs and sticky comment are the AI reviewer's
 * evidence: `DRIVE_PR_REVIEWER_APP`, else `review.reviewer_app`, else `""`
 * (none configured: reviewer checks are recognised by name alone).
 */
export function reviewerApp(): string {
  return (
    nonEmptyEnv("DRIVE_PR_REVIEWER_APP") ??
    optionalString("review", "reviewer_app") ??
    ""
  );
}

/**
 * Does the repository have an AI reviewer for the drive to wait on? Only when
 * it names one: an app (`review.reviewer_app`, `DRIVE_PR_REVIEWER_APP`) or a
 * check-run name (`review.reviewer_check_pattern`, `DRIVE_PR_REVIEWER_CHECK`).
 * The built-in check-run pattern is a default for a repository that has said
 * it has a reviewer, not a claim that every repository does, so without
 * either the drive takes no reviewer evidence and converges on threads and CI.
 */
export function reviewerExpected(): boolean {
  return (
    nonEmptyEnv("DRIVE_PR_REVIEWER_APP") !== undefined ||
    nonEmptyEnv("DRIVE_PR_REVIEWER_CHECK") !== undefined ||
    optionalString("review", "reviewer_app") !== undefined ||
    optionalString("review", "reviewer_check_pattern") !== undefined
  );
}

/** How messages name the reviewer: its app slug, or a generic phrase. */
export function reviewerLabel(): string {
  const app = reviewerApp();
  return app === "" ? "the AI reviewer" : `'${app}'`;
}

/**
 * The anchored pattern naming the posting reviewer's check run:
 * `DRIVE_PR_REVIEWER_CHECK`, else `review.reviewer_check_pattern`, else
 * `AI review` with an optional parenthesised arm suffix.
 */
export function reviewerCheckPattern(): string {
  return (
    nonEmptyEnv("DRIVE_PR_REVIEWER_CHECK") ??
    optionalString("review", "reviewer_check_pattern") ??
    "^ai[ _-]?review(\\s*\\(.+\\))?$"
  );
}

/**
 * The marker that identifies the reviewer's sticky summary comment:
 * `DRIVE_PR_STICKY_MARKER`, else `review.sticky_marker`, else
 * `<!-- ai-code-review -->`.
 */
export function stickyMarker(): string {
  return (
    nonEmptyEnv("DRIVE_PR_STICKY_MARKER") ??
    optionalString("review", "sticky_marker") ??
    "<!-- ai-code-review -->"
  );
}

/**
 * The marker the reviewer stamps its reviewed commit with in that comment:
 * `DRIVE_PR_SHA_MARKER`, else `review.reviewed_sha_marker`, else
 * `ai-reviewed-sha`.
 */
export function reviewedShaMarker(): string {
  return (
    nonEmptyEnv("DRIVE_PR_SHA_MARKER") ??
    optionalString("review", "reviewed_sha_marker") ??
    "ai-reviewed-sha"
  );
}

/**
 * `review.bots` as entries, each a login or `{login, …markers}`; `undefined`
 * when the field is not a list. Entries of another shape are dropped, as
 * this best-effort reader always has.
 */
export function reviewBotEntries(): (string | ReviewBot)[] | undefined {
  const bots = section("review").bots;
  if (!Array.isArray(bots)) return undefined;
  return bots.filter(
    (b): b is string | ReviewBot =>
      (typeof b === "string" && b !== "") ||
      (typeof b === "object" &&
        b !== null &&
        typeof (b as { login?: unknown }).login === "string" &&
        (b as { login: string }).login !== ""),
  );
}

/** `review.bots`: the logins the review skill treats as reviewers. */
export function reviewBots(): string[] {
  return botEntries(reviewBotEntries() ?? []).map((b) => b.login);
}

/**
 * `review.severity_formats`, unparsed: `lib/severity-formats.ts` validates
 * it.
 */
export function reviewSeverityFormats(): unknown {
  return section("review").severity_formats;
}

/**
 * Is this comment author the posting reviewer, whose sticky comment is a
 * witness? Its app's bot login when an app is configured, else any login in
 * `review.bots`.
 */
export function isReviewerLogin(login: string): boolean {
  const app = reviewerApp();
  if (app !== "") return login === `${app}[bot]`;
  return login !== "" && reviewBots().includes(login);
}

/** `gates.command`: the repository's complete local checks, if declared. */
export function gatesCommand(): string | undefined {
  return optionalString("gates", "command");
}

/**
 * `drive.validation_plan_command`: changed files on stdin (one per line), the
 * validation plan as JSON on stdout.
 */
export function validationPlanCommand(): string | undefined {
  return optionalString("drive", "validation_plan_command");
}

/** `drive.load_guard_command`: waits until the machine can take heavy checks. */
export function loadGuardCommand(): string | undefined {
  return optionalString("drive", "load_guard_command");
}

/**
 * `drive.change_areas_catalog`, resolved against the repository root, or
 * `undefined` when not configured.
 */
export function changeAreasCatalogPath(
  root = consumerRoot(),
): string | undefined {
  const path = optionalString("drive", "change_areas_catalog");
  if (path === undefined) return undefined;
  return isAbsolute(path) ? path : join(root, path);
}

/** `drive.reviews_drafts`: does the AI reviewer review draft PRs; `undefined` when unknown. */
export function reviewsDrafts(): boolean | undefined {
  const value = section("drive").reviews_drafts;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean")
    throw new Error(
      `drive.reviews_drafts must be true or false: ${configSource("drive.reviews_drafts")}`,
    );
  return value;
}

/** The round budget a drive gets when neither `--max-rounds` nor `drive.max_rounds` sets one. */
export const DEFAULT_MAX_ROUNDS = 10;

/** `drive.max_rounds`: the repository's default round budget; `undefined` when not configured. */
export function maxRoundsSetting(): number | undefined {
  const value = section("drive").max_rounds;
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(
      `drive.max_rounds must be a whole number of at least 1: ${configSource("drive.max_rounds")}`,
    );
  return value as number;
}

/** How many passes killed at their deadline a drive restarts from before it stops. */
export const DEFAULT_PASS_DEADLINE_RETRIES = 2;

/** `drive.pass_deadline_retries`: whole number ≥ 0; `undefined` when not configured. */
export function passDeadlineRetriesSetting(): number | undefined {
  const value = section("drive").pass_deadline_retries;
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new DecodeError(
      configSource("drive.pass_deadline_retries"),
      "$.drive.pass_deadline_retries",
      "must be a whole number of at least 0",
    );
  return value as number;
}

/** The model each pass runs on when neither `--pass-model` nor `drive.pass_model` names one: Claude Code's alias for the latest Sonnet. */
export const DEFAULT_PASS_MODEL = "sonnet";

/**
 * A model as a pass command takes it: one word that does not start with a
 * dash (a model id, a Claude Code alias such as `sonnet`, or a routing tier).
 */
export const PASS_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;

/** `drive.pass_model`: the model, alias or routing tier each pass runs on; `undefined` when not configured. */
export function passModelSetting(): string | undefined {
  const value = section("drive").pass_model;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !PASS_MODEL_PATTERN.test(value))
    throw new DecodeError(
      configSource("drive.pass_model"),
      "$.drive.pass_model",
      "must be one word naming a model, a Claude Code alias or a routing tier",
    );
  return value;
}

/** The extra arguments a pass command gets when neither `--pass-args` nor `drive.pass_args` names any. */
export const DEFAULT_PASS_ARGS: readonly string[] = [];

/** One word of a pass command's extra arguments: no whitespace. */
export const PASS_ARG_PATTERN = /^\S+$/;

/**
 * Why `words` cannot be extra arguments of a pass command, `undefined` when
 * they can: the model has its own setting, and the drive writes the prompt.
 */
export function refusedPassArgs(words: readonly string[]): string | undefined {
  if (words.includes("--"))
    return "cannot hold --: it would end the pass command's options and turn -p into its prompt";
  const word = words.find(
    (w) =>
      w === "-p" ||
      w === "--print" ||
      w === "--model" ||
      w.startsWith("--model="),
  );
  return word === undefined
    ? undefined
    : `cannot hold ${word}: drive.pass_model or --pass-model sets the model, and the drive writes -p and its prompt`;
}

/** `drive.pass_args`: extra arguments for a Claude Code pass command; `undefined` when not configured. */
export function passArgsSetting(): string[] | undefined {
  const value = section("drive").pass_args;
  if (value === undefined || value === null) return undefined;
  const refuse = (detail: string) =>
    new DecodeError(
      configSource("drive.pass_args"),
      "$.drive.pass_args",
      detail,
    );
  if (
    !Array.isArray(value) ||
    !value.every((w) => typeof w === "string" && PASS_ARG_PATTERN.test(w))
  )
    throw refuse(
      "must be a list of words, each a string without spaces, such as [--permission-mode, bypassPermissions]",
    );
  const refused = refusedPassArgs(value);
  if (refused !== undefined) throw refuse(refused);
  return value;
}

/** How a skill arms a drive: `do_item.arm_drive`'s values. */
export const ARM_DRIVE_MODES = ["auto", "tab", "background", "print"] as const;
export type ArmDriveMode = (typeof ARM_DRIVE_MODES)[number];

/** How a drive is armed when `do_item.arm_drive` is not set. */
export const DEFAULT_ARM_DRIVE: ArmDriveMode = "auto";

/** Whether `value` is one of `do_item.arm_drive`'s values. */
export function isArmDriveMode(value: unknown): value is ArmDriveMode {
  return ARM_DRIVE_MODES.some((mode) => mode === value);
}

/** `do_item.arm_drive`: how do-item and drive-pr arm a drive; `undefined` when not configured. */
export function armDriveSetting(): ArmDriveMode | undefined {
  const value = section("do_item").arm_drive;
  if (value === undefined || value === null) return undefined;
  if (!isArmDriveMode(value))
    throw new DecodeError(
      configSource("do_item.arm_drive"),
      "$.do_item.arm_drive",
      `must be one of ${ARM_DRIVE_MODES.join(", ")}`,
    );
  return value;
}

/**
 * `ci.required_checks`: the exact check-run names that certify a head, or
 * `undefined` when not configured (the drive then derives them from the base
 * branch's protection). An empty list is a deliberate "none".
 */
export function requiredChecksSetting(): string[] | undefined {
  const value = section("ci").required_checks;
  if (value === undefined || value === null) return undefined;
  if (!isDistinctNameList(value))
    throw new Error(
      `ci.required_checks must be a list of distinct nonempty check names: ${configSource("ci.required_checks")}`,
    );
  return value;
}

/**
 * `ci.hold_label`: the label the repository's workflows honour by skipping
 * their expensive jobs on intermediate pushes, or `undefined` when the
 * repository has no such convention (every push runs its normal CI).
 */
export function ciHoldLabelSetting(): string | undefined {
  return optionalString("ci", "hold_label");
}

/**
 * Argv that runs a configured command line through the platform shell. The
 * command is the consumer's own text from its configuration file, so it is a
 * shell command by contract.
 */
export function shellArgv(command: string): string[] {
  return process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", command]
    : ["sh", "-c", command];
}

const baseBranchCache = new Map<string, string | null>();

/**
 * The branch pull requests target and rounds diff against, without the
 * remote prefix: `DRIVE_PR_BASE_BRANCH`, else `repository.base_branch`, else
 * derived — the clone's `<remote>/HEAD` when it has one (no network; the
 * remote is `repository.remote`, else `origin`), else
 * `gh repo view --json defaultBranchRef`. A derived answer is cached per
 * process and repository.
 * `null` when none of them answers; callers fail closed on it.
 */
export async function baseBranch(
  root: string,
  timeoutSec?: number,
): Promise<string | null> {
  const explicit =
    nonEmptyEnv("DRIVE_PR_BASE_BRANCH") ??
    optionalString("repository", "base_branch");
  if (explicit !== undefined) return explicit;
  const cached = baseBranchCache.get(root);
  if (cached !== undefined) return cached;
  let derived: string | null = null;
  const remote = remoteName(consumerRoot(root));
  const head = await git(
    [
      "-C",
      root,
      "symbolic-ref",
      "--quiet",
      "--short",
      `refs/remotes/${remote}/HEAD`,
    ],
    { stderr: "ignore", timeoutSec: gitTimeout(timeoutSec) },
  );
  const fromHead = head.stdout.trim();
  if (head.code === 0 && fromHead.startsWith(`${remote}/`))
    derived = fromHead.slice(`${remote}/`.length);
  if (derived === null) {
    const view = await ghCall(
      [
        "repo",
        "view",
        "--json",
        "defaultBranchRef",
        "-q",
        ".defaultBranchRef.name",
      ],
      {
        cwd: root,
        stderr: "ignore",
        ...definedFields({ timeoutSec }),
      },
    );
    const name = view.stdout.trim();
    if (view.code === 0 && /^[^\s~^:?*[\\]+$/.test(name)) derived = name;
  }
  // Only an answer is cached: a call that failed, or ran out of a caller's
  // tighter deadline, is retried by the next caller.
  if (derived !== null) baseBranchCache.set(root, derived);
  return derived;
}

/** The sentence a caller prints when `baseBranch` returns `null`. */
export function baseBranchUnknown(remote: string): string {
  return `the base branch is unknown: set repository.base_branch in .config/jig.yaml (or DRIVE_PR_BASE_BRANCH), or give this clone a ${remote}/HEAD (git remote set-head ${remote} --auto)`;
}

/**
 * The branch pull request `pr` targets, without the remote prefix, or `null`
 * when it cannot be read. `pr === ""` reads the pull request of the current
 * branch, or the one a detached tree's attach recorded. For a stacked layer
 * this is the layer below, not the integration
 * branch.
 */
export async function pullRequestBaseBranch(
  root: string,
  pr: string,
  timeoutSec?: number,
): Promise<string | null> {
  pr = await attachedPr(root, pr, timeoutSec);
  const selector = pr === "" ? [] : [pr];
  const view = await ghCall(
    ["pr", "view", ...selector, "--json", "baseRefName", "-q", ".baseRefName"],
    {
      cwd: root,
      stderr: "ignore",
      ...definedFields({ timeoutSec }),
    },
  );
  const name = view.stdout.trim();
  return view.code === 0 && /^[^\s~^:?*[\\]+$/.test(name) ? name : null;
}

/**
 * `pr`, or for `""` on a detached head the pull request the tree's attach
 * recorded (`lib/driven-branch.ts`), since a detached head has no branch for
 * `gh pr view` to read; `""` otherwise.
 */
async function attachedPr(
  root: string,
  pr: string,
  timeoutSec?: number,
): Promise<string> {
  if (pr !== "") return pr;
  const record = await attachedTree(boundedGit(timeoutSec), root, {
    timeoutSec: gitTimeout(timeoutSec),
  });
  return record === null ? "" : String(record.pr);
}

/**
 * Whether the current branch has a pull request, or `null` when it cannot be
 * told. A detached HEAD is `null`, not `false`: it only says the branch cannot
 * be named, and the checked-out commit may still be a pull request's head.
 */
async function currentBranchHasPullRequest(
  root: string,
  timeoutSec?: number,
): Promise<boolean | null> {
  const head = await git(
    ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"],
    { stderr: "ignore", timeoutSec: gitTimeout(timeoutSec) },
  );
  const branch = head.stdout.trim();
  if (head.code !== 0 || branch === "") return null;
  const list = await ghCall(
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number",
      "-q",
      "length",
    ],
    {
      cwd: root,
      stderr: "ignore",
      ...definedFields({ timeoutSec }),
    },
  );
  const count = list.stdout.trim();
  if (list.code !== 0 || !/^\d+$/.test(count)) return null;
  return count !== "0";
}

/**
 * The branch pull request `pr` targets and the `owner/name` of the repository
 * the pull request itself lives in, read from its own URL, or `null` when
 * either cannot be read. Taking the repository from the pull request rather
 * than from `gh repo view` binds it to the selector: a pull request URL from
 * another repository names that repository, not this clone's.
 */
async function pullRequestBase(
  root: string,
  pr: string,
  timeoutSec?: number,
): Promise<{ branch: string; repo: string } | null> {
  const selector = pr === "" ? [] : [pr];
  const view = await ghCall(
    ["pr", "view", ...selector, "--json", "baseRefName,url"],
    {
      cwd: root,
      stderr: "ignore",
      ...definedFields({ timeoutSec }),
    },
  );
  if (view.code !== 0) return null;
  let meta: { baseRefName?: unknown; url?: unknown };
  try {
    meta = JSON.parse(view.stdout) as typeof meta;
  } catch {
    return null;
  }
  const branch = typeof meta.baseRefName === "string" ? meta.baseRefName : "";
  const url = typeof meta.url === "string" ? meta.url : "";
  const repo = /^https?:\/\/[^/]+\/([^/\s]+\/[^/\s]+)\/pull\/\d+\/?$/.exec(url);
  if (repo === null || !/^[^\s~^:?*[\\]+$/.test(branch)) return null;
  return { branch, repo: repo[1] as string };
}

const prBaseRefCache = new Map<string, { ref: string } | { error: string }>();

/**
 * `refs/remotes/<remote>/<branch>` (the remote is `repository.remote`, else
 * `origin`) for the branch pull request `pr` targets: the
 * base a round diffs against. A stacked layer's base is the layer below, so
 * its round sees only its own layer and never counts what a base sync brought
 * in from the layers beneath it. `pr === ""` reads the current branch's pull
 * request; a branch positively established to have none diffs against the
 * integration branch.
 *
 * Fails closed, with the reason, when the pull request's base cannot be
 * established: the pull request cannot be read (including on a detached
 * HEAD no attach recorded, where `pr` must be given), the remote is not the repository the pull
 * request lives in (compared by owner and name; `repo-url.ts` says why hosts
 * are not), or the base has no remote-tracking ref in this clone. No
 * other branch stands in for it: the integration branch can cover fewer files
 * than the real base (a file a lower layer changed and this layer changed
 * back, or a backport whose commit the integration branch already holds).
 * Every git and `gh` call is bounded by `timeoutSec` when it is given.
 * Cached per process, repository and pull request.
 */
export async function prBaseRef(
  root: string,
  pr: string,
  timeoutSec?: number,
): Promise<{ ref: string } | { error: string }> {
  pr = await attachedPr(root, pr, timeoutSec);
  const key = `${root}\0${pr}`;
  const cached = prBaseRefCache.get(key);
  if (cached !== undefined) return cached;
  const remote = readRemoteName(consumerRoot(root));
  const result =
    "error" in remote
      ? remote
      : await resolvePrBaseRef(root, remote.remote, pr, timeoutSec);
  prBaseRefCache.set(key, result);
  return result;
}

async function resolvePrBaseRef(
  root: string,
  remote: string,
  pr: string,
  timeoutSec?: number,
): Promise<{ ref: string } | { error: string }> {
  const which =
    pr === "" ? "this branch's pull request" : `pull request #${pr}`;
  const base = await pullRequestBase(root, pr, timeoutSec);
  if (base === null) {
    if (
      pr === "" &&
      (await currentBranchHasPullRequest(root, timeoutSec)) === false
    ) {
      const branch = await baseBranch(root, timeoutSec);
      if (branch === null) return { error: baseBranchUnknown(remote) };
      const tracked = await trackingRef(
        root,
        remote,
        branch,
        "the integration branch",
        timeoutSec,
      );
      if ("ref" in tracked)
        process.stderr.write(
          `note: this branch has no pull request; diffing against the integration branch ${tracked.ref}\n`,
        );
      return tracked;
    }
    return {
      error: `cannot read the base branch of ${which}, which the round diffs against${pr === "" ? "; name the pull request explicitly" : ""}`,
    };
  }
  const check = await verifyRemoteIsPrRepo(
    boundedGit(timeoutSec),
    root,
    base.repo,
    undefined,
    remote,
  );
  if (!check.ok)
    return {
      error: `cannot trust ${remote}/${base.branch}, the base of ${which}: ${check.why}`,
    };
  return trackingRef(
    root,
    remote,
    base.branch,
    `the base of ${which}`,
    timeoutSec,
  );
}

/**
 * `refs/remotes/<remote>/<branch>` once it is verified to name a commit in
 * this clone. Fully qualified: a local branch named `<remote>/<branch>` would
 * make the shorthand resolve to something other than the ref verified here.
 */
async function trackingRef(
  root: string,
  remote: string,
  branch: string,
  role: string,
  timeoutSec?: number,
): Promise<{ ref: string } | { error: string }> {
  const ref = `refs/remotes/${remote}/${branch}`;
  const tracking = await git(
    ["-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { stderr: "ignore", timeoutSec: gitTimeout(timeoutSec) },
  );
  if (tracking.code !== 0)
    return {
      error: `${remote}/${branch}, ${role}, is not in this clone; run git fetch ${shellQuote(remote)} ${shellQuote(`+refs/heads/${branch}:${ref}`)}`,
    };
  return { ref };
}

/** A git runner whose every call is held to the caller's smaller timeout. */
function boundedGit(timeoutSec?: number): typeof git {
  return (args, opts) => {
    const deadline =
      timeoutSec === undefined
        ? opts?.timeoutSec
        : Math.min(timeoutSec, opts?.timeoutSec ?? gitCallTimeoutSeconds());
    return git(args, {
      ...opts,
      ...definedFields({ timeoutSec: deadline }),
    });
  };
}

/** The git deadline, tightened to a caller's smaller timeout when it has one. */
function gitTimeout(timeoutSec?: number): number {
  const bound = gitCallTimeoutSeconds();
  return timeoutSec === undefined ? bound : Math.min(timeoutSec, bound);
}
