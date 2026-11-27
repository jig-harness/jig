/**
 * Hold what the process writes to standard error until `flush`, whichever way
 * it is written (`console.error` and the shared logger both end in
 * `process.stderr.write`). `restore` stops holding; held text stays for `flush`.
 */
export function holdStderr(active: boolean): {
  flush: () => void;
  during: <T>(run: () => Promise<T>) => Promise<T>;
} {
  const write = process.stderr.write.bind(process.stderr);
  const held: string[] = [];
  if (active) {
    process.stderr.write = ((chunk: string | Uint8Array) => {
      held.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stderr.write;
  }
  const flush = () => {
    for (const chunk of held.splice(0)) write(chunk);
  };
  return {
    flush,
    /** Run with the hold on; it ends with the run, and a thrown run flushes first. */
    during: async (run) => {
      try {
        return await run();
      } catch (error) {
        process.stderr.write = write;
        flush();
        throw error;
      } finally {
        process.stderr.write = write;
      }
    },
  };
}
