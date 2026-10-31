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
import { consumerRoot } from "../shared/consumer.ts";
import { ExitError } from "../shared/cli.ts";
import { pathValue } from "../shared/command-line.ts";
import {
  argument,
  command,
  constant,
  type InferValue,
  message,
  multiple,
  object,
  option,
  optional,
  or,
  string,
  text,
  type ValueParser,
  withDefault,
} from "../shared/vendor/optique.mjs";
import { installDispatch } from "./install.ts";
import {
  duration,
  type MachineConfig,
  MachineConfigError,
  machineConfigPath,
  readMachineConfig,
} from "./lib/machine-config.ts";
import { formatReceipt } from "./lib/report.ts";
import { readReceipt, receiptPaths } from "./receipts.ts";
import { runTick } from "./tick.ts";

/** Exit when another tick holds the lock. */
const LOCK_HELD_EXIT = 3;

/** A date `Date.parse` reads, as the ISO timestamp the tick compares with. */
const dateValue: ValueParser<"sync", string> = {
  mode: "sync",
  metavar: "DATE",
  placeholder: "",
  parse: (input) =>
    Number.isFinite(Date.parse(input))
      ? { success: true, value: new Date(input).toISOString() }
      : { success: false, error: message`Expected a date, but got ${input}.` },
  format: (value) => value,
};

/** A whole number of minutes, written as a duration (`5m`, `1h`), in milliseconds. */
const intervalValue: ValueParser<"sync", number> = {
  mode: "sync",
  metavar: "DURATION",
  placeholder: 60_000,
  parse: (input) => {
    let ms: number;
    try {
      ms = duration(input, "The interval");
    } catch (error) {
      if (!(error instanceof MachineConfigError)) throw error;
      return { success: false, error: [text(`${error.message}.`)] };
    }
    return ms % 60_000 === 0
      ? { success: true, value: ms }
      : {
          success: false,
          error: message`Expected whole minutes, but got ${input}.`,
        };
  },
  format: (ms) => `${ms / 60_000}m`,
};

const tick = object({
  action: constant("tick"),
  apply: option("--apply", {
    description: message`Start what the machine file (~/.jig/dispatch.yaml) enables for each repository. Without it, the run only reports.`,
  }),
  repos: multiple(
    option("--repo", pathValue, {
      description: message`A repository to read; repeat it for more. Without it, the machine file's repositories, else the current checkout.`,
    }),
  ),
  followupSince: optional(
    option("--followup-since", dateValue, {
      description: message`Start the window that merges owe follow-ups from at this date, for every repository.`,
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
    intervalMs: optional(
      option("--interval", intervalValue, {
        description: message`How often the timer runs, in whole minutes (5m, 1h). Without it, the machine file's interval, else five minutes.`,
      }),
    ),
    confirm: option("--yes", {
      description: message`Write the job the preview shows.`,
    }),
    uninstall: option("--uninstall", {
      description: message`Remove the job instead.`,
    }),
  }),
  {
    brief: message`Install the timer that runs dispatch --apply.`,
    description: message`Previews the scheduler job that runs jig dispatch --apply every interval; --yes writes it.`,
  },
);

const receipts = command(
  "receipts",
  object({
    action: constant("receipts"),
    runId: optional(
      argument(string({ metavar: "RUN-ID" }), {
        description: message`Print the run with that id. Without it, list every run.`,
      }),
    ),
  }),
  { brief: message`List the receipts of earlier runs, or print one.` },
);

/** `jig dispatch`: one tick by default, `install` and `receipts` as its subcommands. */
export const dispatchCommand = command(
  "dispatch",
  withDefault(or(installation, receipts, tick), {
    action: "tick",
    apply: false,
    repos: [],
    followupSince: undefined,
    json: false,
  } as const),
  {
    brief: message`Say which stages of the delivery loop should be running, and start them.`,
    description: message`Reads the tracker, the pull requests' drive ledgers, the running sessions and this machine's launch records for each repository, and prints every action it would take, with the record that wants it and the evidence. Each run writes a receipt.`,
  },
);

export type DispatchArguments = InferValue<typeof dispatchCommand>;
type Tick = Extract<DispatchArguments, { action: "tick" }>;

function showReceipts(id: string | undefined): number {
  const paths = receiptPaths();
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
function repositories(options: Tick, machine: MachineConfig | null): string[] {
  if (options.repos.length > 0) return [...options.repos];
  if (machine !== null && machine.repositories.length > 0)
    return machine.repositories.map((r) => r.path);
  return [consumerRoot()];
}

export async function dispatchMain(
  args: DispatchArguments,
  script = "",
): Promise<number> {
  if (args.action === "receipts") return showReceipts(args.runId);
  if (args.action === "install")
    // A removal needs no machine file: a broken one must not keep the timer installed.
    return installDispatch(
      {
        intervalMs: args.intervalMs ?? null,
        confirm: args.confirm,
        uninstall: args.uninstall,
      },
      script,
      args.uninstall ? null : machineFile(),
    );
  const machine = machineFile();
  if (args.apply && machine === null)
    throw new ExitError(
      2,
      `jig dispatch --apply needs the machine file ${machineConfigPath()}: the repositories, the stages enabled for each and the accounts it may bill (see CONFIGURATION.md § The machine's dispatch file). Run without --apply for the report.`,
    );
  const result = await runTick({
    repos: repositories(args, machine),
    apply: args.apply,
    machine,
    ...(args.followupSince === undefined
      ? {}
      : { followupSince: args.followupSince }),
  });
  if ("held" in result) {
    console.error(`jig dispatch: another tick holds the lock: ${result.held}`);
    return LOCK_HELD_EXIT;
  }
  console.log(
    args.json
      ? JSON.stringify(result.receipt, null, 2)
      : formatReceipt(result.receipt, result.path),
  );
  return result.receipt.exitStatus;
}
