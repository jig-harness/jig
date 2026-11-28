/**
 * A follow-up's own state label, written when it ends: `followed-up` when it
 * is done, `followup-failed` when it failed, through the shared projection
 * (`shared/pr-labels/`) the tick and the drive write with. Whoever ran it
 * writes it: the dispatcher's wrapper once it recorded the pass's exit
 * (`run.ts`), and a person's run through `jig dispatch marker done` or
 * `marker failed` (`marker.ts`).
 *
 * The setting is `dispatch.labels` on the repository's default branch, as
 * the tick reads it (`label-config.ts`). The write is best effort: its forge
 * calls run under `ghCall`'s deadline, the edit only when the labels
 * disagree, and a failure is one line the caller prints. A follow-up that is
 * run again, its marker released (a startup that never began, a first death,
 * a routine question), has not ended and writes nothing.
 */
import { failureText } from "./text.ts";
import { editLabels, pullRequestLabels } from "./forge.ts";
import { readEnded, type ReadRecord } from "./launches.ts";
import { outcomeOf } from "./followup-outcomes.ts";
import { routineEnd } from "./routine-reruns.ts";
import { waitEnd } from "./followup-waits.ts";
import { defaultBranchLabels } from "./label-config.ts";
import { ok } from "../../shared/outcome.ts";
import type { StateName } from "../../shared/pr-labels/projection.ts";
import type { TickOutcome } from "../../shared/records/followup-values.ts";
import {
  defectLine,
  type OwnForge,
  type OwnWrite,
  ownWriteLine,
  writeOwnState,
} from "../../shared/pr-labels/write.ts";

/** The forge of repository `slug`, through the dispatcher's own reads and writes. */
function followupForge(slug: string): OwnForge {
  return {
    labels: async (pr) => {
      const read = await pullRequestLabels(slug, pr);
      return read.ok ? ok({ labels: read.value }) : read;
    },
    edit: (pr, add, remove) => editLabels(slug, pr, add, remove),
  };
}

/** The state label each of a tick's outcomes (`shared/records/followup-values.ts`) ends its follow-up with. */
const END_STATE = {
  done: "followed-up",
  failed: "followup-failed",
} as const satisfies Readonly<Record<TickOutcome, StateName>>;

export interface FollowupEnd {
  slug: string;
  pr: number;
  outcome: TickOutcome;
  /** The repository's setting; by default its default branch's. */
  settings?: () => ReturnType<typeof defaultBranchLabels>;
  forge?: OwnForge;
}

/** What one follow-up label write did, and the line to print (`null` for nothing to say). */
export interface FollowupLabel {
  write:
    | OwnWrite
    | { outcome: "unreadable"; detail: string }
    | { outcome: "defect"; detail: string };
  line: string | null;
}

/** Write the follow-up's end as its state label. Never throws. */
export async function labelFollowupEnd(
  end: FollowupEnd,
): Promise<FollowupLabel> {
  try {
    const settings = await (
      end.settings ?? (() => defaultBranchLabels(process.cwd(), end.slug))
    )();
    if (!settings.ok) {
      const detail = settings.failure.reason;
      return {
        write: { outcome: "unreadable", detail },
        line: `PR #${end.pr}'s state label is not written: dispatch.labels does not read (${detail})`,
      };
    }
    const write = await writeOwnState({
      config: settings.value.config,
      pr: end.pr,
      projected: { state: END_STATE[end.outcome] },
      writer: "followup",
      forge: end.forge ?? followupForge(end.slug),
    });
    return { write, line: ownWriteLine(end.pr, write) };
  } catch (error) {
    return {
      write: { outcome: "defect", detail: failureText(error) },
      line: defectLine(`PR #${end.pr}`, error),
    };
  }
}

/** Whether a follow-up label write left nothing recorded that should have been: unread, refused, or a defect. */
export function labelFailed(label: FollowupLabel): boolean {
  const o = label.write.outcome;
  return o === "unreadable" || o === "refused" || o === "defect";
}

/** How an ended follow-up record ended, for its label: `null` while it holds, or when it runs again (a routine run again, or after a rate limit's reset). */
function followupEndOf(r: ReadRecord): TickOutcome | null {
  if (r.record.action !== "followup" || r.record.pr === null) return null;
  if (routineEnd(r) || waitEnd(r)) return null;
  return outcomeOf(r);
}

/**
 * A follow-up's end as its pull request's state label, now that its exit is
 * recorded: best effort, one line here when it is not written, and the next
 * tick corrects it; the wrapper's exit stays the stage's.
 */
export async function labelFollowupRun(id: string): Promise<void> {
  let line: string | null;
  let target = `the follow-up of launch record ${id}`;
  try {
    const ended = readEnded(id);
    const outcome = ended === null ? null : followupEndOf(ended);
    if (ended === null || outcome === null || ended.record.pr === null) return;
    target = `PR #${ended.record.pr}`;
    const label = await labelFollowupEnd({
      slug: ended.record.repo,
      pr: ended.record.pr,
      outcome,
    });
    line = label.line;
  } catch (error) {
    line = defectLine(target, error);
  }
  if (line !== null) console.error(`jig dispatch run: ${line}`);
}
