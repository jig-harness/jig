import { fail } from "../../../../shared/cli.ts";

/** A value-taking option must not consume past the argument list. */
export function argumentValue(
  argv: string[],
  flag: string,
  index: number,
): string {
  if (index + 1 >= argv.length) fail(2, `${flag} requires a value`);
  return argv[index + 1] ?? "";
}
