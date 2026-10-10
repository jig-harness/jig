/**
 * The consumer repository's drive-loop values, read from its Groundwork
 * configuration file (`.config/groundwork-overlay.yaml`) through the review
 * skill's reader.
 *
 * Every field here is optional and has a mechanism default, so a repository
 * without the file still drives: the review skill that each round spawns is
 * what refuses to run in a repository that has not adopted the plugin. A file
 * that exists but cannot be parsed, or a field of the wrong type, is an error
 * rather than a silent default.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  consumerRoot,
  overlayPath,
  readOverlay,
} from "../../../resolve-review-comments/scripts/lib/consumer.ts";
import { ghCall, git } from "./proc.ts";

let cache: { key: string; value: Record<string, unknown> } | undefined;

/**
 * The parsed configuration file, or `{}` when the repository has none.
 * Re-read only when the file's path, size or modification time changes:
 * evidence predicates ask once per comment.
 */
export function readOptionalOverlay(): Record<string, unknown> {
  const path = overlayPath();
  if (!existsSync(path)) return {};
  const st = statSync(path);
  const key = `${path}\0${st.size}\0${st.mtimeMs}`;
  if (cache?.key === key) return cache.value;
  const value = readOverlay();
  cache = { key, value };
  return value;
}

function section(name: string): Record<string, unknown> {
  const value = readOptionalOverlay()[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object: ${overlayPath()}`);
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
      `${sectionName}.${key} must be a nonempty string: ${overlayPath()}`,
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

/** How messages name the reviewer: its app slug, or a generic phrase. */
export function reviewerLabel(): string {
  const app = reviewerApp();
  return app === "" ? "the AI reviewer" : `'${app}'`;
}

/** `review.bots`: the logins the review skill treats as reviewers. */
export function reviewBots(): string[] {
  const bots = section("review").bots;
  if (!Array.isArray(bots)) return [];
  return bots.filter((b): b is string => typeof b === "string" && b !== "");
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
      `drive.reviews_drafts must be true or false: ${overlayPath()}`,
    );
  return value;
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
 * derived — the clone's `origin/HEAD` when it has one (no network), else
 * `gh repo view --json defaultBranchRef`. Cached per process and repository.
 * `null` when none of them answers; callers fail closed on it.
 */
export async function baseBranch(root: string): Promise<string | null> {
  const explicit =
    nonEmptyEnv("DRIVE_PR_BASE_BRANCH") ??
    optionalString("repository", "base_branch");
  if (explicit !== undefined) return explicit;
  const cached = baseBranchCache.get(root);
  if (cached !== undefined) return cached;
  let derived: string | null = null;
  const head = await git(
    [
      "-C",
      root,
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ],
    { stderr: "ignore" },
  );
  const fromHead = head.stdout.trim();
  if (head.code === 0 && fromHead.startsWith("origin/"))
    derived = fromHead.slice("origin/".length);
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
      { cwd: root, stderr: "ignore" },
    );
    const name = view.stdout.trim();
    if (view.code === 0 && /^[^\s~^:?*[\\]+$/.test(name)) derived = name;
  }
  baseBranchCache.set(root, derived);
  return derived;
}

/** `origin/<base branch>`, or `null` when the base branch is unknown. */
export async function baseRef(root: string): Promise<string | null> {
  const branch = await baseBranch(root);
  return branch === null ? null : `origin/${branch}`;
}

/** The sentence a caller prints when `baseRef` returns `null`. */
export const BASE_BRANCH_UNKNOWN =
  "the base branch is unknown: set repository.base_branch in .config/groundwork-overlay.yaml (or DRIVE_PR_BASE_BRANCH), or give this clone an origin/HEAD (git remote set-head origin --auto)";
