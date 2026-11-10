/**
 * A drive's or a follow-up's own state label write: the second trigger of
 * the projection (`projection.ts`), beside the dispatcher's tick, so a pull
 * request's state label is current as soon as the drive or the follow-up
 * changes it, wherever it runs.
 *
 * Each writer writes only the states it owns: a drive `driving`, `parked`
 * and `converged`; a follow-up `followed-up` and `followup-failed`. `stale`
 * and `held` depend on what only the dispatcher reads (the pull request's
 * head against its ledger, a serialized change area), so only its tick
 * writes them. A drive leaves a pull request carrying `hold` or `held` as
 * it is. The write is best effort: it reads the pull request's labels, and
 * writes in one forge call only when they disagree; a failure is returned
 * for the writer to report, and a dispatcher's next tick corrects the
 * labels where one runs. A throw from the forge calls is a defect, not a
 * refusal: it travels to the writer's boundary (`defectLine`). Nothing here
 * checks for or creates a label: that is the one-time label setup's.
 */
import type { Outcome } from "../outcome.ts";
import {
  hasCommand,
  type LabelConfig,
  labelChange,
  labelName,
  type Projected,
  type StateName,
} from "./projection.ts";

/** Who writes: the drive of an open pull request, or the follow-up of a merged one. */
export type OwnWriter = "drive" | "followup";

/** The states each writer may write. */
const OWNED: Record<OwnWriter, ReadonlySet<StateName>> = {
  drive: new Set(["driving", "parked", "converged"]),
  followup: new Set(["followed-up", "followup-failed"]),
};

/** The two forge calls a write makes, each under the writer's own deadline. */
export interface OwnForge {
  /** The pull request's label names, with its head commit where the read asks for it. */
  labels(pr: number): Promise<Outcome<{ labels: string[]; head?: string }>>;
  /** Add and remove labels on the pull request in one call. */
  edit(
    pr: number,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<Outcome<void>>;
}

/** What one own write did. */
export type OwnWrite =
  /** The labels are off: nothing was read or written. */
  | { outcome: "off" }
  /** Not a state this writer writes, or one it cannot tell: the labels are left as they are. */
  | { outcome: "kept"; detail: string }
  /** The pull request carries `hold` or `held`: a drive leaves it as it is. */
  | { outcome: "held"; detail: string }
  /** The pull request's head is not the one the drive verified: a converged drive leaves its labels. */
  | { outcome: "moved"; detail: string }
  /** The labels already show the state. */
  | { outcome: "agrees" }
  | { outcome: "written"; detail: string }
  /** The read or the write failed: the next tick corrects the labels. */
  | { outcome: "refused"; detail: string };

export interface OwnWriteInput {
  config: LabelConfig;
  pr: number;
  projected: Projected;
  writer: OwnWriter;
  forge: OwnForge;
  /** Write only while the pull request's head is this commit (a converged drive's verified head); otherwise leave the labels. */
  head?: string;
}

const describe = (add: readonly string[], remove: readonly string[]): string =>
  [...add.map((l) => `+${l}`), ...remove.map((l) => `-${l}`)].join(" ");

/** Write the state `projected` gives, when the writer owns it and the labels disagree. */
export async function writeOwnState(input: OwnWriteInput): Promise<OwnWrite> {
  const { config, pr, projected, writer, forge } = input;
  if (!config.enabled) return { outcome: "off" };
  if (
    projected === "unknown" ||
    projected.state === null ||
    !OWNED[writer].has(projected.state)
  )
    return {
      outcome: "kept",
      detail: `the ${writer} does not write ${projected === "unknown" || projected.state === null ? "this state" : labelName(config, projected.state)}; the dispatcher's tick does`,
    };
  const read = await forge.labels(pr);
  if (!read.ok) return { outcome: "refused", detail: read.failure.reason };
  const { labels, head } = read.value;
  if (writer === "drive") {
    const stood = standsDown(config, labels);
    if (stood !== null) return { outcome: "held", detail: stood };
  }
  if (input.head !== undefined && head !== input.head)
    return {
      outcome: "moved",
      detail: `its head ${head ?? "(unread)"} is not the head ${input.head} the drive verified, so ${labelName(config, "converged")} is not written`,
    };
  const change = labelChange(config, pr, labels, projected, writer === "drive");
  if (change === null) return { outcome: "agrees" };
  const edited = await forge.edit(pr, change.add, change.remove);
  return edited.ok
    ? { outcome: "written", detail: describe(change.add, change.remove) }
    : { outcome: "refused", detail: edited.failure.reason };
}

/** Why a drive leaves these labels as they are: a person's `hold`, or serialization's `held`; `null` when neither is there. */
function standsDown(
  config: LabelConfig,
  labels: readonly string[],
): string | null {
  if (hasCommand(config, labels, "hold"))
    return `it carries ${labelName(config, "hold")}`;
  const held = labelName(config, "held");
  return labels.includes(held) ? `it carries ${held}` : null;
}

/** The line a writer prints for one write; `null` when there is nothing to say (the labels off, or already agreeing). */
export function ownWriteLine(pr: number, write: OwnWrite): string | null {
  switch (write.outcome) {
    case "off":
    case "agrees":
    case "kept":
      return null;
    case "written":
      return `PR #${pr}'s state label written: ${write.detail}`;
    case "held":
    case "moved":
      return `PR #${pr}'s labels are left as they are: ${write.detail}`;
    case "refused":
      return `PR #${pr}'s state label could not be written (${write.detail}); ${REPAIR}`;
  }
}

/** What fixes a state label a writer could not write. */
export const REPAIR =
  "a dispatcher's next tick corrects it where one runs; otherwise `jig dispatch labels --yes` creates a missing label, or set it by hand";

/**
 * The line a writer's best-effort boundary prints for a defect, a throw
 * where the write returns its failures as values: the error's message, and
 * its stack for the person who fixes it.
 */
export function defectLine(target: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? `\n${error.stack}` : "";
  return `${target}'s state label was not written: a defect (${message})${stack}`;
}
