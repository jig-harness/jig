import { writeState } from "./state-rows.ts";

export function createStatusConvergenceFixtures() {
  /**
   * Seed the drive-state store's `.rounds` counter directly, ahead of a
   * probe — the "last counted round" the stranded-check-run bypass (below)
   * compares the sticky's `ai-review-round` against. `probe` has no
   * fixture knob for it because only these tests need to control it; every
   * other test either accepts the fresh-state default (0)
   * or bumps it indirectly through a real round.
   */
  function seedRounds(stateDir: string, rounds: number) {
    writeState(stateDir, "999", {
      pr: 999,
      rounds,
      lastCountedHead: "",
      attempts: 0,
      attemptsHead: "",
      lastReflectedRound: 0,
      lastReflectedAttempts: 0,
      verifiedSha: "",
      phase: "",
      readyMarkedRound: 0,
      ciHold: null,
      parked: [],
      held: [],
      lastEscalatedRound: 0,
      lastEscalatedInvariant: "",
      roundPaths: [],
      lastProgressAt: "",
      quotaPark: null,
    });
  }
  return { seedRounds };
}
