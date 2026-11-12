/**
 * `jig dispatch`: one tick of the dispatcher. It reads the tracker, the
 * forge's drive ledgers, the session runtime and this machine's launch
 * records for each repository and prints every stage it would start, with
 * the record that wants it and the evidence. With `--apply` it starts the
 * stages the machine file (`~/.jig/dispatch.yaml`) enables for each
 * repository: the drives' re-arms and takeovers, and the follow-ups and
 * the pickups as headless passes.
 * `jig dispatch install` writes the timer that runs `--apply` every
 * interval; `jig dispatch result` is how a dispatched session or follow-up pass
 * records how it ended; `jig dispatch marker` is how a follow-up command
 * claims a merged pull request's follow-up, checks its claim and marks it
 * done or failed; `jig dispatch labels` creates the pull request state labels
 * a repository turns on, once, with no job installed; `jig dispatch dashboard` serves one page over the outcome log while
 * it runs; `jig dispatch log` prints the outcome log as text; `jig dispatch
 * line --json` prints the newest tick's line as the dashboard serves it;
 * `jig dispatch clear` removes a launch record only a person can settle;
 * `jig dispatch probe` reads the forge for what changed since the last probe
 * and, with `--apply`, wakes those repositories' ticks.
 */
import { basename, dirname } from "node:path";
import { consumerRoot } from "../shared/consumer.ts";
import { ExitError } from "../shared/cli.ts";
import { dateValue, pathValue, USAGE_EXIT } from "../shared/command-line.ts";
import {
  argument,
  choice,
  command,
  constant,
  flag,
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
import { dashboardAccess } from "./dashboard-access.ts";
import {
  dashboardInstall,
  dashboardStatus,
  scheduledDashboard,
} from "./dashboard-install.ts";
import { clearMain } from "./clear.ts";
import { installDispatch } from "./install.ts";
import { installLabels } from "./install-labels.ts";
import { newerStateRefusal } from "./lib/state.ts";
import { lineMain } from "./line-command.ts";
import { logMain } from "./log-command.ts";
import {
  duration,
  type MachineConfig,
  machineConfigPath,
  readMachineConfig,
} from "./lib/machine-config.ts";
import { elapsed, formatReceipt } from "./lib/report.ts";
import { markerMain } from "./marker.ts";
import { probeMain } from "./probe-command.ts";
import { readReceipt, receiptPaths, type TickReceipt } from "./receipts.ts";
import { upgradeLine } from "../runtime/upgrade-record.ts";
import { refusedResultMain, resultMain } from "./result.ts";
import { runTick } from "./tick.ts";

/** Exit when another tick holds the lock. */
const LOCK_HELD_EXIT = 3;

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
    const ms = duration(input, "The interval");
    if (!ms.ok)
      return { success: false, error: [text(`${ms.failure.reason}.`)] };
    if (wholeMinutes && ms.value % 60_000 !== 0)
      return {
        success: false,
        error: [text(`The interval must be whole minutes, but got ${input}.`)],
      };
    return { success: true, value: ms.value };
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
      description: message`Previews the scheduler job that runs jig dispatch --apply every interval; --yes writes it. The same as jig install dispatch, or with --uninstall jig uninstall dispatch --machine, with --interval in place of the machine file's; kept for the command lines that use this form.`,
      hidden: true,
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
  {
    brief: message`List the receipts of earlier runs, or print one.`,
    description: message`The same as jig receipts dispatch; kept for the command lines that use this form.`,
    hidden: true,
  },
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
    outcome: argument(string({ metavar: "done|failed|waits" }), {
      description: message`How the session ended; waits is a pickup the tracker's rate limit stopped.`,
    }),
    pr: optional(
      option("--pr", countValue("PR"), {
        description: message`The pull request a completed pickup opened; its next owner is the drive station.`,
      }),
    ),
    none: optional(
      option("--none", string({ metavar: "REASON" }), {
        description: message`Why a completed pickup needs no pull request. Mutually exclusive with --pr.`,
      }),
    ),
    refused: multiple(
      option("--refused", string({ metavar: "UPDATED-AT" }), {
        description: message`A failed pickup whose claim the repository's start rules refused: the item's updatedAt the claim printed. Needs --reason. Repeat it with --key for each batch member refused.`,
      }),
    ),
    keys: multiple(
      option("--key", string({ metavar: "ITEM" }), {
        description: message`The batch member the --refused in the same place belongs to; only the members named are held. Without it, the one --refused holds the whole pickup.`,
      }),
    ),
    reasons: multiple(
      option("--reason", string({ metavar: "REASON" }), {
        description: message`The reason the refused claim printed: once, or once per --key.`,
      }),
    ),
    until: optional(
      option("--until", string({ metavar: "TIME" }), {
        description: message`With waits: when the tracker's rate limit resets (ISO 8601); the item starts again after it.`,
      }),
    ),
  }),
  { brief: message`Record how a dispatched interactive session ended.` },
);

const marker = command(
  "marker",
  object({
    action: constant("marker"),
    verb: argument(choice(["claim", "check", "done", "failed"] as const), {
      description: message`claim posts a manual run's marker; check stops a run an earlier marker holds; done marks a manual run's marker done; failed labels a manual run's follow-up failed, leaving its marker.`,
    }),
    pr: argument(countValue("PR"), {
      description: message`The merged pull request.`,
    }),
    comment: optional(
      option("--comment", countValue("ID"), {
        description: message`The marker's comment id, as claim printed it or the session's prompt names it (check, done and failed).`,
      }),
    ),
    repo: optional(
      option("--repo", string({ metavar: "OWNER/NAME" }), {
        description: message`The repository. Without it, the current checkout's.`,
      }),
    ),
  }),
  {
    brief: message`Claim a merged pull request's follow-up, check the claim, mark it done, or label it failed.`,
  },
);

const labels = command(
  "labels",
  object({
    action: constant("labels"),
    repos: multiple(
      option("--repo", pathValue, {
        description: message`A checkout of the repository whose labels to check. Without it, the current checkout's. Repeat for several.`,
      }),
    ),
    confirm: option("--yes", {
      description: message`Create the labels the preview lists.`,
    }),
  }),
  {
    brief: message`Create the pull request state labels a repository turns on, once.`,
    description: message`For a repository whose dispatch.labels (read from its default branch) is on, lists the state and command labels it lacks, with its manual-operations label and automation; --yes creates them and lists, with the command that creates each, those the signed-in account may not create. Installs no job: drives and follow-ups write the labels without the dispatcher.`,
  },
);

const log = command(
  "log",
  object({
    action: constant("log"),
    since: optional(
      option("--since", dateValue, {
        description: message`Leave out the rows timed before this date.`,
      }),
    ),
    jsonl: option("--jsonl", {
      description: message`Print each row as the JSON line the month files hold.`,
    }),
    acceptance: option("--acceptance", {
      description: message`Report, per repository and decision class, how many parks were answered, how many with the recommended option and no note, and the median wait, instead of the rows.`,
    }),
  }),
  {
    brief: message`Print the outcome log as text, in the order the rows were written.`,
    description: message`Reads the state database and prints one line a row; --jsonl prints the rows as the log-<year>-<month>.jsonl files hold them. --acceptance prints one line per repository and decision class (or one JSON line with --jsonl) over the parked decisions the log counted; it acts on nothing.`,
  },
);

const line = command(
  "line",
  object({
    action: constant("line"),
    json: flag("--json", {
      description: message`Print the line as JSON, the one form it has.`,
    }),
  }),
  {
    brief: message`Print the newest tick's line as JSON, as the dashboard's GET /state answers.`,
    description: message`Reads the state database and prints one JSON document, the answer the dashboard's GET /state gives: {"ok":true,"value":{now, timeZone, plugin, schema, line}}, its line versioned by the line's own version field. It takes no lock and never creates the database; with no database or no line yet, line is null and it exits 0. A line that cannot be read exits 1 with one line on standard error.`,
  },
);

const clear = command(
  "clear",
  object({
    action: constant("clear"),
    record: argument(string({ metavar: "RECORD" }), {
      description: message`The launch record to remove.`,
    }),
  }),
  {
    brief: message`Remove a launch record only a person can settle.`,
    description: message`Removes a launch record that is unknown, pending or unreadable, which holds its stage and its account's slot until it is cleared; refuses one whose session is running.`,
  },
);

const probe = command(
  "probe",
  object({
    action: constant("probe"),
    apply: option("--apply", {
      description: message`Wake the tick of each repository that changed, and keep what the probe saw for the next one. Without it, the probe only says what it would wake, and writes nothing.`,
    }),
    json: option("--json", {
      description: message`Print the probe's report as JSON.`,
    }),
  }),
  {
    brief: message`Read the forge once for what changed since the last probe, and wake those repositories' ticks.`,
    description: message`One search over every repository the machine file dispatches: the pull requests updated since the last probe and every open one's checks. With --apply, each repository where something changed has its tick woken, under the rule jig send's wakes follow; its own timer runs it every minute. A forge that does not read wakes nothing and exits 1.`,
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
    install: option("--install"),
    uninstall: option("--uninstall"),
    confirm: option("--yes"),
    status: option("--status"),
    access: option("--access"),
    scheduled: option("--scheduled"),
    port: optional(
      option("--port", portValue, {
        description: message`The port to listen on. Without it, the port dashboard.listen names, else ${String(DEFAULT_PORT)}.`,
      }),
    ),
  }),
  {
    brief: message`Serve one page over the outcome log, filtered by time, repository, stage, account and class.`,
    description: message`Listens on the machine file's dashboard.listen, an address in the private or loopback ranges, until stopped; prints its URL with the token a request needs. It reads the log when the page asks and writes nothing. --access prints the installed reader's URL, or the token-free address of a front named as dashboard.front with its QR code.`,
  },
);

/**
 * `jig dispatch`: one tick by default, with `result`, `marker`, `labels`, `dashboard`,
 * `log`, `line`, `clear` and `probe` as its subcommands. Its `install` and `receipts`
 * subcommands do what the lifecycle verbs `jig install dispatch` and
 * `jig receipts dispatch` do, and stay for the command lines that use them,
 * hidden from help.
 */
const dispatch = (wholeMinutes: boolean) =>
  command(
    "dispatch",
    withDefault(
      or(
        installation(wholeMinutes),
        receipts,
        result,
        marker,
        labels,
        dashboard,
        log,
        line,
        clear,
        probe,
        tick,
      ),
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

/** How long a tick took, where its receipt timed its phases. */
function took(r: TickReceipt): string {
  const phases = Object.values(r.phasesMs ?? {});
  if (phases.length === 0) return "";
  return ` in ${elapsed(phases.reduce((n, ms) => n + (ms ?? 0), 0))}`;
}

/** How many defects a receipt records, its own and its repositories'. */
function defects(r: TickReceipt): string {
  const n =
    r.repos.filter((repo) => repo.defect !== undefined).length +
    r.repos.reduce((sum, repo) => sum + (repo.stageDefects?.length ?? 0), 0) +
    (r.defect === undefined ? 0 : 1);
  return n === 0 ? "" : `, ${n} defect(s)`;
}

/** The upgrade the launcher ran before the tick, where it ran one. */
function upgraded(r: TickReceipt): string {
  return r.upgrade === undefined ? "" : `  upgrade ${upgradeLine(r.upgrade)}`;
}

/** One line per receipt that reads: its run, outcome, duration, size, defects, upgrade and file. */
function listReceipts(paths: readonly string[]): void {
  for (const path of paths) {
    const r = readReceipt(path);
    if (r === null) continue;
    const actions = r.repos.reduce((n, repo) => n + repo.actions.length, 0);
    console.log(
      `${r.runId}  ${r.startedAt}  ${r.lockHeldBy !== undefined ? "lock held" : r.completed ? `exit ${r.exitStatus}` : "incomplete"}${took(r)}  ${r.repos.length} repositor${r.repos.length === 1 ? "y" : "ies"}, ${actions} action(s)${defects(r)}${upgraded(r)}  ${path}`,
    );
  }
}

/** Lists every receipt, or that day's (`YYYY-MM-DD`), or prints the run with that id. */
export function showReceipts(id: string | undefined): number {
  const paths = receiptPaths();
  if (id === undefined) {
    listReceipts(paths);
    return 0;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(id)) {
    listReceipts(paths.filter((path) => basename(dirname(path)) === id));
    return 0;
  }
  const path = paths.find(
    (p) => p.endsWith(`/${id}.json`) || p.endsWith(`\\${id}.json`),
  );
  const receipt = path === undefined ? null : readReceipt(path);
  if (receipt === null) throw new ExitError(USAGE_EXIT, `No receipt ${id}`);
  console.log(JSON.stringify(receipt, null, 2));
  return 0;
}

/** The machine file, or null without one; one that does not read is a usage error (exit 2). */
export function machineFile(): MachineConfig | null {
  const machine = readMachineConfig();
  if (!machine.ok) throw new ExitError(USAGE_EXIT, machine.failure.reason);
  return machine.value;
}

/** The repositories a tick reads: `--repo`, else the machine file's, else this checkout. */
function repositories(options: Tick, machine: MachineConfig | null): string[] {
  if (options.repos.length > 0) return [...options.repos];
  if (machine !== null && machine.repositories.length > 0)
    return machine.repositories.map((r) => r.path);
  return [consumerRoot()];
}

type Subcommand = Exclude<DispatchArguments, { action: "tick" }>;

/** Forward a refused pickup's result: `--refused`, `--key` and `--reason`, and no handoff. */
function refusedResult(
  args: Extract<Subcommand, { action: "result" }>,
): number {
  if (
    args.pr !== undefined ||
    args.none !== undefined ||
    args.until !== undefined
  ) {
    console.error(
      "jig dispatch result: --refused is a failed pickup's; it takes no --pr, --none or --until",
    );
    return 2;
  }
  return refusedResultMain(args.record, args.token, args.outcome, {
    refused: args.refused,
    keys: args.keys,
    reasons: args.reasons,
  });
}

/** Forward a session result and its mutually exclusive handoff arguments. */
function sessionResultMain(
  args: Extract<Subcommand, { action: "result" }>,
): number {
  if (
    [args.pr, args.none, args.until].filter((v) => v !== undefined).length > 1
  ) {
    console.error(
      "jig dispatch result: pass one of --pr, --none and --until, not several",
    );
    return 2;
  }
  if (
    args.refused.length > 0 ||
    args.keys.length > 0 ||
    args.reasons.length > 0
  )
    return refusedResult(args);
  return resultMain([
    args.record,
    args.token,
    args.outcome,
    ...(args.pr === undefined ? [] : ["--pr", String(args.pr)]),
    ...(args.none === undefined ? [] : ["--none", args.none]),
    ...(args.until === undefined ? [] : ["--until", args.until]),
  ]);
}

/** `jig dispatch dashboard`: the machine file's address and whether it asks for the token. */
function dashboardCommand(port: number | undefined): Promise<number> {
  const machine = machineFile();
  return dashboardMain(
    machine?.dashboardListen ?? null,
    port,
    machineConfigPath(),
    machine?.dashboardRequireToken ?? true,
    machine?.dashboardAllowedHosts ?? [],
  );
}

function checkDashboardArguments(
  args: Extract<Subcommand, { action: "dashboard" }>,
): void {
  const actions = [
    args.install,
    args.uninstall,
    args.status,
    args.access,
    args.scheduled,
  ].filter(Boolean).length;
  if (
    actions > 1 ||
    (actions > 0 && args.port !== undefined) ||
    (args.confirm && !args.install && !args.uninstall)
  )
    throw new ExitError(
      USAGE_EXIT,
      "Choose one dashboard action; --port is for the foreground reader and --yes for install/uninstall",
    );
}

/** Route the dashboard lifecycle separately from dispatch's other actions. */
function dashboardAction(
  args: Extract<Subcommand, { action: "dashboard" }>,
  script: string,
): number | Promise<number> {
  checkDashboardArguments(args);
  if (args.install || args.uninstall)
    return dashboardInstall(args.confirm, args.uninstall, script);
  if (args.status) return dashboardStatus();
  if (args.access) return dashboardAccess();
  if (args.scheduled) return scheduledDashboard(script);
  return dashboardCommand(args.port);
}

/** The subcommands that act on a repository's pull requests: the label setup and the follow-up marker. */
function pullRequestAction(
  args: Extract<Subcommand, { action: "labels" | "marker" }>,
): Promise<number> {
  if (args.action === "labels")
    return installLabels(
      args.repos.length === 0 ? [consumerRoot()] : args.repos,
      args.confirm,
    );
  return markerMain({
    verb: args.verb,
    pr: args.pr,
    comment: args.comment ?? null,
    repo: args.repo ?? null,
  });
}

/** A subcommand's run: everything but the tick. */
function subcommandMain(
  args: Subcommand,
  script: string,
): number | Promise<number> {
  if (args.action === "result") return sessionResultMain(args);
  if (args.action === "receipts") return showReceipts(args.runId);
  if (args.action === "log")
    return logMain({
      jsonl: args.jsonl,
      acceptance: args.acceptance,
      ...(args.since === undefined ? {} : { since: args.since }),
    });
  if (args.action === "line") return lineMain();
  if (args.action === "clear") return clearMain(args.record);
  if (args.action === "probe")
    return probeMain({ apply: args.apply, json: args.json }, machineFile());
  if (args.action === "dashboard") return dashboardAction(args, script);
  if (args.action === "labels" || args.action === "marker")
    return pullRequestAction(args);
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
  try {
    return await commandMain(args, script);
  } catch (error) {
    // A state database a newer plugin wrote is refused by every command that reads it.
    const newer = newerStateRefusal(error);
    if (newer !== null)
      throw new ExitError(USAGE_EXIT, `jig dispatch: ${newer}`, {
        cause: error,
      });
    throw error;
  }
}

async function commandMain(
  args: DispatchArguments,
  script: string,
): Promise<number> {
  if (args.action !== "tick") return subcommandMain(args, script);
  const machine = machineFile();
  if (args.apply && machine === null)
    throw new ExitError(
      USAGE_EXIT,
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
