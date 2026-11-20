import { type LabelTransition, mutationProven } from "./ci-hold.ts";
import { fail } from "./cli.ts";
import {
  type HoldReadFailure,
  readPrSnapshot,
  transitionAfter,
  valueOrNull,
  writeCiState,
} from "./ci-hold-state.ts";
import type { CiHoldState } from "./state/schema.ts";

type ReleasingState = Extract<CiHoldState, { phase: "releasing" }>;
type Snapshot = { state: string; head: string; held: boolean };
type Mutation = { event: LabelTransition; intervening: boolean } | null;

function provenAtHead(
  mutation: LabelTransition | null,
  head: string,
  snapshot: Snapshot | null,
  held: boolean,
): boolean {
  return (
    snapshot?.state === "OPEN" &&
    snapshot.head === head &&
    snapshot.held === held &&
    mutation !== null
  );
}

function eventOf(mutation: Mutation): LabelTransition | null {
  return mutation?.event ?? null;
}

function isUnintervened(mutation: Mutation): boolean {
  return mutation?.intervening === false;
}

function transitionId(values: readonly LabelTransition[] | null): string {
  return values?.at(-1)?.id ?? "";
}

async function observedTransition(
  pr: string,
  label: string,
  before: readonly LabelTransition[] | null,
  beforeId: string,
  event: "labeled" | "unlabeled",
  login: string,
): Promise<Mutation> {
  if (before === null) return null;
  return valueOrNull(await transitionAfter(pr, label, beforeId, event, login));
}

async function restoreAfterRace(
  pr: string,
  head: string,
  login: string,
  label: string,
  transitions: () => Promise<readonly LabelTransition[] | null>,
  mutate: (args: string[]) => Promise<{ code: number }>,
): Promise<void> {
  const before = await transitions();
  const restore = await mutate(["pr", "edit", pr, "--add-label", label]);
  const mutation = await observedTransition(
    pr,
    label,
    before,
    transitionId(before),
    "labeled",
    login,
  );
  const live = await readPrSnapshot(pr, label);
  await writeCiState(pr, null);
  const proven = mutationProven(
    restore.code,
    eventOf(mutation),
    provenAtHead(eventOf(mutation), head, live.ok ? live.value : null, true) &&
      isUnintervened(mutation),
  );
  if (!proven)
    fail(
      1,
      `ci-hold: ownership changed during removal; add-label exited ${restore.code} and restoration could not be proven from the timeline and live label, so reconcile '${label}' manually`,
    );
}

async function refuseRace(
  pr: string,
  head: string,
  login: string,
  label: string,
  live: Awaited<ReturnType<typeof readPrSnapshot>>,
  transitions: () => Promise<readonly LabelTransition[] | null>,
  mutate: (args: string[]) => Promise<{ code: number }>,
): Promise<number> {
  if (
    live.ok &&
    live.value.state === "OPEN" &&
    live.value.head === head &&
    !live.value.held
  )
    await restoreAfterRace(pr, head, login, label, transitions, mutate);
  else await writeCiState(pr, null);
  console.error(
    "ci-hold: ownership changed during removal; preserved the live label state and refused the release",
  );
  return 4;
}

export async function releaseHeldLabel(
  pr: string,
  head: string,
  persisted: ReleasingState,
  login: string,
  label: string,
  transitions: () => Promise<readonly LabelTransition[] | null>,
  mutate: (args: string[]) => Promise<{ code: number }>,
  unread: (failure: HoldReadFailure) => number,
): Promise<number> {
  const remove = await mutate(["pr", "edit", pr, "--remove-label", label]);
  const proof = await transitionAfter(
    pr,
    label,
    persisted.heldEventId,
    "unlabeled",
    login,
  );
  if (remove.code === 0 && !proof.ok) {
    process.stdout.write("release-proof-pending\n");
    return unread(proof.failure);
  }
  if (!proof.ok) return unread(proof.failure);
  const mutation = valueOrNull(proof);
  const confirmed = await readPrSnapshot(pr, label);
  if (!confirmed.ok) return unread(confirmed.failure);
  if (mutation?.intervening === true)
    return refuseRace(pr, head, login, label, confirmed, transitions, mutate);
  const event = eventOf(mutation);
  if (
    !mutationProven(
      remove.code,
      event,
      provenAtHead(event, head, confirmed.value, false) &&
        isUnintervened(mutation),
    )
  )
    fail(
      1,
      `ci-hold: remove-label exited ${remove.code}, and the unlabeled transition could not be proven on the unchanged open head`,
    );
  if (mutation === null) fail(1, "ci-hold: unlabeled transition disappeared");
  await writeCiState(pr, {
    phase: "released",
    eventId: mutation.event.id,
    head,
    actor: mutation.event.actor,
    createdAt: mutation.event.createdAt,
    checkRunWatermark: persisted.checkRunWatermark,
    source: "drive",
  });
  process.stdout.write("removed\n");
  return 0;
}
