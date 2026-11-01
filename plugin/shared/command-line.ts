/**
 * What the parsers of the `jig` command's components share. The command line
 * is parsed with Optique, vendored beside this file (`vendor/optique.mjs`,
 * built by `tools/plugin/vendor-optique.ts`): each component defines its
 * command next to its code, and `jig.ts` combines them and runs the parse.
 */
import { resolve } from "node:path";
import { message, type ValueParser } from "./vendor/optique.mjs";

/** The exit code of a command line the parser refuses. */
export const USAGE_EXIT = 2;

/**
 * A directory, resolved against the working directory. An option name in its
 * place (`--repo --json`), or an empty string, is a value left out, never a path.
 */
export const pathValue: ValueParser<"sync", string> = {
  mode: "sync",
  metavar: "PATH",
  placeholder: "",
  parse: (input) =>
    input.length === 0 || input.startsWith("--")
      ? {
          success: false,
          error: message`Expected a path, but got ${input === "" ? "nothing" : "the option " + input}.`,
        }
      : { success: true, value: resolve(input) },
  format: (value) => value,
};
