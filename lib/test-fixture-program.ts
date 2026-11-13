/** Only an explicit, empty startup configuration can precede the fixture bootstrap. */
import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { swallow } from "../plugin/shared/errors.ts";

const PRELOAD = resolve(import.meta.dir, "test-fixture-tracking.ts");
export type LaunchOptions = {
  cmd?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string | URL;
};
function actualRuntime(command: string, options: LaunchOptions): string | null {
  if (options.cwd instanceof URL) return null;
  if (options.env && options.env.PATH === undefined && !isAbsolute(command))
    return null;
  const path = (options.env ?? process.env).PATH;
  const found = isAbsolute(command)
    ? command
    : Bun.which(command, {
        ...(path ? { PATH: path } : {}),
        cwd: options.cwd ?? process.cwd(),
      });
  if (!found) return null;
  return realpathSync(found) === realpathSync(process.execPath)
    ? process.execPath
    : null;
}
function startupFlags(command: string[]): string[] | null {
  let index = 1;
  while (/^--(?:no-env-file|smol|config=.+)$/.test(command[index] ?? ""))
    index++;
  const entry = command[index];
  // Configured test preloads run before CLI preloads. Package/script runners
  // and shebang programs can also execute code before the bootstrap.
  if (!entry) return null;
  const evaluated = entry === "-e" || entry === "--eval";
  if (!evaluated && (entry.startsWith("-") || !/\.[cm]?[jt]sx?$/.test(entry)))
    return null;
  // Bun can interpret suffix flags as runtime options even after eval code.
  // Commands with any application arguments therefore remain opaque.
  if (command.length !== (evaluated ? index + 2 : index + 1)) return null;
  if (evaluated && command[index + 1]?.trimStart().startsWith("-")) return null;
  const flags = command.slice(1, index);
  return flags.includes("--no-env-file") ? flags : null;
}
function canonicalProgram(
  command: string[],
  flags: string[],
  options: LaunchOptions,
): string[] | null {
  const index = flags.length + 1;
  const entry = command[index];
  if (!entry) return null;
  if (entry === "-e" || entry === "--eval") return command;
  const cwd = typeof options.cwd === "string" ? options.cwd : process.cwd();
  const file = resolve(cwd, entry);
  if (!lstatSync(file).isFile()) return null;
  return command.map((argument, position) =>
    position === index ? file : argument,
  );
}
function readEmptyConfig(file: string): boolean {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 65536) return false;
    const buffer = Buffer.alloc(65537);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (length > 65536) return false;
    return (
      Object.keys(Bun.TOML.parse(buffer.subarray(0, length).toString("utf8")))
        .length === 0
    );
  } finally {
    closeSync(descriptor);
  }
}
function emptyConfig(flags: string[], options: LaunchOptions): string | null {
  const configs = flags.filter((flag) => flag.startsWith("--config="));
  if (configs.length !== 1) return null;
  const config = configs[0];
  if (!config) return null;
  const cwd = typeof options.cwd === "string" ? options.cwd : process.cwd();
  return readEmptyConfig(resolve(cwd, config.slice(9))) ? config : null;
}
/**
 * The original flags already disable environment files and select an empty
 * config. Copying that empty configuration preserves its behavior while a
 * unique read-only snapshot prevents a sibling changing startup before exec.
 * Explicit config suppresses the cwd and user configs in the pinned Bun.
 */
export function fixtureProgram(
  command: string[],
  options: LaunchOptions,
  registry: string,
): string[] | null {
  try {
    const executable = command[0];
    if (!executable) return null;
    const runtime = actualRuntime(executable, options);
    if (!runtime) return null;
    const env = options.env ?? process.env;
    if (
      Object.entries(env).some(
        ([name, value]) =>
          /^(?:BUN_OPTIONS|NODE_OPTIONS)$/i.test(name) && value?.trim(),
      )
    )
      return null;
    const flags = startupFlags(command);
    if (!flags) return null;
    const program = canonicalProgram(command, flags, options);
    if (!program) return null;
    const original = emptyConfig(flags, options);
    if (!original) return null;
    const directory = join(registry, "startup");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const snapshot = join(directory, `${randomUUID()}.toml`);
    writeFileSync(snapshot, "", { flag: "wx", mode: 0o400 });
    const configIndex = program.indexOf(original);
    return [
      runtime,
      "--preload",
      PRELOAD,
      ...program
        .slice(1)
        .map((arg, index) =>
          index + 1 === configIndex ? `--config=${snapshot}` : arg,
        ),
    ];
  } catch (error) {
    swallow(
      error,
      "fixture startup cannot be isolated without changing its behavior; descendants remain unknown",
    );
    return null;
  }
}
