/**
 * The drive-exits chapter's held-restatement and code-binding check.
 * The existing parser and its mutation suites remain beside drive-pr;
 * this entry point is run by the chapter gate and imported by those suites.
 */
import {
  closeTypeScriptService,
  runCheck,
} from "./terminal-states-consistency.ts";

/** The executable the mutation suite invokes through its process boundary. */
export const CHECKER_PATH = import.meta.path;

if (import.meta.main) {
  let status: number;
  try {
    status = await runCheck();
  } finally {
    await closeTypeScriptService();
  }
  process.exitCode = status;
}
