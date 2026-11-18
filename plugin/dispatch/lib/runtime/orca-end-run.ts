/**
 * The session runtime on Orca, for a run the tick found ended (`endRun`),
 * whose wrapper may have died before closing its tab: the run tabs recorded
 * for its launch record
 * (`shared/orca-tabs.ts`) are closed by the same idle checks the wrapper's
 * closer makes, through the runtime's own Orca command. A tab whose shell
 * has a child process stays, as does one whose shell is gone or was reused;
 * `jig gc`'s `orca-terminals` kind collects what stays once it is idle past
 * its guard. A run with no recorded tab (one whose wrapper closed it, a
 * launch an earlier release recorded, a reservation cancelled before its tab
 * opened) leaves nothing to end.
 */
import {
  closeLaunchTabs,
  defaultRunTabDeps,
  outcomeText,
  type RunTabDeps,
} from "../../../shared/orca-tabs.ts";
import { failureText } from "../text.ts";
import { currentMs } from "../../../shared/time.ts";
import type { EndedRun, RuntimeReceipt } from "./port.ts";

/** Close the run tabs `run`'s launch record left, within `timeoutMs`. */
export async function orcaEndRun(
  run: EndedRun,
  orca: string,
  timeoutMs: number,
  deps: Pick<RunTabDeps, "root" | "orca" | "table"> = defaultRunTabDeps(),
): Promise<RuntimeReceipt> {
  let ended: Awaited<ReturnType<typeof closeLaunchTabs>>;
  try {
    ended = await closeLaunchTabs(run.id, orca, deps, currentMs() + timeoutMs);
  } catch (error) {
    return {
      ok: false,
      detail: `the run tabs of launch record ${run.id} did not read: ${failureText(error)}`,
    };
  }
  if (ended.length === 0)
    return { ok: true, nothingLeft: true, detail: "no run tab recorded" };
  const left = ended.filter(
    (e) => e.outcome !== "closed" && e.outcome !== "gone",
  );
  return {
    ok: left.length === 0,
    detail: ended
      .map(
        (e) =>
          `run tab ${e.tab.handle} (${e.tab.title}): ${outcomeText(e.outcome)}`,
      )
      .join("; "),
  };
}
