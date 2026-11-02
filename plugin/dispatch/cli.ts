/**
 * `jig dispatch`: one tick of the dispatcher. It reads the tracker, the
 * forge's drive ledgers, the session runtime and this machine's launch
 * records for each repository and prints every stage it would start, with
 * the record that wants it and the evidence. With `--apply` it starts the
 * stages the machine file (`~/.jig/dispatch.yaml`) enables for each
 * repository: the drives' re-arms and takeovers, and the pickups where the
 * session runtime binds an interactive session to its account.
 * `jig dispatch install` writes the timer that runs `--apply` every
 * interval; `jig dispatch result` is how a dispatched interactive session
 * records how it ended; `jig dispatch marker` is how a follow-up command
 * claims a merged pull request's follow-up, checks its claim and marks it
 * done; `jig dispatch dashboard` serves one page over the outcome log while
 * it runs.
 */
import { consumerRoot } from "../shared/consumer.ts";
import { ExitError } from "../shared/cli.ts";
import { pathValue } from "../shared/command-line.ts";
import {
  argument,
  choice,
  command,
  constant,
  type InferValue,
  map,
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
import { DEFAULT_PORT, dashboardMain } from "./dashboard.ts";
import { installDispatch } from "./install.ts";
import {
  duration,
  type MachineConfig,
  MachineConfigError,
  machineConfigPath,
  readMachineConfig,
} from "./lib/machine-config.ts";
import { formatReceipt } from "./lib/report.ts";
import { markerMain } from "./marker.ts";
import { readReceipt, receiptPaths } from "./receipts.ts";
import { resultMain } from "./result.ts";
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

/** A positive whole number: a pull request's, or a comment's id. */
const countValue = (metavar: "PR" | "ID"): ValueParser<"sync", number> => ({
  mode: "sync",
  metavar,
  placeholder: 1,
  parse: (input) =>
    /^[1-9][0-9]*$/.test(input) && Number.isSafeInteger(Number(input))
      ? { success: true, value: Number(input) }
      : {
          success: false,
          error: message`Expected a positive whole number, but got ${input}.`,
        },
  format: (value) => String(value),
});

/**
 * A duration (`90s`, `5m`, `1h`) in milliseconds. `install` requires whole
 * minutes of the interval that wins, so the lenient form takes any duration
 * and `winningIntervalArguments` feeds the strict one the winner alone.
 */
const intervalValue = (wholeMinutes: boolean): ValueParser<"sync", number> => ({
  mode: "sync",
  metavar: "DURATION",
  placeholder: 60_000,
  parse: (input) => {
    try {
      const ms = duration(input, "The interval");
      if (wholeMinutes && ms % 60_000 !== 0)
        return {
          success: false,
          error: [
            text(`The interval must be whole minutes, but got ${input}.`),
          ],
        };
      return { success: true, value: ms };
    } catch (error) {
      if (!(error instanceof MachineConfigError)) throw error;
      return { success: false, error: [text(`${error.message}.`)] };
    }
  },
  format: (ms) => `${ms / 60_000}m`,
});

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
  followupSince: map(
    multiple(
      option("--followup-since", dateValue, {
        description: message`Start the window that merges owe follow-ups from at this date, for every repository. The last one given wins.`,
      }),
    ),
    (values) => values.at(-1),
  ),
  json: option("--json", {
    description: message`Print the receipt as JSON.`,
  }),
});

const installation = (wholeMinutes: boolean) =>
  command(
    "install",
    object({
      action: constant("install"),
      intervalMs: map(
        multiple(
          option("--interval", intervalValue(wholeMinutes), {
            description: message`How often the timer runs, in whole minutes (5m, 1h). Without it, the machine file's interval, else five minutes. The last one given wins.`,
          }),
        ),
        (values) => values.at(-1),
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

const result = command(
  "result",
  object({
    action: constant("result"),
    record: argument(string({ metavar: "RECORD" }), {
      description: message`The launch record the session was started under.`,
    }),
    token: argument(string({ metavar: "TOKEN" }), {
      description: message`The record's token, named in the session's prompt.`,
    }),
    outcome: argument(string({ metavar: "done|failed" }), {
      description: message`How the session ended.`,
    }),
  }),
  { brief: message`Record how a dispatched interactive session ended.` },
);

const marker = command(
  "marker",
  object({
    action: constant("marker"),
    verb: argument(choice(["claim", "check", "done"] as const), {
      description: message`claim posts a manual run's marker; check stops a run an earlier marker holds; done marks a manual run's marker done.`,
    }),
    pr: argument(countValue("PR"), {
      description: message`The merged pull request.`,
    }),
    comment: optional(
      option("--comment", countValue("ID"), {
        description: message`The marker's comment id, as claim printed it or the session's prompt names it (check and done).`,
      }),
    ),
    repo: optional(
      option("--repo", string({ metavar: "OWNER/NAME" }), {
        description: message`The repository. Without it, the current checkout's.`,
      }),
    ),
  }),
  {
    brief: message`Claim a merged pull request's follow-up, check the claim, or mark it done.`,
  },
);

/** A port between 1 and 65535. */
const portValue: ValueParser<"sync", number> = {
  mode: "sync",
  metavar: "PORT",
  placeholder: 1,
  parse: (input) =>
    /^[1-9][0-9]*$/.test(input) && Number(input) <= 65_535
      ? { success: true, value: Number(input) }
      : {
          success: false,
          error: message`Expected a port between 1 and 65535, but got ${input}.`,
        },
  format: (value) => String(value),
};

const dashboard = command(
  "dashboard",
  object({
    action: constant("dashboard"),
    port: optional(
      option("--port", portValue, {
        description: message`The port to listen on. Without it, the port dashboard.listen names, else ${String(DEFAULT_PORT)}.`,
      }),
    ),
  }),
  {
    brief: message`Serve one page over the outcome log, filtered by time, repository, stage, account and class.`,
    description: message`Listens on the machine file's dashboard.listen, an address in the private or loopback ranges, until stopped; prints its URL with the token a request needs. It reads the log when the page asks and writes nothing.`,
  },
);

/** `jig dispatch`: one tick by default, `install`, `receipts`, `result`, `marker` and `dashboard` as its subcommands. */
const dispatch = (wholeMinutes: boolean) =>
  command(
    "dispatch",
    withDefault(
      or(installation(wholeMinutes), receipts, result, marker, dashboard, tick),
      {
        action: "tick",
        apply: false,
        repos: [],
        followupSince: undefined,
        json: false,
      } as const,
    ),
    {
      brief: message`Say which stages of the delivery loop should be running, and start them.`,
      description: message`Reads the tracker, the pull requests' drive ledgers, the running sessions and this machine's launch records for each repository, and prints every action it would take, with the record that wants it and the evidence. Each run writes a receipt.`,
    },
  );

export const dispatchCommand = dispatch(false);
/** The same command with `install --interval` held to whole minutes. */
export const strictDispatchCommand = dispatch(true);

export type DispatchArguments = InferValue<typeof dispatchCommand>;

/**
 * `argv` with every `--interval` but the last removed: the one that wins,
 * which `strictDispatchCommand` then validates alone.
 */
export function winningIntervalArguments(argv: readonly string[]): string[] {
  const starts: number[] = [];
  argv.forEach((arg, i) => {
    if (arg === "--interval" || arg.startsWith("--interval=")) starts.push(i);
  });
  const drop = new Set<number>();
  for (const i of starts.slice(0, -1)) {
    drop.add(i);
    if (argv[i] === "--interval") drop.add(i + 1);
  }
  return argv.filter((_, i) => !drop.has(i));
}
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

type Subcommand = Exclude<DispatchArguments, { action: "tick" }>;

/** A subcommand's run: everything but the tick. */
function subcommandMain(
  args: Subcommand,
  script: string,
): number | Promise<number> {
  if (args.action === "result")
    // An interactive session's own answer, under its launch record's token.
    return resultMain([args.record, args.token, args.outcome]);
  if (args.action === "receipts") return showReceipts(args.runId);
  if (args.action === "dashboard")
    return dashboardMain(
      machineFile()?.dashboardListen ?? null,
      args.port,
      machineConfigPath(),
    );
  if (args.action === "marker")
    return markerMain({
      verb: args.verb,
      pr: args.pr,
      comment: args.comment ?? null,
      repo: args.repo ?? null,
    });
  // `install`. A removal needs no machine file: a broken one must not keep the timer installed.
  return installDispatch(
    {
      intervalMs: args.intervalMs ?? null,
      confirm: args.confirm,
      uninstall: args.uninstall,
    },
    script,
    args.uninstall ? null : machineFile(),
  );
}

export async function dispatchMain(
  args: DispatchArguments,
  script = "",
): Promise<number> {
  if (args.action !== "tick") return subcommandMain(args, script);
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
