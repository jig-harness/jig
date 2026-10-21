#!/usr/bin/env bun
/**
 * Start an agent on a tracker issue from the tracker's "open in coding agent"
 * action: assign the issue to whoever opens it, write the full issue context to
 * the launcher cache, choose the repository from the issue's label, and hand
 * over to the configured workspace provider.
 *
 * Usage (the tracker passes both arguments):
 *   bun tools/launcher/launch.ts ISSUE_KEY [BRANCH_NAME]
 *
 * The tracker (`trackers/`) and the workspace provider (`providers/`) are each
 * behind an interface and chosen by configuration; this file uses neither by
 * name. The Linear tracker reads:
 *   LINEAR_API_KEY            personal API key; else ~/.linear/api-key. Without
 *                             one the launcher still opens a workspace, but
 *                             cannot assign, route or cache the full context.
 *   LINEAR_PROMPT             issue description (cache source when Linear
 *                             cannot be read)
 *   LINEAR_ISSUE_BRANCH_NAME  suggested branch (same as the second argument)
 * and the launcher itself:
 *   JIG_LAUNCHER_CONFIG  configuration file (default ~/.linear/launcher.yaml)
 *
 * The tracker starts this as a GUI child with no shell profile, so nothing here
 * may depend on `PATH` or exported variables; `install.ts` writes the absolute
 * path of `bun` into the tracker's configuration for that reason.
 *
 * Every step before the provider is best-effort and says so on stderr: a failed
 * read, assignment or cache write degrades the launch instead of stopping it.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { cli } from "../../lib/cli.ts";
import {
  assertIssueKey,
  type ContextCache,
  cachePath,
  type FallbackEnvironment,
  fallbackCache,
  writeCache,
} from "./cache.ts";
import { loadConfig } from "./config.ts";
import type { Provider } from "./provider.ts";
import { getProvider } from "./providers/index.ts";
import type { ReadRequest, Tracker } from "./tracker.ts";
import { getTracker } from "./trackers/index.ts";

/** Bounds the tracker's read, every page of it; a tracker may bound it tighter. */
export const READ_BUDGET_MS = 40_000;
/** Bounds the assignment, which comes after the read and has its own budget. */
export const ASSIGN_BUDGET_MS = 15_000;
/** Bounds the provider's last step unless the provider sets its own bound. */
export const OPEN_BUDGET_MS = 30_000;

export interface LaunchDeps {
  home: string;
  env: Record<string, string | undefined>;
  /** Replaces the configured tracker; tests use it. */
  tracker?: Tracker;
  /** Replaces the configured provider; tests use it. */
  provider?: Provider;
  nowSeconds?: () => number;
  readBudgetMs?: number;
  assignBudgetMs?: number;
  openBudgetMs?: number;
  warn?: (message: string) => void;
}

export function buildPrompt(options: {
  skill: string;
  issue: string;
  title: string;
  branch: string;
  cacheFile: string;
}): string {
  const { skill, issue, title, branch, cacheFile } = options;
  const lines = [`${skill} ${issue}`];
  if (title) lines.push(`${issue} — ${title}`);
  if (branch) lines.push(`Branch hint: ${branch}`);
  // The skill reads launcher context from a file the instructions name.
  lines.push(`Launcher context: ${cacheFile}`);
  return lines.join("\n");
}

type Warn = (message: string) => void;

/**
 * The title in an earlier cache file; "" when there is none, it is not JSON or
 * it cannot be read. The title only decorates the prompt, so an unreadable
 * cache is warned about and never stops the launch.
 */
function titleOf(file: string, warn: Warn): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const title = (parsed as { title?: unknown } | null)?.title;
    return typeof title === "string" ? title : "";
  } catch (error) {
    if (
      !(error instanceof SyntaxError) &&
      (error as { code?: unknown }).code !== "ENOENT"
    )
      warn(
        `Could not read the context cache for the title: ${error instanceof Error ? error.message : String(error)}`,
      );
    return "";
  }
}

/** Read the issue and assign it to the opener; what the read yielded, or nothing when it was unavailable. */
async function readAndAssign(
  tracker: Tracker,
  request: ReadRequest,
  assignBudgetMs: number,
  warn: Warn,
): Promise<{ fresh: ContextCache | null; repoLabel: string | null }> {
  const { issue } = request;
  const read = await tracker.read(request);
  if ("unavailable" in read) {
    warn(`${read.unavailable}; automatic assignment unavailable.`);
    return { fresh: null, repoLabel: null };
  }
  const assigned = await read.assignToOpener(
    AbortSignal.timeout(assignBudgetMs),
  );
  if (!assigned.assigned)
    warn(
      `Could not assign ${issue} to you (${assigned.reason}); continuing to open a workspace.`,
    );
  for (const line of read.warnings) warn(line);
  return { fresh: read.cache, repoLabel: read.repoLabel };
}

function persistCache(
  home: string,
  issue: string,
  file: string,
  fresh: ContextCache | null,
  fallback: FallbackEnvironment,
  nowSeconds: number,
  warn: Warn,
): void {
  try {
    if (fresh !== null) writeCache(home, issue, fresh);
    // Seed at least the description when the tracker could not be read, but
    // never replace an existing cache with a thinner one.
    else if (!existsSync(file) && fallback.prompt)
      writeCache(home, issue, fallbackCache(issue, fallback, nowSeconds));
  } catch (error) {
    warn(
      `Could not write the context cache: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function launch(
  issue: string,
  branchArg: string | undefined,
  deps: LaunchDeps,
): Promise<void> {
  const { home, env } = deps;
  // Before anything else: the key names a file, and a bad one is no issue.
  assertIssueKey(issue);
  const warn = deps.warn ?? ((m: string) => console.error(`[launcher] ${m}`));
  const nowSeconds = deps.nowSeconds ?? (() => Date.now() / 1000);
  const config = loadConfig(home, env);
  const tracker = deps.tracker ?? getTracker(config.tracker, { home, env });
  const provider = deps.provider ?? getProvider(config.provider);
  for (const [label, settings] of Object.entries(config.repos))
    if (settings[provider.name] !== undefined)
      provider.validateRepo(settings[provider.name], label);

  const branch = branchArg || tracker.launchEnvironment.branch || "";
  const fallback = { prompt: tracker.launchEnvironment.prompt, branch };
  const file = cachePath(home, issue);
  const { fresh, repoLabel } = await readAndAssign(
    tracker,
    {
      issue,
      repoLabelGroup: config.repoLabelGroup,
      fallback,
      nowSeconds: nowSeconds(),
      signal: AbortSignal.timeout(deps.readBudgetMs ?? READ_BUDGET_MS),
    },
    deps.assignBudgetMs ?? ASSIGN_BUDGET_MS,
    warn,
  );
  persistCache(home, issue, file, fresh, fallback, nowSeconds(), warn);

  const title = fresh?.title ?? titleOf(file, warn);
  const promptFor = (cacheFile: string): string =>
    buildPrompt({ skill: config.skill, issue, title, branch, cacheFile });
  const repo =
    repoLabel === null
      ? null
      : (config.repos[repoLabel]?.[provider.name] ?? null);
  await provider.open({
    issue,
    prompt: promptFor(file),
    cacheFile: file,
    promptFor,
    branch,
    repo,
    signal: AbortSignal.timeout(
      deps.openBudgetMs ?? provider.openBudgetMs ?? OPEN_BUDGET_MS,
    ),
  });
}

if (import.meta.main) {
  cli(async () => {
    const [issue, branch] = process.argv.slice(2);
    if (!issue) throw new Error("Usage: launch.ts ISSUE_KEY [BRANCH_NAME]");
    await launch(issue, branch, {
      home: process.env.HOME ?? homedir(),
      env: process.env,
    });
    return 0;
  });
}
