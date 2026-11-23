/** Environment shared by the process runtime's identity probe and wrapper. */
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  directoryVariables,
  type HarnessName,
  harnessFor,
} from "../../../shared/agent-harness/index.ts";
import { isMapping } from "../../../shared/config-layers.ts";
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";

export interface ProcessSettings {
  path?: string;
  envKeep: string[];
}

type Environment = Record<string, string | undefined>;

const BASE = ["HOME", "USER", "LANG", "TMPDIR", "JIG_HOME"];
/** Directory variables: a relative value would name another place once the launch changes to its workspace. */
const PLACES = new Set(["TMPDIR", "LOCK_ROOT"]);
const BLOCKED = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CLAUDECODE",
  "JIG_LAUNCH",
  "PATH",
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
]);

function blocked(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    BLOCKED.has(upper) ||
    directoryVariables().includes(upper) ||
    /^(CODEX_|LD_|DYLD_)/.test(upper)
  );
}

export function processSettings(
  value: unknown,
): Outcome<ProcessSettings, "invalid"> {
  const invalid = (reason: string) => failed("invalid", reason);
  if (value === undefined) return ok({ envKeep: [] });
  if (!isMapping(value)) return invalid("process must be a mapping");
  const unknown = Object.keys(value).find(
    (key) => key !== "path" && key !== "env_keep",
  );
  if (unknown !== undefined) return invalid(`process.${unknown} is unknown`);
  const path = value.path;
  if (
    path !== undefined &&
    (typeof path !== "string" ||
      /[\r\n\0]/.test(path) ||
      !path.split(delimiter).every(isAbsolute))
  )
    return invalid("process.path must contain only absolute directories");
  const keep = value.env_keep === undefined ? [] : value.env_keep;
  if (!Array.isArray(keep))
    return invalid("process.env_keep must list environment variable names");
  for (const name of keep) {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name))
      return invalid("process.env_keep must list environment variable names");
    if (blocked(name)) return invalid(`process.env_keep cannot keep ${name}`);
  }
  return ok({
    ...(path === undefined ? {} : { path }),
    envKeep: [...new Set(keep as string[])],
  });
}

/** A relative PATH entry would resolve inside the branch's checkout. */
function inheritedPath(path: string | undefined, fallback: string): string {
  const absolute = path?.split(delimiter).filter(isAbsolute).join(delimiter);
  return absolute || fallback;
}

/** Windows gives the home and system paths their own names. */
function nativeEnvironment(
  source: Environment,
  configuredPath: string | undefined,
): Record<string, string> {
  if (process.platform !== "win32")
    return {
      PATH: configuredPath ?? inheritedPath(source.PATH, "/usr/bin:/bin"),
    };
  const entries = new Map(
    Object.entries(source).map(([name, value]) => [name.toUpperCase(), value]),
  );
  const systemRoot = entries.get("SYSTEMROOT");
  const home = entries.get("HOME") ?? entries.get("USERPROFILE");
  return {
    ...(home === undefined ? {} : { HOME: home, USERPROFILE: home }),
    ...(systemRoot === undefined ? {} : { SystemRoot: systemRoot }),
    PATH:
      configuredPath ??
      inheritedPath(
        entries.get("PATH"),
        join(systemRoot ?? "C:\\Windows", "System32"),
      ),
  };
}

export function processEnvironment(
  source: Environment,
  settings: ProcessSettings,
  account: { vendor: HarnessName; configDir: string },
  launch?: string,
): Record<string, string> {
  const env: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(source))
    if (
      value !== undefined &&
      !blocked(name) &&
      (BASE.includes(name) ||
        name.startsWith("LC_") ||
        settings.envKeep.includes(name))
    )
      env[name] = PLACES.has(name) && value !== "" ? resolve(value) : value;
  Object.assign(env, nativeEnvironment(source, settings.path));
  env[harnessFor(account.vendor).environment.directoryVariable] =
    account.configDir;
  if (launch !== undefined) env.JIG_LAUNCH = launch;
  return env;
}
