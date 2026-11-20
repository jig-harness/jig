/**
 * A finding the drive itself parks for a person under `human-decision`, with
 * its framed decision: the cancelled-run recovery's `cancelled-ci` and the CI
 * hold's `missing-required-run`. One park per key; parking again replaces it.
 */
import type { ParkedDecision } from "../../../../../shared/decisions/park.ts";
import { currentIso } from "../../../../../shared/time.ts";
import { fail } from "../cli.ts";
import {
  parkAdmissionContext,
  parkAdmissionProblem,
} from "./park-admission.ts";
import { resolveParkPerson } from "./park-person.ts";
import { openStore } from "./store.ts";

/**
 * Park `key` with `decision`, its reason the decision's question. `fence`,
 * when given, runs inside the store's lock as the write is about to run and
 * throws to stop it.
 */
export async function parkFinding(
  pr: string,
  key: string,
  decision: ParkedDecision,
  fence?: () => Promise<void>,
): Promise<void> {
  const person = await resolveParkPerson(pr, key, "finding", "");
  const question = decision.call.question;
  const store = await openStore(pr);
  const capacity = await parkAdmissionContext(pr, store.stateDir);
  if (fence !== undefined) store.setFence(fence);
  await store.update((state) => {
    const next = {
      ...state,
      parked: [
        ...state.parked.filter((p) => p.key !== key),
        {
          key,
          kind: "finding" as const,
          reason: question,
          class: "human-decision",
          person,
          decision,
          round: state.rounds,
          at: currentIso(),
        },
      ],
    };
    const admission = parkAdmissionProblem(next, decision, capacity);
    if (admission !== null) fail(2, `park: ${admission}`);
    return next;
  });
}

/** Remove the parked finding `key`, when the drive holds one. */
export async function clearParkedFinding(
  pr: string,
  key: string,
): Promise<void> {
  const store = await openStore(pr);
  if (store.read().state.parked.some((p) => p.key === key))
    await store.update((state) => ({
      ...state,
      parked: state.parked.filter((p) => p.key !== key),
    }));
}
