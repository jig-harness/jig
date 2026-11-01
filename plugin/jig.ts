#!/usr/bin/env bun
/**
 * Installed command entry point: bun <plugin>/jig.ts <command> …, and what
 * the `jig` command on `PATH` runs.
 *
 * It registers the components, resource collection (`gc/component.ts`) and
 * the dispatcher (`dispatch/component.ts`): each defines its own command
 * beside its code, and the lifecycle verbs (`runtime/verbs.ts`: install,
 * uninstall, status, receipts, run) act on them through one interface. All of
 * it is one Optique parser, so `jig --help`, `jig help <command>`,
 * `<command> --help` and `jig completion <shell>` come from the same
 * definitions that parse.
 */
import { fileURLToPath } from "node:url";
import { GcConfigurationError } from "./shared/gc-error.ts";
import { gcComponent } from "./gc/component.ts";
import { dispatchComponent } from "./dispatch/component.ts";
import { runMain as dispatchRun } from "./dispatch/run.ts";
import type { Component } from "./runtime/component.ts";
import { runVerb, verbCommands } from "./runtime/verbs.ts";
import { runMain, ExitError } from "./shared/cli.ts";
import { USAGE_EXIT } from "./shared/command-line.ts";
import { map, message, or, runParser } from "./shared/vendor/optique.mjs";

/** The components, in the order the lifecycle verbs act on them. */
const COMPONENTS: readonly Component[] = [gcComponent, dispatchComponent];

const verbs = verbCommands(COMPONENTS.map((component) => component.name));

/** Each component's own command beside the verbs; `strict` takes a component's stricter parser. */
const programOf = (strict: boolean) =>
  or(
    verbs,
    ...COMPONENTS.map((component) =>
      map(
        strict
          ? (component.strictCommand ?? component.command)
          : component.command,
        (args) => ({ component: component.name, args }),
      ),
    ),
  );
const program = programOf(false);
// A component may hold the option that wins to more than the first parse
// does, so it is checked in a second one.
const strictProgram = programOf(true);

function reportError(error: unknown): never {
  if (error instanceof GcConfigurationError) {
    console.error(error.message);
    throw new ExitError(2, error.message);
  }
  if (error instanceof ExitError) console.error(error.message);
  throw error;
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
    brief: message`Jig's machine-level tools: resource collection and the dispatcher, and the commands that install, remove, report on and run them.`,
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
    componentNamed(parsed.component).strictArguments?.(parsed.args, argv) ??
    null
  );
}

function componentNamed(name: string): Component {
  return COMPONENTS.find((component) => component.name === name) as Component;
}

/** Runs a parsed command line: a lifecycle verb, or a component's own command. */
function execute(parsed: Parsed, script: string): Promise<number> {
  if ("verb" in parsed)
    return runVerb(parsed, {
      components: COMPONENTS,
      script,
      run: (argv) => execute(parseCommandLine(argv), script),
    });
  return componentNamed(parsed.component).main(parsed.args, script);
}

export async function main(argv: string[]): Promise<number> {
  const script = fileURLToPath(import.meta.url);
  // The wrapper a dispatched pass's terminal runs (dispatch/run.ts), its
  // arguments passed on as they are.
  if (argv[0] === "dispatch" && argv[1] === "run")
    try {
      return await dispatchRun(argv.slice(2));
    } catch (error) {
      reportError(error);
    }
  const parsed = parseCommandLine(argv);
  const strict = strictArgv(parsed, argv);
  if (strict !== null) parseCommandLine(strict, strictProgram);
  try {
    return await execute(parsed, script);
  } catch (error) {
    reportError(error);
  }
}
if (import.meta.main) runMain("jig", () => main(process.argv.slice(2)));
