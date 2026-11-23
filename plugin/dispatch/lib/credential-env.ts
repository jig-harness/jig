/**
 * The environment a provider account's credential command runs with
 * (`credential_env`): a small base the command needs to find its own files
 * (`PATH`, the home, the user, the locale, the temporary directory) and the
 * variables the machine file names for it, such as a vault's session or
 * service-account token, read from the host's environment.
 *
 * The tick's check before a launch and the launch's wrapper both build it
 * with this one function, so the command sees the same variables in both.
 * Under `runtime: process` the runtime hands the named variables to the
 * wrapper of a provider account's launch, and to nothing else. No pass ever
 * carries them: every stage environment removes them
 * (`withholdFromPasses`, `provider-environment.ts`).
 */
import { ok } from "../../shared/outcome.ts";
import type { MachineConfig } from "./machine-config.ts";
import { type Checked, invalid } from "./machine-values.ts";

/** The variables every credential command gets from the host, beside the ones `credential_env` names. */
const BASE = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR"];
/** Windows' own names for the system and home directories. */
const WINDOWS_BASE = ["SYSTEMROOT", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];

/** Whether `name` is one the base already carries, which `credential_env` may not take from a pass. */
function isBaseName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    BASE.includes(upper) ||
    WINDOWS_BASE.includes(upper) ||
    upper === "JIG_HOME" ||
    upper.startsWith("LC_")
  );
}

/**
 * `credential_env`: environment variable names, each once. A base name is
 * refused, since a pass needs it, and so is a name `process.env_keep`
 * keeps, since no pass may carry a credential command's variable.
 */
export function credentialEnvNames(
  value: unknown,
  envKeep: unknown,
): Checked<string[]> {
  if (value === undefined || value === null) return ok([]);
  if (
    !Array.isArray(value) ||
    value.some(
      (name) =>
        typeof name !== "string" || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name),
    )
  )
    return invalid("credential_env must list environment variable names");
  const names = value as string[];
  const base = names.find(isBaseName);
  if (base !== undefined)
    return invalid(
      `credential_env cannot name ${base}: every credential command already gets it, and a pass needs it`,
    );
  const kept = new Set(
    (Array.isArray(envKeep) ? envKeep : [])
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.toUpperCase()),
  );
  const shared = names.find((name) => kept.has(name.toUpperCase()));
  if (shared !== undefined)
    return invalid(
      `credential_env names ${shared}, which process.env_keep keeps for every pass; a credential command's variable reaches no pass, so remove it from process.env_keep`,
    );
  return ok([...new Set(names)]);
}

/** The values of `names` in `source`, matched whatever their letter case. */
export function namedVariables(
  source: Record<string, string | undefined>,
  names: readonly string[],
): Record<string, string> {
  const wanted = new Set(names.map((name) => name.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source))
    if (value !== undefined && wanted.has(name.toUpperCase()))
      out[name] = value;
  return out;
}

/**
 * The environment a credential command runs with: the base and the
 * `credential_env` names from `source`, the host's environment. `path` is
 * the `PATH` the machine file sets for the process runtime, which the
 * wrapper there runs under, so the tick resolves with it too.
 */
export function credentialEnvironment(
  source: Record<string, string | undefined>,
  names: readonly string[],
  path?: string,
): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(source).filter(
      ([name, value]) => value !== undefined && isBaseName(name),
    ),
  ) as Record<string, string>;
  const env = { ...base, ...namedVariables(source, names) };
  if (path !== undefined) {
    for (const name of Object.keys(env))
      if (name.toUpperCase() === "PATH") delete env[name];
    env.PATH = path;
  }
  return env;
}

/** The credential command's environment on this host, from `source` (the resolving process's own): the same in the tick and in a launch's wrapper. */
export function credentialEnvOf(
  machine: Pick<MachineConfig, "credentials" | "runtime" | "process">,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return credentialEnvironment(
    source,
    machine.credentials?.credentialEnv ?? [],
    machine.runtime === "process" ? machine.process?.path : undefined,
  );
}
