/**
 * Where a portable module reports an error it drops on purpose.
 *
 * A module that runs on every platform (the hub's core, and the shared
 * modules it imports) cannot write to the machine's log, which reads the
 * process's environment and arguments. Where it drops an error because a
 * default is the right answer, it calls `dropped(err, reason)`, which hands
 * both to the reporter the platform installed: on a machine, `errors.ts`
 * installs `swallow` when it loads, so the error is written at debug level
 * as any other dropped error is; elsewhere the platform installs its own
 * reporter (the hub's observability port), and with none installed nothing
 * is written.
 */

/** Takes an error dropped on purpose and the reason carrying on is right. */
export type DropReporter = (err: unknown, reason: string) => void;

let reporter: DropReporter | null = null;

/** Install the platform's reporter for dropped errors; `null` removes it. */
export function reportDroppedWith(next: DropReporter | null): void {
  reporter = next;
}

/** Drop `err` deliberately: `reason` says why carrying on is right. */
export function dropped(err: unknown, reason: string): void {
  reporter?.(err, reason);
}
