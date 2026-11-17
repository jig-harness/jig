/**
 * The follow-up's core arms: the classes of obligation a merge can leave
 * behind that every repository's follow-up checks, in the order the pass
 * works through them. Each ends with one verdict (`verdicts.ts`). A
 * repository turns one off with `followup.off`; an arm that does not apply
 * to a run's facts (the release arm where the repository keeps no
 * changelog, the workspace board outside Orca or before the merge) is
 * skipped with its reason, so the report still names it.
 */
import { orcaCommand } from "../../../../shared/orca.ts";
import type { RepoArm } from "./repo-arms.ts";

/** One core arm. */
export interface Arm {
  /** The id `record` and `followup.off` name it by. */
  id: string;
  /** What it settles, as the report names it. */
  title: string;
}

export const CORE_ARMS = [
  { id: "tracker", title: "The tracker item and its epic" },
  { id: "deferred-findings", title: "Deferred review findings" },
  { id: "out-of-tree", title: "Out-of-tree steps" },
  { id: "release", title: "The release and its tags" },
  { id: "scaffolding", title: "Scaffolding and live drivers" },
  { id: "live-verification", title: "Live verification" },
  { id: "next-step", title: "What comes next" },
  { id: "workspace-board", title: "The workspace board" },
] as const satisfies readonly Arm[];

export type ArmId = (typeof CORE_ARMS)[number]["id"];

export const ARM_IDS: readonly ArmId[] = CORE_ARMS.map((a) => a.id);

export function isArmId(value: string): value is ArmId {
  return (ARM_IDS as readonly string[]).includes(value);
}

/** The title of an arm: a core arm's, else the repository arm's in `plan`, else its id. */
export function armTitle(id: string, plan?: ArmPlan): string {
  return (
    CORE_ARMS.find((a) => a.id === id)?.title ??
    plan?.repository?.find((a) => a.id === id)?.title ??
    id
  );
}

/** The repository arm `id` of `plan`, when it is one. */
export function repoArmOf(plan: ArmPlan, id: string): RepoArm | undefined {
  return plan.repository?.find((a) => a.id === id);
}

/** What decides which arms apply to a run. */
export interface ArmContext {
  mode: "post-merge" | "preview";
  /** Whether the repository sets `changelog.file`. */
  changelog: boolean;
  /** Whether the session runs in a terminal Orca opened. */
  orca: boolean;
  /** `followup.off`. */
  off: readonly ArmId[];
}

/** An arm the run skips, with why. */
export interface SkippedArm {
  id: string;
  reason: string;
}

/** The arms a run settles (core and repository arms), in order, and the ones it skips. */
export interface ArmPlan {
  apply: string[];
  skipped: SkippedArm[];
  /** The repository's own arms (`followup.arms`), those it skips included. */
  repository?: RepoArm[];
}

/** Why `id` does not apply under `ctx`; `null` when it does. */
function skipReason(id: ArmId, ctx: ArmContext): string | null {
  if (ctx.off.includes(id))
    return "turned off by the repository (followup.off)";
  if (id === "release" && !ctx.changelog)
    return "the repository keeps no changelog (changelog.file is not set)";
  if (id === "workspace-board" && ctx.mode === "preview")
    return "a preview moves no card: the board shows the merge";
  if (id === "workspace-board" && !ctx.orca)
    return "the session does not run in Orca";
  return null;
}

/** The core arms that apply under `ctx`, minus the ones the repository turned off. */
export function planArms(ctx: ArmContext): ArmPlan {
  const plan: { apply: ArmId[]; skipped: SkippedArm[] } = {
    apply: [],
    skipped: [],
  };
  for (const { id } of CORE_ARMS) {
    const reason = skipReason(id, ctx);
    if (reason === null) plan.apply.push(id);
    else plan.skipped.push({ id, reason });
  }
  return plan;
}

/** Whether the session runs in a terminal Orca opened, as `shared/orca-board.ts` reads it. */
export function inOrca(env: Record<string, string | undefined>): boolean {
  return orcaCommand(env) !== null;
}
