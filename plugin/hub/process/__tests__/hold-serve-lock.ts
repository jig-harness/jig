/**
 * A stand-in for a running resident hub: holds the single-instance lock
 * under `JIG_HOME` and prints `held`, until a terminate signal; with
 * `stubborn`, it ignores that signal and holds until killed.
 */
import { withServeLock } from "../instance.ts";

const stubborn = process.argv.includes("stubborn");
const ended = Promise.withResolvers<void>();
process.on("SIGTERM", () => {
  if (!stubborn) ended.resolve();
});
// A pending promise alone does not keep the process running.
const alive = setInterval(() => undefined, 1_000);
const held = await withServeLock(async () => {
  console.log("held");
  await ended.promise;
});
clearInterval(alive);
process.exit(held.ok && held.value !== null ? 0 : 3);
