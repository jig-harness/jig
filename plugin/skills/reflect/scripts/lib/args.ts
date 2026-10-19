import { fail } from "../../../../shared/cli.ts";

/**
 * The reflection scripts' command lines: positional arguments, options that
 * take a value (repeatable), and flags that take none.
 */

export interface ParsedArgs {
  positional: string[];
  /** Every value each option was given, in order. */
  values: Map<string, string[]>;
  flags: Set<string>;
}

/**
 * Parse `args`; returns the reason when an option is unknown or lacks its
 * value, for the caller's usage message.
 */
export function parseArgs(
  args: readonly string[],
  options: readonly string[],
  flags: readonly string[] = [],
): ParsedArgs | string {
  const parsed: ParsedArgs = {
    positional: [],
    values: new Map(),
    flags: new Set(),
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const name = arg.startsWith("--") ? arg.slice(2) : null;
    if (name === null) parsed.positional.push(arg);
    else if (flags.includes(name)) parsed.flags.add(name);
    else if (!options.includes(name)) return `unknown option ${arg}`;
    else if (args[i + 1] === undefined) return `${arg} needs a value`;
    else {
      parsed.values.set(name, [
        ...(parsed.values.get(name) ?? []),
        args[i + 1] as string,
      ]);
      i++;
    }
  }
  return parsed;
}

/** The last value an option was given. */
export function last(parsed: ParsedArgs, name: string): string | undefined {
  return parsed.values.get(name)?.at(-1);
}

/** What an operation of a script accepts. */
export interface OperationShape {
  options?: string[];
  flags?: string[];
  /** How many positional arguments it takes (default none). */
  positional?: number;
}

/**
 * The operation `argv` names and its parsed arguments. Exits 2 with `usage`
 * for a missing or unknown operation, an unknown option, or the wrong number
 * of positional arguments.
 */
export function chooseOperation<T extends OperationShape>(
  argv: readonly string[],
  operations: Record<string, T>,
  usage: string,
): { name: string; operation: T; args: ParsedArgs } {
  const [name, ...rest] = argv;
  const operation = name === undefined ? undefined : operations[name];
  if (name === undefined || operation === undefined)
    fail(
      2,
      name === undefined ? "missing operation" : `unknown operation: ${name}`,
      usage,
    );
  const args = parseArgs(rest, operation.options ?? [], operation.flags);
  if (typeof args === "string") fail(2, args, usage);
  const wanted = operation.positional ?? 0;
  if (args.positional.length !== wanted)
    fail(
      2,
      `${name} takes ${wanted === 0 ? "no" : wanted} positional argument${wanted === 1 ? "" : "s"}`,
      usage,
    );
  return { name, operation, args };
}
