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
