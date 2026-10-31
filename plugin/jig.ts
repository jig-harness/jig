#!/usr/bin/env bun
/** Installed command entry point: bun <plugin>/jig.ts gc|dispatch … */
import { fileURLToPath } from "node:url";
import { GcConfigurationError } from "./shared/gc-error.ts";
import { gcMain as gc } from "./gc/cli.ts";
import { dispatchMain as dispatch } from "./dispatch/cli.ts";
import { runMain, ExitError } from "./shared/cli.ts";
function reportError(error: unknown): never {
  if (error instanceof GcConfigurationError) {
    console.error(error.message);
    throw new ExitError(2, error.message);
  }
  if (error instanceof ExitError) console.error(error.message);
  throw error;
}
export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "dispatch") return dispatch(argv.slice(1));
  if (argv[0] !== "gc")
    throw new ExitError(2, "Usage: jig gc|dispatch [--help]");
  try {
    return await gc(argv.slice(1), fileURLToPath(import.meta.url));
  } catch (error) {
    reportError(error);
  }
}
if (import.meta.main) runMain("jig", () => main(process.argv.slice(2)));
