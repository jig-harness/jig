/**
 * What the script suites share: the scripts' directory, the fixture overlay
 * every spawned script reads as its consumer configuration, the environment
 * they spawn in, and a fake `linear` client.
 */

import { join } from "node:path";

export const SCRIPTS = join(import.meta.dir, "..", "scripts");
export const OVERLAY = join(import.meta.dir, "fixtures", "overlay.yaml");

// Every spawn goes through this env: git hook variables scrubbed, the
// fixture overlay as the consumer configuration, and no Linear API key, so
// the tracker uses the `linear` client the test puts on PATH.
export function gitCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || v === undefined) continue;
    if (k === "LINEAR_API_KEY" || k === "LINEAR_API_TOKEN") continue;
    env[k] = v;
  }
  env.JIG_OVERLAY = OVERLAY;
  return env;
}

/**
 * A fake `linear` client answering `linear api <document> --variables-json
 * <json>`. Each case names the GraphQL operation and the exact variables it
 * expects; any other invocation exits 3, so a request-shape regression turns
 * the suite red instead of the stub answering regardless.
 */
export function linearApiStub(
  cases: Array<{ operation: string; variables: string; payload: string }>,
): string {
  const branches = cases
    .map(
      (
        c,
        i,
      ) => `if [ "$1" = api ] && [ "$3" = --variables-json ] && [ '${c.variables}' = "$4" ]; then
  case "$2" in
    *"${c.operation}("*) cat <<'JSON_EOF_${i}'
${c.payload}
JSON_EOF_${i}
      exit 0 ;;
  esac
fi`,
    )
    .join("\n");
  return `#!/bin/sh
${branches}
echo "unexpected linear invocation: $*" >&2
exit 3
`;
}
