/**
 * `drive-state.ts set-reflected <PR>`: record a completed `/reflect` at the
 * current round, and print that round.
 *
 * Stamp "a /reflect happened at this point" inside one update, so the
 * reads of .rounds/.attempts and the writes of their baselines cannot
 * straddle a concurrent bump. Recording a POSITION rather than a boolean
 * is what lets the duty re-arm: reflectDepthPastLast measures forward
 * from here, so a drive that runs long enough past the last reflect owes
 * another one (SKILL.md § 3).
 *
 * BOTH counters are stamped because they are independent axes —
 * `reflectDepthPastLast` documents why one stamp cannot serve them.
 *
 * `lastEscalatedRound` is stamped HERE TOO, in the same update: a
 * `/reflect` is the step-back a structural escalation asks for, and the
 * deeper one — it names the class across PRs, where `set-escalated` only
 * records that this PR's recurrence was addressed. Leaving the escalation
 * armed after a reflect would make the very next round demand a second
 * step-back for a pattern that had just been examined, which is how an
 * advisory signal gets learned as noise and then ignored when it is real.
 * The reverse does NOT hold: `set-escalated` discharges only itself,
 * because a narrow "I generalized the fix" is not a reflect.
 *
 * `lastEscalatedInvariant` is CLEARED here too, not carried
 * forward: a `/reflect` is a step back from the whole class, not a
 * restatement of whatever one file's prior `set-escalated --invariant`
 * claimed. Leaving that text in place would let a later recurrence echo
 * a narrow sentence as if the reflect had re-examined and re-affirmed
 * it, when the reflect may never have touched that specific claim at
 * all.
 *
 * `roundPaths` is re-pruned in this SAME update against the NEW
 * `lastEscalatedRound` — see `pruneRoundPaths`'s own header for why
 * advancing the acknowledgment without doing so writes a state
 * `isUsableState` immediately rejects on the very next read.
 */
import { pruneRoundPaths } from "./schema.ts";
import type { StateStore } from "./store.ts";

export async function setReflected(store: StateStore): Promise<number> {
  await store.update((s) => {
    const lastEscalatedRound = s.rounds;
    return {
      ...s,
      lastEscalatedRound,
      lastEscalatedInvariant: "",
      lastReflectedRound: s.rounds,
      lastReflectedAttempts: s.attempts,
      roundPaths: pruneRoundPaths(s.roundPaths, lastEscalatedRound),
    };
  });
  process.stdout.write(`${store.read().state.lastReflectedRound}\n`);
  return 0;
}
