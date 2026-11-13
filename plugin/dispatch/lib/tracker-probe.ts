/**
 * The tracker preflight's child (`run.ts tracker <slug> <deadline-ms>`):
 * open the repository's tracker from the configuration the tick read, which
 * it is handed on its input, in the repository's checkout, and ask whether
 * the tracker answers for it (`Tracker.reach`, which reads no issue). The
 * tick runs it in the environment a pass billed to one account runs in
 * (`passEnvironment`), so the credential it reads is the one that pass
 * would read. It prints `{"ok":true}`, or `{"ok":false,"reason":…}` with
 * the tracker's own answer.
 */
import { isMapping } from "../../shared/config-layers.ts";
import { openTracker } from "../../skills/do-item/scripts/lib/tracker/index.ts";
import { trackerConfigOf } from "./section.ts";
import { failureText } from "./text.ts";
import type { TrackerAnswer } from "./preflight.ts";

/** The tracker's answer within `deadlineMs`, or why it gave none. */
export async function reachTracker(
  values: unknown,
  slug: string,
  root: string,
  deadlineMs: number,
): Promise<TrackerAnswer> {
  if (!isMapping(values))
    return {
      ok: false,
      reason: "the configuration handed to it is not a mapping",
    };
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new Error(
          `the tracker gave no answer within ${deadlineMs / 1000} seconds`,
        ),
      ),
    deadlineMs,
  );
  try {
    const tracker = openTracker(trackerConfigOf(values, slug), root);
    await Promise.race([
      tracker.reach(deadline.signal),
      new Promise<never>((_, reject) =>
        deadline.signal.addEventListener("abort", () =>
          reject(deadline.signal.reason),
        ),
      ),
    ]);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: failureText(error) };
  } finally {
    clearTimeout(timer);
  }
}
