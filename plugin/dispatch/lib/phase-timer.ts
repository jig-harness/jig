/**
 * A tick's clock for its phases: how many milliseconds each one took, and
 * which one is running, so a defect can say the phase it was thrown in.
 */
export class PhaseTimer<P extends string> {
  /** Milliseconds per phase; a phase run more than once adds up. */
  readonly ms: Partial<Record<P, number>> = {};
  /** The phase running now; after a throw, the phase it was thrown in. */
  current: P | null = null;

  /** Run `run` as `phase`, adding the time it took, whether it returns or throws. */
  async time<T>(phase: P, run: () => T | Promise<T>): Promise<T> {
    const started = performance.now();
    this.current = phase;
    try {
      const value = await run();
      this.current = null;
      return value;
    } finally {
      this.ms[phase] =
        (this.ms[phase] ?? 0) + Math.round(performance.now() - started);
    }
  }
}
