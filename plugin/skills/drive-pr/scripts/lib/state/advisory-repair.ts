/** Charge a person's one-pass advisory repair before spawning, under the state lock. */
import { isRecord } from "../../../../../shared/guards.ts";
import { fail } from "../cli.ts";
import type { StateStore } from "./store.ts";

/** Exit 3 is already spent; a missing or changed authorization is refused. */
export async function claimAdvisoryRepair(
  store: StateStore,
  raw: string,
): Promise<number> {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return fail(2, "claim-advisory-repair needs {key,resolvedAt} JSON");
  }
  if (
    !isRecord(input) ||
    typeof input.key !== "string" ||
    !input.key.startsWith("ci-advisory-") ||
    typeof input.resolvedAt !== "string"
  )
    return fail(
      2,
      "claim-advisory-repair needs an advisory key and resolvedAt",
    );
  const { key, resolvedAt } = input;
  let result = 1;
  await store.update((s) => {
    const receipt = s.resolvedParks?.findLast((r) => r.key === key);
    if (
      receipt === undefined ||
      receipt.resolvedAt !== resolvedAt ||
      receipt.outcome !== "answered" ||
      receipt.kind !== "finding" ||
      receipt.class !== "reviewer-posture" ||
      receipt.answers.length === 0 ||
      !receipt.answers.every((a) => a.choice?.option === "fix")
    )
      return s;
    if (receipt.repairStartedAt !== undefined) {
      result = 3;
      return s;
    }
    result = 0;
    return {
      ...s,
      resolvedParks: (s.resolvedParks ?? []).map((r) =>
        r === receipt ? { ...r, repairStartedAt: new Date().toISOString() } : r,
      ),
    };
  });
  if (result === 1)
    console.error(
      "claim-advisory-repair: the answered fix receipt is missing or changed; no repair authorized",
    );
  return result;
}
