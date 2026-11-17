/**
 * Whose allowance a GitHub rate-limit refusal says it spent. GitHub's
 * refusal names the user ("API rate limit exceeded for user ID N"), in the
 * client's error text and in the error answer's own message; the transport
 * reads it only there, never from the rest of an answer, which can be a page
 * of content quoting the same words.
 */
import { swallow } from "../errors.ts";
import { isRecord } from "../guards.ts";

/** The user a refusal's text names as the one whose allowance is spent: GitHub's "rate limit exceeded for user ID N". */
export function refusedUser(text: string): number | null {
  const match = /rate limit (?:already )?exceeded for user ID (\d+)/i.exec(
    text,
  );
  const id = Number(match?.[1] ?? "");
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The messages an error answer carries: a REST error's `message` and each
 * GraphQL error's, one a line; empty for an answer that is not a JSON
 * object.
 */
export function errorMessages(body: string): string {
  const text = body.trim();
  if (!text.startsWith("{")) return "";
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    swallow(error, "an answer that is not JSON carries no error message");
    return "";
  }
  if (!isRecord(value)) return "";
  const errors = Array.isArray(value.errors) ? value.errors : [];
  return [value, ...errors]
    .map((e) => (isRecord(e) && typeof e.message === "string" ? e.message : ""))
    .filter((m) => m !== "")
    .join("\n");
}
