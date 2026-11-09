/** Configuration carried across a terminal whose login shell has its own environment. */
import { resolve } from "node:path";
import {
  ENV_PREFIX,
  LAYER_SELECTORS,
  PATH_LAYER_SELECTORS,
} from "./config-layers.ts";

type Env = Record<string, string | undefined>;

/**
 * What the tab's login shell runs first: it drops every `JIG__` field the
 * shell's own profile exported, so only the session's reach the drive, and
 * the Electron execution and crash controls an Orca terminal can inherit
 * from its host, which belong to that host and not to the session; then runs
 * the rest of the command line.
 */
export const DROP_LOGIN_FIELDS =
  'for n in $(env | sed -n \'s/^\\(JIG__[A-Za-z0-9_]*\\|ELECTRON_RUN_AS_NODE\\|ELECTRON_CRASH[A-Za-z0-9_]*\\|CHROME_CRASHPAD_PIPE_NAME\\)=.*/\\1/p\'); do unset "$n"; done; exec "$@"';

/**
 * The session's configuration as the prefix of the tab's command, so the
 * fresh login shell of a tab reads the configuration the arm resolved the
 * model and the options from, whatever its profile exports. The session's
 * `JIG__` field overrides and the variables that choose the layers
 * (`JIG_HOME`, `JIG_OVERLAY`, `JIG_USER_LAYER`) are carried as
 * `env KEY=value`; a blank selector stays blank, since the reader treats a
 * blank one as unset and the profile must not fill it. A path selector with a
 * value is made absolute against `cwd`, since the tab may start elsewhere. A
 * selector the session leaves unset is unset in the tab, and the `JIG__`
 * fields the profile exports are dropped first.
 */
export function sessionOverrides(
  env: Env,
  cwd: string = process.cwd(),
): string[] {
  const set: string[] = [];
  for (const [key, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (key.startsWith(ENV_PREFIX)) set.push(`${key}=${v}`);
    else if (LAYER_SELECTORS.includes(key))
      set.push(
        `${key}=${PATH_LAYER_SELECTORS.includes(key) && v.trim() !== "" ? resolve(cwd, v) : v}`,
      );
  }
  const unset = LAYER_SELECTORS.filter(
    (key) => typeof env[key] !== "string",
  ).flatMap((key) => ["-u", key]);
  return ["sh", "-c", DROP_LOGIN_FIELDS, "sh", "env", ...unset, ...set];
}
