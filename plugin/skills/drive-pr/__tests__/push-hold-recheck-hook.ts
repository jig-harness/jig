/**
 * The pre-push hook entry a consumer repository wires `push-hold-recheck.ts`
 * in with (README § Push hold), as a shell script. The shell test skips before
 * `bun` starts when `guarded-push.ts` did not arm the push, so an ordinary
 * push pays nothing. The tests run this text the way a hook manager runs it,
 * so the documented wiring and the script's environment contract stay pinned
 * together.
 */
import { join } from "node:path";

const SCRIPTS = join(import.meta.dir, "..", "scripts");

export function recheckHookEntry(): string {
  return [
    '[ -z "${DRIVE_PR_HOLD_RECHECK_PR+x}" ] && exit 0',
    `bun "${join(SCRIPTS, "push-hold-recheck.ts")}"`,
  ].join("\n");
}
