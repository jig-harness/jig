/**
 * The provider account's credential this process holds for one launch: the
 * wrapper's, once it resolved it, or the supervisor's, once its wrapper
 * handed it over (`provider-launch.ts`). It lives in this process's memory
 * only, beside the launch record it is for, so a record of another launch
 * is never taken as masked for it.
 */
import { rememberSecret } from "../../shared/credentials.ts";

let held: { value: string; record: string } | null = null;

/** Hold `value` as the credential of the launch `record`, remembered so every mask in this process replaces it. */
export function holdCredential(record: string, value: string): void {
  rememberSecret(value);
  held = { value, record };
}

/** The credential this process holds for the launch `record`; `null` when it holds none for it. */
export function heldCredential(record: string): string | null {
  return held !== null && held.record === record ? held.value : null;
}

/** Whether this process holds the resolved credential of the launch `record`, and so can mask what that launch printed. */
export function holdsCredentialOf(record: { id: string }): boolean {
  return heldCredential(record.id) !== null;
}
