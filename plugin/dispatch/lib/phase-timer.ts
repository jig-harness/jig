/**
 * A tick's clock for its phases: how many milliseconds each one took, and
 * which one is running, so a defect can say the phase it was thrown in.
 * Phases may overlap (a repository's tracker and forge are read at once):
 * each keeps its own time, and the first one that throws is the one a
 * defect names.
 */
export class PhaseTimer<P extends string> {
  /** Milliseconds per phase; a phase run more than once adds up. */
  readonly ms: Partial<Record<P, number>> = {};
  private readonly running: P[] = [];
  private thrown: P | null = null;

  /** The phase running now, the latest of those that overlap; after a throw, the first phase that threw. */
  get current(): P | null {
    return this.thrown ?? this.running.at(-1) ?? null;
  }

  /**
   * The phase a throw a boundary caught came from, forgotten, so the turn
   * goes on and the next defect names its own phase; `null` when nothing
   * was thrown.
   */
  caught(): P | null {
    const phase = this.thrown;
    this.thrown = null;
    return phase;
  }

  /** Run `run` as `phase`, adding the time it took, whether it returns or throws. */
  async time<T>(phase: P, run: () => T | Promise<T>): Promise<T> {
    const started = performance.now();
    this.running.push(phase);
    try {
      return await run();
    } catch (error) {
      this.thrown ??= phase;
      throw error;
    } finally {
      this.running.splice(this.running.lastIndexOf(phase), 1);
      this.ms[phase] =
        (this.ms[phase] ?? 0) + Math.round(performance.now() - started);
    }
  }
}

/**
 * Await every promise, then return their values, or throw the first
 * rejection in time: a phase run beside another never outlives the step
 * that started both, and the error thrown is the one `PhaseTimer` named the
 * phase of.
 */
export async function settled<T extends readonly unknown[]>(
  ...promises: { [K in keyof T]: Promise<T[K]> }
): Promise<T> {
  // The first promise to reject, in time: each one's own handler runs before any reaction added later.
  let first: Promise<unknown> | null = null;
  for (const p of promises)
    p.then(undefined, () => {
      first ??= p;
    });
  const results = await Promise.allSettled(promises);
  // Awaiting the first rejected promise raises its rejection again, unchanged.
  if (first !== null) await first;
  return results.map(
    (r) => (r as PromiseFulfilledResult<unknown>).value,
  ) as unknown as T;
}
