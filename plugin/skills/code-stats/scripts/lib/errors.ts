/** A code-stats failure with a message for the person running it (exit 1). */
export class CodeStatsError extends Error {}

/**
 * A tracked file the file system refuses to read. Every mode needs every
 * tracked file (to count it, or to know what its configuration claims), so
 * the run stops and names the file rather than leaving it out.
 */
export function unreadableFile(path: string, error: unknown): CodeStatsError {
  const code = (error as NodeJS.ErrnoException).code ?? "an I/O error";
  return new CodeStatsError(`cannot read ${path} (${code})`, { cause: error });
}

/** A command line the script cannot act on (exit 2). */
export class UsageError extends Error {}
