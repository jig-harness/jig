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
 * for the writer to report, never thrown, and the next tick corrects the
 * labels. Nothing here checks for or creates a label: that is the one-time
 * label setup's.
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
  /** The pull request's label names. */
  labels(pr: number): Promise<Outcome<string[]>>;
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
}

const describe = (add: readonly string[], remove: readonly string[]): string =>
  [...add.map((l) => `+${l}`), ...remove.map((l) => `-${l}`)].join(" ");

const thrown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
  let read: Outcome<string[]>;
  try {
    read = await forge.labels(pr);
  } catch (error) {
    return { outcome: "refused", detail: thrown(error) };
  }
  if (!read.ok) return { outcome: "refused", detail: read.failure.reason };
  const labels = read.value;
  if (writer === "drive") {
    const stood = standsDown(config, labels);
    if (stood !== null) return { outcome: "held", detail: stood };
  }
  const change = labelChange(config, pr, labels, projected, writer === "drive");
  if (change === null) return { outcome: "agrees" };
  let edited: Outcome<void>;
  try {
    edited = await forge.edit(pr, change.add, change.remove);
  } catch (error) {
    return { outcome: "refused", detail: thrown(error) };
  }
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
      return null;
    case "written":
      return `PR #${pr}'s state label written: ${write.detail}`;
    case "held":
      return `PR #${pr}'s labels are left as they are: ${write.detail}`;
    case "kept":
      return null;
    case "refused":
      return `PR #${pr}'s state label could not be written (${write.detail}); the dispatcher's next tick corrects it`;
  }
}
