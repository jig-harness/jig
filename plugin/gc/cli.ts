import { basename, dirname, join, resolve } from "node:path";
import { statfsSync } from "node:fs";
import { consumerRoot } from "../shared/consumer.ts";
import { GcError } from "../shared/gc-error.ts";
import { ExitError } from "../shared/cli.ts";
import { main as withResourceLock } from "../shared/resource-lock.ts";
import { gcConfiguration } from "./config.ts";
import { install } from "./install.ts";
import { collectionPlan } from "./plan.ts";
import { readReceipt, receiptPaths } from "./receipts.ts";
import { formatReceipt, runCollection } from "./runner.ts";
import type { KindName } from "./types.ts";

const USAGE =
  "jig gc [--collect | --scheduled] [--repo <path>] [--kind worktrees|tool-state|scratch|receipts] [--json]\njig gc receipts [<date>|<run-id>]\njig gc install [--repo <path>] [--yes] [--uninstall [--machine]]";
interface Options {
  collect: boolean;
  scheduled: boolean;
  json: boolean;
  confirm: boolean;
  uninstall: boolean;
  machine: boolean;
  repository?: string;
  kind?: KindName;
}
function applyArgument(
  options: Options,
  flag: string,
  value: string | undefined,
): void {
  if (flag === "--repo" || flag === "--kind") {
    if (!value || value.startsWith("--"))
      throw new ExitError(2, `Missing value for ${flag}`);
    if (flag === "--repo") {
      options.repository = resolve(value);
      return;
    }
    if (!["worktrees", "tool-state", "scratch", "receipts"].includes(value))
      throw new ExitError(2, `Unknown collection kind: ${value}`);
    options.kind = value as KindName;
    return;
  }
  const flags: Record<
    string,
    "collect" | "scheduled" | "json" | "confirm" | "uninstall" | "machine"
  > = {
    "--collect": "collect",
    "--scheduled": "scheduled",
    "--json": "json",
    "--yes": "confirm",
    "--uninstall": "uninstall",
    "--machine": "machine",
  };
  const field = flags[flag];
  if (!field) throw new ExitError(2, `Unknown argument: ${flag}`);
  options[field] = true;
}
export function argumentsFor(argv: string[]): Options {
  const options: Options = {
    collect: false,
    scheduled: false,
    json: false,
    confirm: false,
    uninstall: false,
    machine: false,
  };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (seen.has(flag)) throw new ExitError(2, `Duplicate argument: ${flag}`);
    seen.add(flag);
    const needsValue = flag === "--repo" || flag === "--kind";
    const value = needsValue ? argv[++i] : undefined;
    applyArgument(options, flag, value);
  }
  if (options.collect && options.scheduled)
    throw new ExitError(2, "--scheduled and --collect are mutually exclusive");
  if (options.machine && !options.uninstall)
    throw new ExitError(2, "--machine requires --uninstall");
  return options;
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
function validQuery(argv: string[]): string | undefined {
  if (argv.length > 2)
    throw new ExitError(2, "receipts accepts a date or run id");
  const query = argv[1];
  if (query && !/^(?:\d{4}-\d{2}-\d{2}|[\dTZ.-]+-\d+-[a-f\d-]+)$/.test(query))
    throw new ExitError(2, "Invalid receipt date or run id");
  return query;
}
function showReceipts(argv: string[]): number {
  const query = validQuery(argv),
    paths = receiptPaths();
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
function validateMode(installing: boolean, options: Options): void {
  if (
    installing &&
    [options.collect, options.scheduled, options.kind, options.json].some(
      Boolean,
    )
  )
    throw new ExitError(
      2,
      "install accepts --repo, --yes, --uninstall and --machine",
    );
  if (
    !installing &&
    [options.confirm, options.uninstall, options.machine].some(Boolean)
  )
    throw new ExitError(2, "--yes, --uninstall and --machine require install");
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
async function runUnderHeavyLock(
  options: Options,
  argv: string[],
  script: string,
): Promise<number> {
  const status = await withResourceLock(
    [
      process.execPath,
      "--no-env-file",
      `--config=${join(dirname(script), "gc", "bunfig.toml")}`,
      script,
      "gc",
      ...argv.filter((arg) => arg !== "--scheduled"),
      ...(argv.includes("--collect") ? [] : ["--collect"]),
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
export async function gcMain(argv: string[], script: string): Promise<number> {
  if (argv[0] === "--help" && argv.length === 1) {
    console.log(USAGE);
    return 0;
  }
  if (argv[0] === "receipts") return showReceipts(argv);
  const installing = argv[0] === "install";
  const options = argumentsFor(installing ? argv.slice(1) : argv);
  validateMode(installing, options);
  if (installing)
    return install({
      repository: options.repository ?? consumerRoot(),
      script,
      confirm: options.confirm,
      uninstall: options.uninstall,
      machine: options.machine,
    });
  applySchedule(options);
  if (options.collect && process.env.JIG_GC_HEAVY_LOCK !== "held")
    return runUnderHeavyLock(options, argv, script);
  return executeRun(options);
}
