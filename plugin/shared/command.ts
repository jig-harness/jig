/** Shell-independent argv execution with file input and bounded child lifetime. */
import { readFileSync, writeFileSync } from "node:fs";
import { fail, runMain } from "./cli.ts";
import { run } from "./proc.ts";

const USAGE =
  "Usage: command.ts [--stdin-file <file>] [--stdout-file <file>] [--cwd <dir>] [--timeout-seconds <seconds>] [--env <name> <value>] [--unset-prefix <prefix>] -- <program> <argument>...";

interface Options {
  input?: string;
  output?: string;
  cwd?: string;
  timeoutSec: number;
  env: Record<string, string | undefined>;
}

function deadline(value: string): number {
  const seconds = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    seconds > 2_147_483
  )
    fail(2, "Deadline must be positive whole seconds, at most 2147483", USAGE);
  return seconds;
}

function setEnvironment(
  env: Options["env"],
  name: string,
  setting: string | undefined,
): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || setting === undefined)
    fail(2, "--env needs a name and value", USAGE);
  if (process.platform === "win32") {
    for (const key of Object.keys(env))
      if (key.toUpperCase() === name.toUpperCase()) delete env[key];
  }
  env[name] = setting;
}

function unsetPrefix(env: Options["env"], prefix: string): void {
  if (!prefix) fail(2, "--unset-prefix needs a nonempty prefix", USAGE);
  const comparable = (value: string) =>
    process.platform === "win32" ? value.toUpperCase() : value;
  for (const key of Object.keys(env))
    if (comparable(key).startsWith(comparable(prefix))) delete env[key];
}

function applyOption(option: string, value: string, options: Options): void {
  switch (option) {
    case "--input":
    case "--stdin-file":
      options.input = value;
      break;
    case "--output":
    case "--stdout-file":
      options.output = value;
      break;
    case "--cwd":
      options.cwd = value;
      break;
    case "--timeout-seconds":
      options.timeoutSec = deadline(value);
      break;
    case "--unset-prefix":
      unsetPrefix(options.env, value);
      break;
    default:
      fail(2, `Unknown option ${option}`, USAGE);
  }
}

function invocation(argv: string[]): { options: Options; command: string[] } {
  const options: Options = { timeoutSec: 120, env: { ...process.env } };
  let index = 0;
  while (argv[index]?.startsWith("--") && argv[index] !== "--") {
    const option = argv[index++] as string;
    const value = argv[index++];
    if (value === undefined) fail(2, `Missing value for ${option}`, USAGE);
    if (option === "--env") setEnvironment(options.env, value, argv[index++]);
    else applyOption(option, value, options);
  }
  // Bun consumes a separator immediately after the script path. With wrapper
  // options before it the separator remains; both forms name the same argv.
  if (argv[index] === "--") index++;
  const program = argv[index];
  if (!program) fail(2, USAGE);
  return {
    options,
    command: [
      program === "bun" ? process.execPath : program,
      ...argv.slice(index + 1),
    ],
  };
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(USAGE);
    return 0;
  }
  const { options, command } = invocation(argv);
  const { input, output, cwd, timeoutSec, env } = options;
  const result = await run(command, {
    timeoutSec,
    env,
    ...(cwd === undefined ? {} : { cwd }),
    ...(input === undefined ? {} : { stdin: readFileSync(input, "utf8") }),
  });
  if (output === undefined) process.stdout.write(result.stdout);
  else if (result.code === 0) writeFileSync(output, result.stdout);
  process.stderr.write(result.stderr);
  return result.code;
}

if (import.meta.main) runMain("command.ts", () => main(process.argv.slice(2)));
