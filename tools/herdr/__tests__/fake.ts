/**
 * The table-driven fake context (plugin/shared/__tests__/fake-context.ts),
 * with Herdr's answer envelopes beside it.
 */
import type { RunResult } from "../runner.ts";
import { ok } from "../../../plugin/shared/__tests__/fake-context.ts";

export * from "../../../plugin/shared/__tests__/fake-context.ts";

/** A Herdr success envelope. */
export const result = (value: unknown): RunResult =>
  ok(JSON.stringify({ result: value }));
/** A Herdr error envelope, which Herdr writes to stderr with exit 1. */
export const herdrError = (code: string, message = code): RunResult => ({
  status: 1,
  stdout: "",
  stderr: JSON.stringify({ error: { code, message } }),
});
