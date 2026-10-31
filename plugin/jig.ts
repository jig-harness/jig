#!/usr/bin/env bun
/**
 * Installed command entry point: bun <plugin>/jig.ts gc|dispatch …
 *
 * Each component defines its command beside its code (`gc/cli.ts`,
 * `dispatch/cli.ts`); this file combines them into one Optique parser, so
 * `jig --help`, `jig help <command>`, `<command> --help` and
 * `jig completion <shell>` come from the same definitions that parse.
 */
import { fileURLToPath } from "node:url";
import { GcConfigurationError } from "./shared/gc-error.ts";
import { gcCommand, gcMain } from "./gc/cli.ts";
import { dispatchCommand, dispatchMain } from "./dispatch/cli.ts";
import { runMain as dispatchRun } from "./dispatch/run.ts";
import { runMain, ExitError } from "./shared/cli.ts";
import { USAGE_EXIT } from "./shared/command-line.ts";
import { map, message, or, runParser } from "./shared/vendor/optique.mjs";

const program = or(
  map(gcCommand, (gc) => ({ component: "gc" as const, gc })),
  map(dispatchCommand, (dispatch) => ({
    component: "dispatch" as const,
    dispatch,
  })),
);

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
export function parseCommandLine(argv: readonly string[]) {
  return runParser(program, "jig", argv, {
    brief: message`Jig's machine-level tools: resource collection and the dispatcher.`,
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
  try {
    return parsed.component === "gc"
      ? await gcMain(parsed.gc, script)
      : await dispatchMain(parsed.dispatch, script);
  } catch (error) {
    reportError(error);
  }
}
if (import.meta.main) runMain("jig", () => main(process.argv.slice(2)));
