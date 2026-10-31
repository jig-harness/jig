#!/usr/bin/env bun
/**
 * Name the workspace this session runs in after the piece of work it holds and
 * the stage that work is at, from the repository's name template (by default
 * `{id} {status} {title}`); do nothing when the template is turned off.
 *
 * Usage: bun workspace-name.ts <stage> [--id <key>] [--title <text> | --title-file <path>] [--pr <number>]
 *
 * A tracker title is untrusted text. A caller whose command runs through a
 * shell passes it with `--title-file`, the path of a file holding only the
 * title, never as `--title` inside the command line, where the shell would
 * expand `$(…)` and backticks in it; it quotes the key. `--id` is optional:
 * a pull request that serves no tracker item is named from the template's
 * other variables.
 *
 * A person running several agents tells their workspaces apart by name. The
 * stage is one of `implementing`, `driving`, `ready` (ready to merge) and
 * `done` (the follow-up has settled the merge); `workspace_name.statuses`
 * maps each to the short text `{status}` stands for, `[I]`, `[D]`, `[R]` and
 * `✅` by default. `workspace_name.template` is the name, with `{id}`,
 * `{status}`, `{title}` and `{pr}` filled in; a variable with no value
 * renders empty and the spaces around it collapse.
 *
 * Without `workspace_name.template` the name is `DEFAULT_TEMPLATE`; an empty
 * string turns renaming off. It acts only in a terminal Orca opened whose
 * worktree Orca knows (the detection `orca-board.ts` uses). Every runtime
 * failure only warns and the exit is 0; a malformed command line or a
 * template naming an unknown variable exits 2.
 */
import { readFileSync } from "node:fs";
import { fail, isDigits, runMain } from "../../../shared/cli.ts";
import { readConfig } from "../../../shared/consumer.ts";
import { run } from "../../../shared/proc.ts";
import {
  type OrcaRunner,
  orcaCommand,
  orcaFailure,
  orcaResult,
} from "../../../shared/orca.ts";
import { currentWorktree } from "./orca-board.ts";

const USAGE =
  "usage: workspace-name.ts <implementing|driving|ready|done> [--id <key>] [--title <text> | --title-file <path>] [--pr <number>]";

/** Seconds one Orca call may take. */
const ORCA_CALL_TIMEOUT_SEC = 20;

export const STAGES = ["implementing", "driving", "ready", "done"] as const;
export type Stage = (typeof STAGES)[number];

export const DEFAULT_STATUSES: Record<Stage, string> = {
  implementing: "[I]",
  driving: "[D]",
  ready: "[R]",
  done: "✅",
};

/** The name when the repository sets no template. */
export const DEFAULT_TEMPLATE = "{id} {status} {title}";

const VARIABLES = ["id", "status", "title", "pr"] as const;

/** Braces only in complete, unnested pairs; which names they hold is checked on rendering. */
const TEMPLATE_GRAMMAR = /^(?:[^{}]|\{[^{}]*\})*$/;

export interface NameRequest {
  stage: Stage;
  id: string;
  title: string;
  pr: string;
}

export interface NameConfig {
  /** Null when the template is turned off with an empty string. */
  template: string | null;
  statuses: Record<Stage, string>;
}

const runOrca: OrcaRunner = (command, args) =>
  run([command, ...args], { timeoutSec: ORCA_CALL_TIMEOUT_SEC });

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

export function parseArgs(args: string[]): NameRequest {
  const [stage, ...rest] = args;
  if (stage === undefined || !isStage(stage)) fail(2, USAGE);
  const request: NameRequest = { stage, id: "", title: "", pr: "" };
  const titleFlags = rest.filter(
    (arg, i) => i % 2 === 0 && (arg === "--title" || arg === "--title-file"),
  );
  if (titleFlags.length > 1) fail(2, USAGE);
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (value === undefined) fail(2, USAGE);
    applyFlag(request, rest[i], value);
  }
  return request;
}

function applyFlag(
  request: NameRequest,
  flag: string | undefined,
  value: string,
): void {
  switch (flag) {
    case "--id":
      request.id = value;
      return;
    case "--title":
      request.title = value;
      return;
    case "--title-file":
      request.title = readTitleFile(value);
      return;
    case "--pr":
      if (!isDigits(value)) fail(2, USAGE);
      request.pr = value;
      return;
    default:
      fail(2, USAGE);
  }
}

function readTitleFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    return fail(
      2,
      `cannot read --title-file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The `workspace_name` section of the configuration: the template (the default
 * when absent, null when set to an empty string) and the status text per
 * stage. A template that is not a string or is only blank, a status that is not a non-empty string, or a status key that is not a stage, exits 2.
 */
export function nameConfig(config: Record<string, unknown>): NameConfig {
  const section = config.workspace_name;
  if (section === undefined || section === null)
    return { template: DEFAULT_TEMPLATE, statuses: { ...DEFAULT_STATUSES } };
  if (typeof section !== "object" || Array.isArray(section))
    fail(2, "workspace_name must be a mapping");
  const { template, statuses, ...unknown } = section as Record<string, unknown>;
  const [unknownKey] = Object.keys(unknown);
  if (unknownKey !== undefined)
    fail(
      2,
      `workspace_name: unknown key "${unknownKey}" (known: template, statuses)`,
    );
  return {
    template: parseTemplate(template),
    statuses: parseStatuses(statuses),
  };
}

function parseTemplate(template: unknown): string | null {
  if (template === undefined || template === null) return DEFAULT_TEMPLATE;
  if (typeof template !== "string")
    fail(2, "workspace_name.template must be a string");
  if (template === "") return null;
  if (template.trim() === "")
    fail(
      2,
      'workspace_name.template must not be blank (use "" to turn it off)',
    );
  if (!TEMPLATE_GRAMMAR.test(template))
    fail(
      2,
      `workspace_name.template: unbalanced or nested braces; write each variable as one of ${VARIABLES.map((v) => `{${v}}`).join(", ")}`,
    );
  return template;
}

function parseStatuses(statuses: unknown): Record<Stage, string> {
  const result = { ...DEFAULT_STATUSES };
  if (statuses === undefined || statuses === null) return result;
  if (typeof statuses !== "object" || Array.isArray(statuses))
    fail(2, "workspace_name.statuses must be a mapping");
  for (const [stage, text] of Object.entries(statuses)) {
    if (!isStage(stage))
      fail(2, `workspace_name.statuses: unknown stage "${stage}"`);
    if (typeof text !== "string" || text.trim() === "")
      fail(2, `workspace_name.statuses.${stage} must be a non-empty string`);
    result[stage] = text;
  }
  return result;
}

/** `template` with its `{variables}` filled in for `request`; spaces collapsed. */
export function renderName(
  template: string,
  request: NameRequest,
  statuses: Record<Stage, string>,
): string {
  const values: Record<(typeof VARIABLES)[number], string> = {
    id: request.id,
    status: statuses[request.stage],
    title: request.title,
    pr: request.pr === "" ? "" : `#${request.pr}`,
  };
  const name = template.replace(/\{([^{}]*)\}/g, (_, variable: string) => {
    if (!(VARIABLES as readonly string[]).includes(variable))
      fail(
        2,
        `workspace_name.template: unknown variable {${variable}} (known: ${VARIABLES.map((v) => `{${v}}`).join(", ")})`,
      );
    return values[variable as (typeof VARIABLES)[number]];
  });
  return name.replace(/\s+/g, " ").trim();
}

/** Rename the working directory's Orca worktree; returns the line to report. */
export async function renameWorkspace(
  request: NameRequest,
  config: NameConfig,
  env: Record<string, string | undefined> = process.env,
  runner: OrcaRunner = runOrca,
): Promise<string> {
  if (config.template === null)
    return "workspace-name: workspace_name.template is empty; nothing to do";
  const name = renderName(config.template, request, config.statuses);
  if (name === "")
    return "workspace-name: the template renders empty; nothing to do";
  const command = orcaCommand(env);
  if (command === null) return "workspace-name: not in Orca; nothing to do";
  const current = await currentWorktree(command, runner);
  if (current === "none")
    return "workspace-name: Orca does not list this directory as a worktree; nothing to do";
  if ("warning" in current)
    return current.warning.replace(/^orca-board/, "workspace-name");
  const done = await runner(command, [
    "worktree",
    "set",
    "--worktree",
    `id:${current.id}`,
    "--display-name",
    name,
    "--json",
  ]);
  if (orcaResult(done) === null)
    return `workspace-name: ⚠ could not rename the workspace ${orcaFailure(done)}`;
  return `workspace-name: ${name}`;
}

if (import.meta.main)
  runMain("workspace-name", async () => {
    const request = parseArgs(process.argv.slice(2));
    console.error(await renameWorkspace(request, nameConfig(readConfig())));
    return 0;
  });
