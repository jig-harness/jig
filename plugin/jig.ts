#!/usr/bin/env bun
/**
 * Installed command entry point: bun <plugin>/jig.ts <command> …, and what
 * the `jig` command on `PATH` runs.
 *
 * It registers the components, resource collection (`gc/component.ts`) and
 * the dispatcher (`dispatch/component.ts`): each defines its own command
 * beside its code, and the lifecycle verbs (`runtime/verbs.ts`: install,
 * uninstall, upgrade, doctor, status, receipts, run) act on them through one
 * interface. Beside them it registers the commands that run and exit with
 * nothing to install, `jig ask` (`ask/component.ts`) and `jig send`
 * (`send/component.ts`). All of
 * it is one Optique parser, so `jig --help`, `jig help <command>`,
 * `<command> --help` and `jig completion <shell>` come from the same
 * definitions that parse.
 */
import { fileURLToPath } from "node:url";
import { gcComponent } from "./gc/component.ts";
import { dispatchComponent } from "./dispatch/component.ts";
import { askComponent } from "./ask/component.ts";
import { sendComponent } from "./send/component.ts";
import { runMain as dispatchRun } from "./dispatch/run.ts";
import type { CommandComponent, Component } from "./runtime/component.ts";
import { runVerb, verbCommands } from "./runtime/verbs.ts";
import { runMain, ExitError } from "./shared/cli.ts";
import { USAGE_EXIT } from "./shared/command-line.ts";
import { map, message, or, runParser } from "./shared/vendor/optique.mjs";

/** The components, in the order the lifecycle verbs act on them. */
const COMPONENTS: readonly Component[] = [gcComponent, dispatchComponent];

/** Every command beside the verbs: the components', then the ones the verbs never act on. */
const COMMANDS: readonly CommandComponent[] = [
  ...COMPONENTS,
  askComponent,
  sendComponent,
];

const verbs = verbCommands(COMPONENTS.map((component) => component.name));

/** A component's stricter parser, where it has one. */
function strictOf(command: CommandComponent) {
  const component = COMPONENTS.find((c) => c.name === command.name);
  return component?.strictCommand ?? command.command;
}

/** Each command beside the verbs; `strict` takes a component's stricter parser. */
const programOf = (strict: boolean) =>
  or(
    verbs,
    ...COMMANDS.map((command) =>
      map(strict ? strictOf(command) : command.command, (args) => ({
        component: command.name,
        args,
      })),
    ),
  );
const program = programOf(false);
// A component may hold the option that wins to more than the first parse
// does, so it is checked in a second one.
const strictProgram = programOf(true);

/** A command line's exit carries its message to standard error; anything else reaches `runMain`. */
function reportExit(error: unknown): void {
  if (error instanceof ExitError) console.error(error.message);
}

/**
 * The parsed command line. Help and completion scripts go to standard
 * output, a refused command line's error and usage to standard error, and
 * each ends the run with its exit code (0, or 2 for a refusal).
 */
export function parseCommandLine(
  argv: readonly string[],
  parser: typeof program = program,
) {
  return runParser(parser, "jig", argv, {
    brief: message`Jig's machine-level tools: resource collection and the dispatcher, the commands that install, upgrade, check, remove, report on and run them, asking a station of the line where it stands, and telling it what to do.`,
    showChoices: true,
    help: {
      command: true,
      option: true,
      onShow: (code: number): never => {
        throw new ExitError(code);
      },
    },
    completion: {
      command: true,
      onShow: (code: number): never => {
        throw new ExitError(code);
      },
    },
    onError: (): never => {
      throw new ExitError(USAGE_EXIT);
    },
  });
}

type Parsed = ReturnType<typeof parseCommandLine>;

/** The command line to parse again strictly, for a component command that asks for it. */
function strictArgv(parsed: Parsed, argv: readonly string[]) {
  if ("verb" in parsed) return null;
  return (
    COMPONENTS.find(
      (component) => component.name === parsed.component,
    )?.strictArguments?.(parsed.args, argv) ?? null
  );
}

function commandNamed(name: string): CommandComponent {
  return COMMANDS.find((command) => command.name === name) as CommandComponent;
}

/** Runs a parsed command line: a lifecycle verb, or a component's own command. */
function execute(parsed: Parsed, script: string): Promise<number> {
  if ("verb" in parsed)
    return runVerb(parsed, {
      components: COMPONENTS,
      script,
      run: (argv) => execute(parseCommandLine(argv), script),
    });
  return commandNamed(parsed.component).main(parsed.args, script);
}

export async function main(argv: string[]): Promise<number> {
  const script = fileURLToPath(import.meta.url);
  // The wrapper a dispatched pass's terminal runs (dispatch/run.ts), its
  // arguments passed on as they are.
  if (argv[0] === "dispatch" && argv[1] === "run")
    try {
      return await dispatchRun(argv.slice(2));
    } catch (error) {
      reportExit(error);
      throw error;
    }
  const parsed = parseCommandLine(argv);
  const strict = strictArgv(parsed, argv);
  if (strict !== null) parseCommandLine(strict, strictProgram);
  try {
    return await execute(parsed, script);
  } catch (error) {
    reportExit(error);
    throw error;
  }
}
if (import.meta.main) runMain("jig", () => main(process.argv.slice(2)));
