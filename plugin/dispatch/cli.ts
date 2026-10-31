/**
 * `jig dispatch`: one tick of the dispatcher. It reads the tracker, the
 * forge's drive ledgers, the session runtime and this machine's launch
 * records for each repository and prints every stage it would start, with
 * the record that wants it and the evidence. With `--apply` it starts the
 * stages the machine file (`~/.jig/dispatch.yaml`) enables for each
 * repository; today that is the drives' re-arms and takeovers.
 * `jig dispatch install` writes the timer that runs `--apply` every
 * interval.
 */
import { resolve } from "node:path";
import { consumerRoot } from "../shared/consumer.ts";
import { ExitError } from "../shared/cli.ts";
import { installDispatch } from "./install.ts";
import { runMain } from "./run.ts";
import {
  type MachineConfig,
  MachineConfigError,
  machineConfigPath,
  readMachineConfig,
} from "./lib/machine-config.ts";
import { formatReceipt } from "./lib/report.ts";
import { readReceipt, receiptPaths } from "./receipts.ts";
import { runTick } from "./tick.ts";

const USAGE = `jig dispatch [--apply] [--repo <path>]... [--followup-since <date>] [--json]
jig dispatch install [--interval <5m>] [--yes] [--remove]
jig dispatch receipts [<run-id>]`;

/** Exit when another tick holds the lock. */
const LOCK_HELD_EXIT = 3;

interface Options {
  repos: string[];
  json: boolean;
  apply: boolean;
  followupSince?: string;
}

/** Take a flag's value into `options`. */
function takeValue(
  options: Options,
  flag: string,
  value: string | undefined,
): void {
  if (value === undefined || value.startsWith("--"))
    throw new ExitError(2, `Missing value for ${flag}`);
  if (flag === "--repo") {
    options.repos.push(resolve(value));
    return;
  }
  if (!Number.isFinite(Date.parse(value)))
    throw new ExitError(2, `--followup-since is not a date: ${value}`);
  options.followupSince = new Date(value).toISOString();
}

const SWITCHES: Record<string, "json" | "apply"> = {
  "--json": "json",
  "--apply": "apply",
};

function parseArguments(argv: string[]): Options {
  const options: Options = { repos: [], json: false, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag === "--repo" || flag === "--followup-since") {
      takeValue(options, flag, argv[++i]);
      continue;
    }
    const field = SWITCHES[flag];
    if (field === undefined)
      throw new ExitError(2, `Unknown argument: ${flag}\n${USAGE}`);
    options[field] = true;
  }
  return options;
}

function showReceipts(argv: string[]): number {
  if (argv.length > 1) throw new ExitError(2, "receipts accepts one run id");
  const paths = receiptPaths();
  const id = argv[0];
  if (id === undefined) {
    for (const path of paths) {
      const r = readReceipt(path);
      if (r === null) continue;
      const actions = r.repos.reduce((n, repo) => n + repo.actions.length, 0);
      console.log(
        `${r.runId}  ${r.startedAt}  ${r.completed ? `exit ${r.exitStatus}` : "incomplete"}  ${r.repos.length} repositor${r.repos.length === 1 ? "y" : "ies"}, ${actions} action(s)  ${path}`,
      );
    }
    return 0;
  }
  const path = paths.find(
    (p) => p.endsWith(`/${id}.json`) || p.endsWith(`\\${id}.json`),
  );
  const receipt = path === undefined ? null : readReceipt(path);
  if (receipt === null) throw new ExitError(2, `No receipt ${id}`);
  console.log(JSON.stringify(receipt, null, 2));
  return 0;
}

function machineFile(): MachineConfig | null {
  try {
    return readMachineConfig();
  } catch (error) {
    if (error instanceof MachineConfigError)
      throw new ExitError(2, error.message);
    throw error;
  }
}

/** The repositories a tick reads: `--repo`, else the machine file's, else this checkout. */
function repositories(
  options: Options,
  machine: MachineConfig | null,
): string[] {
  if (options.repos.length > 0) return options.repos;
  if (machine !== null && machine.repositories.length > 0)
    return machine.repositories.map((r) => r.path);
  return [consumerRoot()];
}

export async function dispatchMain(
  argv: string[],
  script = "",
): Promise<number> {
  if (argv[0] === "--help" && argv.length === 1) {
    console.log(USAGE);
    return 0;
  }
  if (argv[0] === "receipts") return showReceipts(argv.slice(1));
  // The wrapper a dispatched pass's terminal runs (run.ts), under its launch record.
  if (argv[0] === "run") return runMain(argv.slice(1));
  if (argv[0] === "install")
    return installDispatch(argv.slice(1), script, machineFile());
  const options = parseArguments(argv);
  const machine = machineFile();
  if (options.apply && machine === null)
    throw new ExitError(
      2,
      `jig dispatch --apply needs the machine file ${machineConfigPath()}: the repositories, the stages enabled for each and the accounts it may bill (see CONFIGURATION.md § The machine's dispatch file). Run without --apply for the report.`,
    );
  const result = await runTick({
    repos: repositories(options, machine),
    apply: options.apply,
    machine,
    ...(options.followupSince === undefined
      ? {}
      : { followupSince: options.followupSince }),
  });
  if ("held" in result) {
    console.error(`jig dispatch: another tick holds the lock: ${result.held}`);
    return LOCK_HELD_EXIT;
  }
  console.log(
    options.json
      ? JSON.stringify(result.receipt, null, 2)
      : formatReceipt(result.receipt, result.path),
  );
  return result.receipt.exitStatus;
}
