/** A code-stats failure with a message for the person running it (exit 1). */
export class CodeStatsError extends Error {}

/** A command line the script cannot act on (exit 2). */
export class UsageError extends Error {}
