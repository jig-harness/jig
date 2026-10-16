import { type ParseArgsConfig, parseArgs } from "node:util";

/**
 * `node:util`'s `parseArgs`, strict, with the usage line appended to its
 * error: an unknown option, a value missing after a flag or a stray
 * positional is then a usage error the `cli` boundary reports as exit 2.
 */
export function strictOptions<T extends ParseArgsConfig>(
  config: T,
  usage: string,
) {
  try {
    return parseArgs({ ...config, strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${usage}`);
  }
}

/** Command-line error boundary: invalid inputs must never look like a pass. */
export function cli(run: () => number | Promise<number>): void {
  Promise.resolve()
    .then(run)
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
}

/** Translate the POSIX character classes used by the former grep gates. */
export function ere(pattern: string, flags = ""): RegExp {
  const classes: Record<string, string> = {
    space: "\\s",
    blank: " \\t",
    digit: "0-9",
    alpha: "A-Za-z",
    alnum: "A-Za-z0-9",
    upper: "A-Z",
    lower: "a-z",
    xdigit: "A-Fa-f0-9",
    cntrl: "\\x00-\\x1f\\x7f",
    graph: "!-~",
    print: " -~",
    punct: "!-/:-@[-`{-~",
  };
  return new RegExp(
    pattern.replace(/\[:(\w+):\]/g, (_whole, name: string) => {
      if (!Object.hasOwn(classes, name))
        throw new Error(`unsupported POSIX character class: ${name}`);
      return classes[name] ?? "";
    }),
    flags,
  );
}
