import { basename, dirname, join } from "node:path";
import { statfsSync } from "node:fs";
import { consumerRoot } from "../shared/consumer.ts";
import { GcError } from "../shared/gc-error.ts";
import { ExitError } from "../shared/cli.ts";
import { pathValue, USAGE_EXIT } from "../shared/command-line.ts";
import { main as withResourceLock } from "../shared/resource-lock.ts";
import { gcConfiguration } from "./config.ts";
import { install } from "./install.ts";
import { collectionPlan } from "./plan.ts";
import { readReceipt, receiptPaths } from "./receipts.ts";
import { formatReceipt, runCollection } from "./runner.ts";
import type { KindName } from "./types.ts";
import {
  argument,
  choice,
  command,
  constant,
  flag,
  formatMessage,
  type InferValue,
  map,
  message,
  object,
  option,
  optional,
  or,
  parse,
  type ValueParser,
  withDefault,
} from "../shared/vendor/optique.mjs";

const KINDS = [
  "worktrees",
  "tool-state",
  "scratch",
  "receipts",
] as const satisfies readonly KindName[];

/** A day's receipts (`2026-10-31`) or one run's id, as `receiptPaths` names them. */
const RECEIPT_QUERY = /^(?:\d{4}-\d{2}-\d{2}|[\dTZ.-]+-\d+-[a-f\d-]+)$/;
const receiptQuery: ValueParser<"sync", string> = {
  mode: "sync",
  metavar: "DATE|RUN-ID",
  placeholder: "",
  parse: (input) =>
    RECEIPT_QUERY.test(input)
      ? { success: true, value: input }
      : {
          success: false,
          error: message`Expected a date (YYYY-MM-DD) or a run id, but got ${input}.`,
        },
  format: (value) => value,
};

const collection = object({
  action: constant("collect"),
  mode: optional(
    or(
      map(
        flag("--collect", {
          description: message`Remove what the evidence shows is finished, within the bounds confirmed at install. Without it, the run only reports.`,
        }),
        () => "collect" as const,
      ),
      map(
        flag("--scheduled", {
          description: message`Run as the installed daily job does: collect on the configured weekday or under disk pressure, report otherwise.`,
        }),
        () => "scheduled" as const,
      ),
    ),
  ),
  repository: optional(
    option("--repo", pathValue, {
      description: message`Only this repository. Without it, every repository the machine file registers.`,
    }),
  ),
  kind: optional(
    option("--kind", choice(KINDS, { metavar: "KIND" }), {
      description: message`Only this kind of resource.`,
    }),
  ),
  json: option("--json", {
    description: message`Print the receipt as JSON.`,
  }),
});

const installation = command(
  "install",
  object({
    action: constant("install"),
    repository: optional(
      option("--repo", pathValue, {
        description: message`The repository to register. Without it, the current checkout.`,
      }),
    ),
    confirm: option("--yes", {
      description: message`Write what the preview shows.`,
    }),
    uninstall: optional(
      object({
        uninstall: flag("--uninstall", {
          description: message`Remove the repository's entry instead. The job stays while any entry remains.`,
        }),
        machine: option("--machine", {
          description: message`With --uninstall, remove every entry and the job.`,
        }),
      }),
    ),
  }),
  {
    brief: message`Register a repository and install the daily job.`,
    description: message`Previews the repository's bounds and the daily scheduler job; --yes writes them. The same as jig install gc, or with --uninstall jig uninstall gc; kept for the command lines that use this form.`,
    hidden: true,
  },
);

const receipts = command(
  "receipts",
  object({
    action: constant("receipts"),
    query: optional(
      argument(receiptQuery, {
        description: message`List that day's receipts, or print the run with that id. Without it, list every receipt.`,
      }),
    ),
  }),
  {
    brief: message`List the receipts of earlier runs, or print one.`,
    description: message`The same as jig receipts gc; kept for the command lines that use this form.`,
    hidden: true,
  },
);

/**
 * `jig gc`: a report by default. Its `install` and `receipts` subcommands do
 * what the lifecycle verbs `jig install gc` and `jig receipts gc` do, and stay
 * for the command lines that use them, hidden from help.
 */
export const gcCommand = command(
  "gc",
  withDefault(or(installation, receipts, collection), {
    action: "collect",
    mode: undefined,
    repository: undefined,
    kind: undefined,
    json: false,
  } as const),
  {
    brief: message`Report and collect what agent sessions leave on this machine.`,
    description: message`Reports the scratch directories, tool state, worktrees and old receipts the repository declares, with the evidence that their owners have finished, and writes a receipt for the run. Nothing is removed unless the run collects: with --collect, or with --scheduled on the configured collection weekday or under disk pressure.`,
  },
);

export type GcArguments = InferValue<typeof gcCommand>;
type Collection = Extract<GcArguments, { action: "collect" }>;

/** `jig gc`'s arguments (those after `gc`), or a usage error (exit 2). */
export function argumentsFor(argv: string[]): GcArguments {
  const result = parse(gcCommand, ["gc", ...argv]);
  if (!result.success)
    throw new ExitError(USAGE_EXIT, formatMessage(result.error));
  return result.value;
}

interface Options {
  collect: boolean;
  scheduled: boolean;
  json: boolean;
  repository?: string;
  kind?: KindName;
}
function runOptions(args: Collection): Options {
  return {
    collect: args.mode === "collect",
    scheduled: args.mode === "scheduled",
    json: args.json,
    ...(args.repository === undefined ? {} : { repository: args.repository }),
    ...(args.kind === undefined ? {} : { kind: args.kind }),
  };
}
export function scheduledCollection(
  machine: { collect_day: number; min_free_bytes: number },
  now = new Date(),
  freeBytes?: number,
): boolean {
  return (
    now.getDay() === machine.collect_day ||
    (machine.min_free_bytes > 0 &&
      freeBytes !== undefined &&
      freeBytes < machine.min_free_bytes)
  );
}
async function executeRun(options: Options): Promise<number> {
  const kinds = await collectionPlan(options);
  const { receipt, path } = await runCollection(kinds, options);
  console.log(
    options.json
      ? JSON.stringify(receipt, null, 2)
      : `${formatReceipt(receipt)}\nReceipt: ${path}`,
  );
  return receipt.exitStatus;
}
/** Prints every receipt's path, that day's, or the run with that id. */
export function showReceipts(query: string | undefined): number {
  if (query !== undefined && !RECEIPT_QUERY.test(query))
    throw new ExitError(
      USAGE_EXIT,
      `Expected a date (YYYY-MM-DD) or a run id, but got ${query}.`,
    );
  const paths = receiptPaths();
  if (!query || /^\d{4}-\d{2}-\d{2}$/.test(query)) {
    console.log(
      paths
        .filter((path) => !query || basename(dirname(path)) === query)
        .join("\n"),
    );
    return 0;
  }
  const path = paths.find((path) => basename(path, ".json") === query);
  if (!path) throw new ExitError(2, `No receipt ${query}`);
  console.log(JSON.stringify(readReceipt(path), null, 2));
  return 0;
}
function applySchedule(options: Options): void {
  if (!options.scheduled) return;
  const { machine } = gcConfiguration(process.cwd(), null);
  const stat = statfsSync(process.env.HOME ?? process.cwd());
  options.collect = scheduledCollection(
    machine,
    new Date(),
    stat.bavail * stat.bsize,
  );
}
/** The collecting run the heavy-run lock wraps: this one's selection, collecting. */
function collectingArguments(options: Options): string[] {
  return [
    "gc",
    "--collect",
    ...(options.repository === undefined ? [] : ["--repo", options.repository]),
    ...(options.kind === undefined ? [] : ["--kind", options.kind]),
    ...(options.json ? ["--json"] : []),
  ];
}
async function runUnderHeavyLock(
  options: Options,
  script: string,
): Promise<number> {
  const status = await withResourceLock(
    [
      process.execPath,
      "--no-env-file",
      `--config=${join(dirname(script), "gc", "bunfig.toml")}`,
      script,
      ...collectingArguments(options),
    ],
    {
      ...process.env,
      JIG_GC_HEAVY_LOCK: "held",
      LOCK_TIMEOUT: process.env.LOCK_TIMEOUT ?? "3600",
    },
  );
  if (status !== 3) return status;
  const { receipt, path } = await runCollection(
    [
      {
        name: options.kind ?? "receipts",
        declaration: "machine heavy-run lock",
        inventory: async () => {
          throw new GcError(
            "collection did not acquire the machine heavy-run lock",
          );
        },
        prove: async () => ({ state: "unverified", reason: "lock not held" }),
        collect: async () => ({ outcome: "refused", reason: "lock not held" }),
        describe: (resource) => resource.id,
        exclusive: (body) => body(),
      },
    ],
    options,
  );
  console.log(
    options.json
      ? JSON.stringify(receipt, null, 2)
      : `${formatReceipt(receipt)}\nReceipt: ${path}`,
  );
  return 1;
}
export async function gcMain(
  args: GcArguments,
  script: string,
): Promise<number> {
  if (args.action === "receipts") return showReceipts(args.query);
  if (args.action === "install")
    return install({
      repository: args.repository ?? consumerRoot(),
      script,
      confirm: args.confirm,
      uninstall: args.uninstall !== undefined,
      machine: args.uninstall?.machine ?? false,
    });
  const options = runOptions(args);
  applySchedule(options);
  if (options.collect && process.env.JIG_GC_HEAVY_LOCK !== "held")
    return runUnderHeavyLock(options, script);
  return executeRun(options);
}
