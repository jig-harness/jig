/** The tick applies a previous steward pass's records after checking today's facts. */
import { parseTrackerLabels } from "../../shared/tracker-labels.ts";
import { factsOf } from "./actions/drive-hold.ts";
import { replayable, type ApplyState } from "./actions/launch.ts";
import { localRecoverySpent } from "./no-cause-stops.ts";
import { RECOVERY_FACTS, sameFacts } from "./recovery-facts.ts";
import { applyStewardFacet } from "./steward-facets.ts";
import { projectStewardNeed } from "./steward-needs.ts";
import { resumeSteward } from "./steward-resume.ts";
import {
  claimStewardRecord,
  markStewardEffect,
  readStewardDigest,
  recordBelongsToDigest,
  rearmableBySteward,
  releaseStewardRecord,
  stewardRecords,
  type KeptStewardRecord,
  type StewardDigest,
  type StewardRecord,
} from "./steward.ts";
import type { RepoObservation } from "./tick-observe.ts";
import type { Action, DrivenPr } from "./types.ts";

type Rearm = Extract<StewardRecord, { kind: "rearm" }>;
type Need = Extract<StewardRecord, { kind: "need" }>;
type Facet = Extract<StewardRecord, { kind: "facet" }>;

async function replayResumes(
  state: ApplyState,
  observation: RepoObservation,
  records: KeptStewardRecord[],
): Promise<void> {
  for (const pending of replayable(state, observation.opened.repo.slug, [
    "pickup",
    "followup",
  ])) {
    if (pending.stewardResume === undefined) continue;
    const witness = records.find(
      (r) =>
        r.applied &&
        r.effect === pending.id &&
        r.value.kind === "resume" &&
        r.value.record === pending.stewardResume,
    );
    if (witness?.value.kind === "resume")
      await resumeSteward(
        state,
        observation,
        witness.id,
        witness.value,
        pending,
      );
  }
}

function availableRecord(state: ApplyState, kept: KeptStewardRecord): boolean {
  if (!kept.applied) return true;
  if (kept.value.kind !== "rearm" || kept.effect !== null) return false;
  const launched = state.records.find(
    (r) => r.record.stewardDecision === kept.id,
  );
  if (launched) {
    markStewardEffect(kept.id, launched.record.id, state.root);
    return false;
  }
  releaseStewardRecord(kept.id, state.root);
  return true;
}

function applyNeed(
  state: ApplyState,
  observation: RepoObservation,
  kept: KeptStewardRecord,
  record: Need,
  digest: StewardDigest,
): void {
  const prior = digest.drives.find((p) => `PR #${p.number}` === record.target);
  const current = observation.forge.drives.find(
    (p) => `PR #${p.number}` === record.target,
  );
  if (prior && (!current || !sameFacts(factsOf(prior), factsOf(current))))
    return;
  projectStewardNeed(observation.opened.report.actions, record, digest.needs);
  if (!kept.applied) claimStewardRecord(kept.id, state.root);
}

async function applyFacet(
  state: ApplyState,
  observation: RepoObservation,
  kept: KeptStewardRecord,
  record: Facet,
  digest: StewardDigest,
): Promise<void> {
  const tracker = observation.tracked.tracker;
  if (tracker === null || !claimStewardRecord(kept.id, state.root)) return;
  const labels = parseTrackerLabels(observation.opened.values);
  const done = await applyStewardFacet(tracker, record, digest.queue, {
    hitl: labels.hitl,
    manualOps: labels.manualOps,
  });
  if (!done.ok) {
    releaseStewardRecord(kept.id, state.root);
    observation.opened.report.unplaced.push({
      record: "tracker",
      target: record.target,
      reason: done.failure.reason,
    });
  }
}

function duplicateRearm(
  records: KeptStewardRecord[],
  kept: KeptStewardRecord,
  record: Rearm,
): boolean {
  return records.some(
    (r) =>
      r.id !== kept.id &&
      ((r.applied && r.effect !== null && r.effect !== "refused") ||
        (!r.applied && r.id < kept.id)) &&
      r.value.kind === "rearm" &&
      r.value.target === record.target &&
      sameFacts(r.value.facts, record.facts),
  );
}

function applyRearm(
  state: ApplyState,
  observation: RepoObservation,
  kept: KeptStewardRecord,
  record: Rearm,
  digest: StewardDigest,
  records: KeptStewardRecord[],
): void {
  const pr = observation.forge.drives.find(
    (p) => `PR #${p.number}` === record.target,
  );
  const duplicate = duplicateRearm(records, kept, record);
  if (
    !pr ||
    duplicate ||
    !rearmableBySteward(pr, observation.held.has(pr.number)) ||
    !sameFacts(factsOf(pr), record.facts)
  ) {
    if (claimStewardRecord(kept.id, state.root))
      markStewardEffect(kept.id, "refused", state.root);
    return;
  }
  if (!String(pr.evidence.handoff ?? "").trim() && !digest.history?.length)
    return;
  const spent = localRecoverySpent(
    observation.opened.repo.slug,
    pr.number,
    state.records,
    Date.now(),
  );
  if (spent !== null) {
    observation.opened.report.unplaced.push({
      record: "forge",
      target: record.target,
      reason: `Investigate: ${spent}`,
    });
    return;
  }
  observation.opened.report.actions.push({
    stage: "rearm",
    target: record.target,
    record: "forge",
    reason: record.reason,
    evidence: pr.evidence,
    facts: `${RECOVERY_FACTS}${record.facts.replace(/^recovery: /, "")}`,
    steward: { id: kept.id, facts: record.facts },
  });
}

async function applyOne(
  state: ApplyState,
  observation: RepoObservation,
  kept: KeptStewardRecord,
  records: KeptStewardRecord[],
): Promise<void> {
  if (kept.value.kind === "order") return;
  const digest = readStewardDigest(kept.run, state.root);
  if (!digest.ok) {
    observation.opened.report.unplaced.push({
      record: "runtime",
      target: `steward run ${kept.run}`,
      reason: digest.failure.reason,
    });
    return;
  }
  if (!recordBelongsToDigest(kept.value, digest.value)) {
    if (claimStewardRecord(kept.id, state.root))
      markStewardEffect(kept.id, "refused", state.root);
    observation.opened.report.unplaced.push({
      record: "runtime",
      target: `steward record ${kept.id}`,
      reason: "the steward record names a target outside its own digest",
    });
    return;
  }
  if (kept.value.kind === "need")
    return applyNeed(state, observation, kept, kept.value, digest.value);
  if (!availableRecord(state, kept)) return;
  switch (kept.value.kind) {
    case "resume":
      return resumeSteward(state, observation, kept.id, kept.value);
    case "facet":
      return applyFacet(state, observation, kept, kept.value, digest.value);
    case "rearm":
      return applyRearm(
        state,
        observation,
        kept,
        kept.value,
        digest.value,
        records,
      );
  }
}

export async function applyStewardRecords(
  state: ApplyState,
  observation: RepoObservation,
): Promise<void> {
  const { opened } = observation;
  if (
    !opened.owner ||
    !opened.stages.has("steward") ||
    !state.machine.steward?.enabled
  )
    return;
  const records = stewardRecords(opened.repo.slug, state.root);
  await replayResumes(state, observation, records);
  for (const kept of records) await applyOne(state, observation, kept, records);
  opened.report.steward = {
    status: "previous records checked",
    records: records.length,
  };
}

/** Reclassification is local to this one checked action and cannot change a person's stop. */
export function stewardFresh(
  pr: DrivenPr | null,
  action: Pick<Action, "steward">,
  held: boolean,
): DrivenPr | null {
  if (
    !pr ||
    !action.steward ||
    !rearmableBySteward(pr, held) ||
    !sameFacts(factsOf(pr), action.steward.facts)
  )
    return pr;
  return {
    ...pr,
    class: "re-armable",
    evidence: { ...pr.evidence, rearm: true },
  };
}
