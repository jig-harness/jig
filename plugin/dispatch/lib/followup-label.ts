/**
 * A follow-up's own state label, written when it ends: `followed-up` when it
 * is done, `followup-failed` when it failed, through the shared projection
 * (`shared/pr-labels/`) the tick and the drive write with. Whoever ran it
 * writes it: the dispatcher's wrapper once it recorded the pass's exit
 * (`run.ts`), and a person's run through `jig dispatch marker done` or
 * `marker failed` (`marker.ts`).
 *
 * The setting is `dispatch.labels` in the configuration layers of the
 * checkout the command runs in. The write is best effort: two forge calls
 * under `ghCall`'s deadline, the second only when the labels disagree, and a
 * failure is one line the caller prints; the next tick corrects the labels.
 * A follow-up that is run again, its marker released (a startup that never
 * began, a first death, a routine question), has not ended and writes
 * nothing.
 */
import { failureText } from "./text.ts";
import { editLabels, pullRequestLabels } from "./forge.ts";
import type { ReadRecord } from "./launches.ts";
import { outcomeOf } from "./followup-outcomes.ts";
import { routineEnd } from "./routine-reruns.ts";
import type { Outcome } from "../../shared/outcome.ts";
import { readLabelConfig } from "../../shared/pr-labels/config.ts";
import type { LabelConfig } from "../../shared/pr-labels/projection.ts";
import {
  type OwnForge,
  ownWriteLine,
  writeOwnState,
} from "../../shared/pr-labels/write.ts";

/** The forge of repository `slug`, through the dispatcher's own reads and writes. */
function followupForge(slug: string): OwnForge {
  return {
    labels: (pr) => pullRequestLabels(slug, pr),
    edit: (pr, add, remove) => editLabels(slug, pr, add, remove),
  };
}

export interface FollowupEnd {
  slug: string;
  pr: number;
  outcome: "done" | "failed";
  /** `dispatch.labels`; by default the current checkout's layers. */
  config?: Outcome<LabelConfig>;
  forge?: OwnForge;
}

/** Write the follow-up's end as its state label; the line to print, or `null` when there is nothing to say. */
export async function labelFollowupEnd(
  end: FollowupEnd,
): Promise<string | null> {
  try {
    const config = end.config ?? readLabelConfig();
    if (!config.ok)
      return `PR #${end.pr}'s state label is not written: dispatch.labels does not read (${config.failure.reason})`;
    const written = await writeOwnState({
      config: config.value,
      pr: end.pr,
      projected: {
        state: end.outcome === "done" ? "followed-up" : "followup-failed",
      },
      writer: "followup",
      forge: end.forge ?? followupForge(end.slug),
    });
    return ownWriteLine(end.pr, written);
  } catch (error) {
    return `PR #${end.pr}'s state label could not be written (${failureText(error)}); the dispatcher's next tick corrects it`;
  }
}

/** How an ended follow-up record ended, for its label: `null` while it holds, or when it runs again. */
export function followupEndOf(r: ReadRecord): "done" | "failed" | null {
  if (r.record.action !== "followup" || r.record.pr === null) return null;
  if (routineEnd(r)) return null;
  return outcomeOf(r);
}
