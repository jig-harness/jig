/**
 * The machine file's keys for a checkout the workspace runtime does not list
 * that holds a launch's branch (`shared/orca-workspace/holder.ts`). An idle
 * one is always detached; these widen that, without asking a person:
 *
 * - `detach_idle_holders` (default `false`): also a holder no process,
 *   drive or session uses whose every commit is on the remote, busy only
 *   with changes in its tree or index, which the detach leaves where they
 *   are.
 * - `rescue_unpushed` (default `false`, read only with
 *   `detach_idle_holders` on): also a holder whose commits the remote lacks,
 *   once they are kept on a rescue branch of the clone that nothing pushes
 *   or collects.
 *
 * Off, such a holder refuses the launch and a person is asked, as before.
 */
import type { HolderPolicy } from "../../shared/orca-workspace/holder.ts";
import { ok } from "../../shared/outcome.ts";
import { type Checked, flag, invalid } from "./machine-values.ts";

/** The machine file's top-level keys this module reads. */
export const HOLDER_KEYS = ["detach_idle_holders", "rescue_unpushed"] as const;

/** The holder policy the machine file sets; `rescue_unpushed` without `detach_idle_holders` is refused, since it would do nothing. */
export function holderSettings(
  top: Record<string, unknown>,
): Checked<{ holders: HolderPolicy }> {
  const detachIdle = flag(
    top.detach_idle_holders,
    "detach_idle_holders",
    false,
  );
  if (!detachIdle.ok) return detachIdle;
  const rescueUnpushed = flag(top.rescue_unpushed, "rescue_unpushed", false);
  if (!rescueUnpushed.ok) return rescueUnpushed;
  if (rescueUnpushed.value && !detachIdle.value)
    return invalid(
      "rescue_unpushed: true needs detach_idle_holders: true, since only a holder the tick may detach has its commits rescued",
    );
  return ok({
    holders: {
      detachIdle: detachIdle.value,
      rescueUnpushed: rescueUnpushed.value,
    },
  });
}
