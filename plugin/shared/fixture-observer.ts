/** Bounded Jig ownership probes inspect membership without becoming fixture workload. */
const key = Symbol.for("jig.fixture-observer");
const globals = globalThis as typeof globalThis & {
  [key: symbol]: { depth: number } | undefined;
};
const state = globals[key] ?? { depth: 0 };
globals[key] = state;

export function fixtureObserverActive(): boolean {
  return state.depth !== 0;
}

/** Keep the exemption synchronous: unrelated launches during an awaited probe still register. */
export function fixtureObserver<T>(spawn: () => T): T {
  state.depth++;
  try {
    return spawn();
  } finally {
    state.depth--;
  }
}
