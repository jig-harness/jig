/**
 * The lifecycle verbs of the `jig` command: `install`, `uninstall`, `status`,
 * `receipts` and `run`. Each acts on the components it names or, with none
 * named, on every registered one, in the order `jig.ts` registers them, and
 * reaches a component only through `Component` (`component.ts`): a third
 * component joins with no change here. A component's own work stays under
 * its name (`jig gc --collect`, `jig dispatch --apply`).
 *
 * `install` and `run` with no component named leave out a component whose
 * opt-in is missing, and say why; named, it is the component's own install or
 * run that refuses. A verb over several components stops at the first that
 * fails, with its exit code, so what follows it is left as it was.
 */
import { pathValue } from "../shared/command-line.ts";
import {
  argument,
  choice,
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
} from "../shared/vendor/optique.mjs";
import type { Component } from "./component.ts";
import { formatStatus } from "./job-status.ts";
import { collectionDeadlineMs } from "./launcher.ts";
import {
  checkCommandPath,
  installCommand,
  removeCommand,
} from "./path-command.ts";
import { checkLauncherResolves } from "./scheduler.ts";

/** The verbs' commands, for the components named `names`. */
export function verbCommands(names: readonly string[]) {
  const component = choice(names, { metavar: "COMPONENT" });
  const components = multiple(
    argument(component, {
      description: message`The components to act on; repeat for more. Without any, every component.`,
    }),
  );
  const repository = optional(
    option("--repo", pathValue, {
      description: message`The repository resource collection registers or removes. Without it, the current checkout.`,
    }),
  );
  const confirm = option("--yes", {
    description: message`Make the change the preview shows. Without it, only the preview.`,
  });
  return or(
    command(
      "install",
      object({
        verb: constant("install"),
        components,
        repository,
        confirm,
      }),
      {
        brief: message`Install each component's timer, and the jig command on PATH.`,
        description: message`Previews, and with --yes writes, each component's scheduled job and the jig command (~/.local/bin/jig), which runs the installed plugin copy, so a plugin update reaches it. Without a component named, it installs resource collection, and the dispatcher only when its machine file (~/.jig/dispatch.yaml) exists.`,
      },
    ),
    command(
      "uninstall",
      object({
        verb: constant("uninstall"),
        components,
        repository,
        machine: option("--machine", {
          description: message`Remove each component's job, not only what it holds for this repository; with no component named, the jig command too.`,
        }),
        confirm,
      }),
      {
        brief: message`Remove what install wrote.`,
        description: message`Previews, and with --yes removes, this repository's entry in resource collection; with --machine, each component's job as well.`,
      },
    ),
    command(
      "status",
      object({
        verb: constant("status"),
        components,
        json: option("--json", {
          description: message`Print the status as JSON.`,
        }),
      }),
      {
        brief: message`Say whether each component's job is installed, its last run and its next.`,
      },
    ),
    command(
      "receipts",
      object({
        verb: constant("receipts"),
        component: argument(component, {
          description: message`The component whose receipts to read.`,
        }),
        query: optional(
          argument(string({ metavar: "DATE|RUN-ID" }), {
            description: message`List that day's receipts (YYYY-MM-DD), or print the run with that id. Without it, list every receipt.`,
          }),
        ),
      }),
      {
        brief: message`List a component's receipts of earlier runs, or print one.`,
      },
    ),
    command("run", object({ verb: constant("run"), components }), {
      brief: message`Run what each component's timer runs, now.`,
      description: message`Runs each component's scheduled command (jig gc --scheduled, jig dispatch --apply) as its timer would. Without a component named, it leaves out the dispatcher when its machine file does not exist.`,
    }),
  );
}

export type VerbArguments = InferValue<ReturnType<typeof verbCommands>>;

export interface VerbContext {
  /** The registered components, in the order the verbs act on them. */
  components: readonly Component[];
  /** The running `jig.ts`. */
  script: string;
  /** The platform the verbs run on; Windows has no scheduler for a component's job. */
  platform?: NodeJS.Platform;
  /** Runs a `jig` command line in this process: how `run` starts a timer's command. */
  run(argv: readonly string[]): Promise<number>;
}

/** The components `names` selects, in registration order; all of them when none is named. */
function selection(
  names: readonly string[],
  components: readonly Component[],
): readonly Component[] {
  return names.length === 0
    ? components
    : components.filter((component) => names.includes(component.name));
}

/**
 * Runs `step` for each component `names` selects, in turn, stopping at the
 * first that does not exit 0. Given `skip`, a component whose opt-in is
 * missing is left out when none is named, and `skip` says why in its place.
 */
async function each(
  names: readonly string[],
  components: readonly Component[],
  step: (component: Component) => Promise<number>,
  skip?: (line: string) => void,
): Promise<number> {
  for (const component of selection(names, components)) {
    const missing =
      skip !== undefined && names.length === 0
        ? component.missingOptIn()
        : null;
    if (missing !== null) {
      skip?.(`${component.name}: skipped: ${missing}`);
      continue;
    }
    const code = await step(component);
    if (code !== 0) return code;
  }
  return 0;
}

/**
 * The longest the jig command lets one invocation run: every component's
 * budget added, since `jig run` works through the components in turn and
 * `jig gc` is bounded by collection's own default (a lock wait and two hours
 * of work) where its job names none.
 */
function commandDeadlineSec(components: readonly Component[]): number {
  // Collection's own default, never the enclosing command's saved deadline:
  // reinstalling through the installed command would otherwise add it again.
  const own = Math.ceil(
    collectionDeadlineMs({
      ...process.env,
      JIG_LAUNCHER_DEADLINE_SEC: undefined,
    }) / 1000,
  );
  return components.reduce(
    (total, component) => total + (component.job().deadlineSec ?? own),
    0,
  );
}

const heading = (component: Component) =>
  console.log(`== ${component.name} ==`);

/**
 * Whether the verb leaves every component's job alone: jobs run on systemd,
 * launchd or cron, so on Windows only the command is written or removed.
 * Naming a component there is refused as the component refuses it.
 */
function withoutJobs(
  args: { components: readonly string[] },
  context: VerbContext,
): boolean {
  return (
    (context.platform ?? process.platform) === "win32" &&
    args.components.length === 0
  );
}

/** Prints each selected component's status; fails when a scheduler could not be read. */
async function statusVerb(
  args: { components: readonly string[]; json: boolean },
  components: readonly Component[],
): Promise<number> {
  const statuses = [];
  for (const component of selection(args.components, components))
    statuses.push(await component.status());
  console.log(
    args.json
      ? JSON.stringify(statuses, null, 2)
      : statuses.map(formatStatus).join("\n"),
  );
  // An unreadable scheduler is not an absent job: report the rest, then fail.
  return statuses.some((status) => status.error !== undefined) ? 1 : 0;
}

export async function runVerb(
  args: VerbArguments,
  context: VerbContext,
): Promise<number> {
  const { components, script } = context;
  switch (args.verb) {
    case "install": {
      checkCommandPath();
      const jobless = withoutJobs(args, context);
      if (jobless) {
        console.log(
          "Scheduled jobs need macOS or Linux: writing the jig command only.",
        );
        await checkLauncherResolves();
      }
      const code = jobless
        ? 0
        : await each(
            args.components,
            components,
            (component) => {
              heading(component);
              return component.install({
                repository: args.repository,
                confirm: args.confirm,
                script,
              });
            },
            console.log,
          );
      if (code !== 0) return code;
      console.log("== the jig command ==");
      const deadlineSec = commandDeadlineSec(components);
      return installCommand({
        confirm: args.confirm,
        script,
        ...(deadlineSec > 0 ? { deadlineSec } : {}),
      });
    }
    case "uninstall": {
      const code = withoutJobs(args, context)
        ? 0
        : await each(args.components, components, (component) => {
            heading(component);
            return component.uninstall({
              repository: args.repository,
              confirm: args.confirm,
              machine: args.machine,
              script,
            });
          });
      if (code !== 0 || !args.machine || args.components.length > 0)
        return code;
      console.log("== the jig command ==");
      return removeCommand({ confirm: args.confirm });
    }
    case "status":
      return statusVerb(args, components);
    case "receipts":
      return (
        components.find(
          (component) => component.name === args.component,
        ) as Component
      ).receipts(args.query);
    case "run":
      return each(
        args.components,
        components,
        (component) => {
          const argv = component.job().args;
          console.error(`${component.name}: running jig ${argv.join(" ")}`);
          return context.run(argv);
        },
        console.error,
      );
  }
}
