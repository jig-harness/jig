import { describe, expect, it } from "bun:test";
import {
  attemptState,
  type RetryForge,
} from "../scripts/lib/driver/ci-attempts.ts";
import { retryWitness } from "../scripts/lib/driver/ci-retry-wait.ts";

const HEAD = "a".repeat(40);
const stateOf = () => {
  const state = attemptState();
  state.pending.set("run", { head: HEAD, run: 41, attempt: 1, polls: 0 });
  return state;
};
function forgeOf(
  observations: Array<{ attempt: number; completed: boolean } | null>,
): RetryForge {
  return {
    rerunnable: async () => [],
    retry: async () => ({ ok: false, detail: "not requested" }),
    observe: async () => observations.shift() ?? null,
  };
}

describe("retry replacement witness", () => {
  it("holds the original failed snapshot and pending retry, then requests fresh evidence after completion", async () => {
    const state = stateOf();
    const forge = forgeOf([
      { attempt: 1, completed: true },
      { attempt: 2, completed: false },
      { attempt: 2, completed: true },
    ]);
    expect(await retryWitness(HEAD, state, forge, 5)).toBe("waiting");
    expect(await retryWitness(HEAD, state, forge, 5)).toBe("waiting");
    expect(state.repairs.size).toBe(0);
    expect(await retryWitness(HEAD, state, forge, 5)).toBe("refresh");
    expect(await retryWitness(HEAD, state, forge, 5)).toBe("clear");
  });
  it("ends indeterminate after bounded unreadable or unchanged evidence", async () => {
    const state = stateOf();
    const forge = forgeOf([null, { attempt: 1, completed: true }, null]);
    expect(await retryWitness(HEAD, state, forge, 2)).toBe("waiting");
    expect(await retryWitness(HEAD, state, forge, 2)).toBe("waiting");
    expect(await retryWitness(HEAD, state, forge, 2)).toBe("expired");
    expect(state.repairs.size).toBe(0);
  });
  it("does not hold another head and retains the witness if the old head returns", async () => {
    const state = stateOf();
    const forge = forgeOf([null]);
    expect(await retryWitness("b".repeat(40), state, forge, 2)).toBe("clear");
    expect(await retryWitness(HEAD, state, forge, 2)).toBe("waiting");
  });
});
