/**
 * Orca's answers, as the code that opens a workspace reads them. Every Orca
 * command run with `--json` answers one envelope, `{ ok: true, result }` or
 * `{ ok: false, error: { code, message } }`, on standard output, with exit 1
 * on an error. An answer that is neither is a failure of the call, never
 * read as a result.
 */
import { swallow } from "../errors.ts";
import { isRecord } from "../guards.ts";
import { HerdrError } from "./runner.ts";

/** A workspace step that cannot go on; the message says why and what to do. */
export class OrcaError extends HerdrError {
  override name = "OrcaError";
}

/**
 * What a command answers: a result, or an error. Anything else that comes
 * back, `{ ok: false }` with no error or a result with no `ok`, is not an
 * answer this code acts on, so a malformed response never passes as a
 * success or as a named failure.
 */
export type OrcaEnvelope<T> =
  | { ok: true; result: T | undefined }
  | { ok: false; error: { code?: string; message?: string } };

/** The well-formed envelope in a command's output, or null when it holds none. */
export function parseOrcaEnvelope<T>(text: string): OrcaEnvelope<T> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    swallow(error, "orca output that starts like JSON but is not: no envelope");
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.ok === true) return { ok: true, result: parsed.result as T };
  if (parsed.ok === false && isRecord(parsed.error)) {
    const { code, message } = parsed.error;
    return {
      ok: false,
      error: {
        ...(typeof code === "string" ? { code } : {}),
        ...(typeof message === "string" ? { message } : {}),
      },
    };
  }
  return null;
}

/** Orca's message for an error, with its code when the message is only the code. */
export function orcaErrorText(error: {
  code?: string;
  message?: string;
}): string {
  const code = error.code ?? "";
  const message = error.message ?? "";
  if (message === "" || message === code) return code || "unknown error";
  return code === "" ? message : `${message} (${code})`;
}

/** Narrow a value read from Orca to a record, or throw naming the call. */
export function recordOf(
  value: unknown,
  what: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new OrcaError(`${what}: unexpected answer`);
  return value;
}

/** A string field of a record read from Orca, or throw naming the call. */
export function textOf(
  record: Record<string, unknown>,
  key: string,
  what: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value === "")
    throw new OrcaError(`${what}: no ${key} in the answer`);
  return value;
}
