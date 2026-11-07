/**
 * The agent harness a script runs under, read from the variables the harness
 * and any wrapper around it set. `reflect` records it on a finding;
 * `do-item`'s route translates a model tier for it.
 */

export interface Harness {
  /** `claude-code`, `codex`, or `null` when only a wrapper is seen. */
  name: string | null;
  version: string | null;
  entrypoint: string | null;
  /** The program that started the harness: `herdr`, `conductor` or `orca`. */
  wrapper: string | null;
}

type Env = Record<string, string | undefined>;

/**
 * The harness, from the variables it sets: Claude Code sets `CLAUDECODE` and
 * `CLAUDE_CODE_ENTRYPOINT`; Codex sets variables named `CODEX_…`; a wrapper
 * that runs the harness adds its own (Herdr's `HERDR_ENV=1`, Conductor's
 * `CONDUCTOR_…`, Orca's `ORCA_…`). `null` when nothing identifies one.
 */
export function detectHarness(env: Env = process.env): Harness | null {
  const names = Object.keys(env);
  let name: string | null = null;
  if (env.CLAUDECODE !== undefined) name = "claude-code";
  else if (names.some((key) => key.startsWith("CODEX_"))) name = "codex";
  let wrapper: string | null = null;
  if (env.HERDR_ENV === "1") wrapper = "herdr";
  else if (names.some((key) => key.startsWith("CONDUCTOR_")))
    wrapper = "conductor";
  else if (names.some((key) => key.startsWith("ORCA_"))) wrapper = "orca";
  if (name === null && wrapper === null) return null;
  return {
    name,
    version: null,
    entrypoint: env.CLAUDE_CODE_ENTRYPOINT ?? null,
    wrapper,
  };
}
