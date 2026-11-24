/**
 * A provider account's credential, resolved from its reference through the
 * machine file's `credential_command` at each launch.
 *
 * The command is an argument list run without a shell, the reference
 * appended as one last argument, with the environment of the process that
 * resolves it (the host's, where a vault's session lives), within
 * `credential_timeout`. Its standard output is the value, one trailing
 * newline (LF or CRLF) removed; an empty value, one with a line break inside it, one
 * under 8 characters or one over 4 KiB is refused. It runs with the base and the
 * `credential_env` variables of the resolving process's environment
 * (`credential-env.ts`), the same in the tick and in the wrapper.
 *
 * A non-zero exit or a refused value is `unauthorized`: the credential is
 * missing, expired or refused. The account is then held for `wall_backoff`
 * with the reason, and one host need for a person stands until a launch
 * resolves it again (`holdForCredential`). A command that does not answer in
 * time is `unreachable`: the launch waits for the next tick, and nothing is
 * held.
 *
 * The value stays in the resolving process's memory, remembered so every
 * mask there replaces it (`shared/credentials.ts`); no reason, wall or need
 * carries it, and the command's error output is never quoted in a reason.
 */
import { isMaskable, rememberSecret } from "../../shared/credentials.ts";
import { swallow } from "../../shared/errors.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { run } from "../../shared/proc.ts";
import { currentMs, isoFromMs } from "../../shared/time.ts";
import { stateRoot } from "../receipts.ts";
import { OMITTED_LINE_TEXT } from "./provider-held.ts";
import { TRUNCATED_LINE } from "./runtime/process-spool.ts";
import {
  recordAccountSignInSuccess,
  recordAccountStartupProblem,
} from "./account-startup.ts";
import type { MachineAccount } from "./machine-config.ts";
import type { CredentialSettings } from "./provider-account.ts";
import { writeWall } from "./walls.ts";

/** How resolving a credential fails. */
export type CredentialCode = "unauthorized" | "unreachable";

/** The longest value a credential command may print. */
const LONGEST_VALUE = 4096;

/**
 * What a failed command's output teaches this process: every line it printed
 * on standard output is remembered, so no later record carries it. Its error
 * output is never quoted, since an opaque secret printed only there could not
 * be recognised.
 */
function learnPrinted(stdout: string): void {
  for (const part of [stdout.trim(), ...stdout.split(/\r?\n/)]) {
    // Keep the marker emitted by a sink recognizable, but remember every
    // maskable opaque fragment around it. A failed command can print a real
    // credential beside a replacement marker on the same line.
    for (const fragment of part
      .split(new RegExp(`(${MARKERS.map(escapeRegExp).join("|")})`))
      .map((value) => value.trim())) {
      if (fragment !== "" && !collidesWithMarker(fragment))
        rememberSecret(fragment);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The replacement texts the sinks emit, in lowercase and matched exactly. */
const MARKERS = ["<redacted>", "[redacted]", "[launch token]", TRUNCATED_LINE];

/**
 * Whether `value` is part of a sink's replacement text, or contains one:
 * remembering it would make masking treat the marker's own text as secret.
 * Both directions are compared case-sensitively, as the sinks match.
 */
function collidesWithMarker(value: string): boolean {
  return (
    OMITTED_LINE_TEXT.includes(value) ||
    value.includes(OMITTED_LINE_TEXT) ||
    MARKERS.some((marker) => marker.includes(value) || value.includes(marker))
  );
}

/**
 * Resolve `reference` through the host's credential command; the value, or
 * why not. `env` is the environment the command runs with
 * (`credentialEnvOf`).
 */
export async function resolveCredential(
  settings: CredentialSettings | undefined,
  reference: string,
  env: Record<string, string | undefined>,
): Promise<Outcome<string, CredentialCode>> {
  const command = settings?.credentialCommand ?? null;
  if (settings === undefined || command === null)
    return failed(
      "unauthorized",
      "the machine file names no credential_command to resolve the credential reference",
    );
  const timeoutSec = Math.max(
    1,
    Math.ceil(settings.credentialTimeoutMs / 1000),
  );
  const done = await run([...command, reference], {
    timeoutSec,
    env,
    // Error output is discarded and never counts toward the bound, so the bound is the longest value plus a line ending and one byte. A value over the longest is refused below by its own length.
    stderr: "ignore",
    maxBufferBytes: LONGEST_VALUE + 3,
    reapGroup: true,
  });
  if (done.bufferExceeded) {
    // Only the bounded head is kept: the overflow chunk is never retained.
    learnPrinted(done.stdout.slice(0, LONGEST_VALUE + 3));
    return failed(
      "unauthorized",
      "the credential command printed a value over 4 KiB",
    );
  }
  if (done.timedOut)
    return failed(
      "unreachable",
      `the credential command did not answer within ${timeoutSec}s; a later tick tries again`,
    );
  if (done.code !== 0) {
    learnPrinted(done.stdout);
    return failed(
      "unauthorized",
      `the credential command ${done.spawnFailed === true ? "could not start" : `exited ${done.code}`}; its error output is not recorded`,
    );
  }
  if (done.groupSurvived === true)
    return failed(
      "unauthorized",
      "the credential command left a background process running; it was stopped, and its value is not used",
    );
  const value = done.stdout.replace(/\r?\n$/, "");
  if (value === "")
    return failed("unauthorized", "the credential command printed no value");
  // A value that is part of, or contains, a sink's replacement text is refused before it is remembered. The sinks emit these markers in lowercase and match exactly.
  if (collidesWithMarker(value))
    return failed(
      "unauthorized",
      "the credential command printed a value that contains a redaction marker",
    );
  // A refused value is still remembered, so nothing this process records later can carry it.
  rememberSecret(value);
  // The output was decoded as UTF-8 before it reached here: a malformed byte became U+FFFD, so the value is not what the command printed.
  if (value.includes("\uFFFD"))
    return failed(
      "unauthorized",
      "the credential command printed a value that is not valid UTF-8",
    );
  if (value.includes("\0"))
    return failed(
      "unauthorized",
      "the credential command printed a value with a NUL character in it",
    );
  if (/[\r\n]/.test(value))
    return failed(
      "unauthorized",
      "the credential command printed a value with a line break inside it",
    );
  if (Buffer.byteLength(value) > LONGEST_VALUE)
    return failed(
      "unauthorized",
      "the credential command printed a value over 4 KiB",
    );
  if (!isMaskable(value))
    return failed(
      "unauthorized",
      "the credential command printed a value under 8 characters, too short to keep out of what is recorded",
    );
  return ok(value);
}

/**
 * Hold `account` after its credential was refused: a wall for
 * `wallBackoffMs` with the reason, and the account's one startup problem,
 * which the line shows as one host need until a resolution succeeds.
 */
export function holdForCredential(
  account: Pick<MachineAccount, "name" | "vendor" | "configDir">,
  reason: string,
  wallBackoffMs: number,
  root = stateRoot(),
): void {
  try {
    const now = currentMs();
    writeWall(
      {
        account: account.name,
        vendor: account.vendor,
        configDir: account.configDir,
        source: `the credential was refused (unauthorized): ${reason}`,
        resetAt: isoFromMs(now + wallBackoffMs),
      },
      root,
    );
    recordAccountStartupProblem(account, "sign-in", isoFromMs(now), root);
  } catch (error) {
    swallow(error, "the refused credential's hold could not be recorded");
  }
}

/** Lift the need a refused credential raised, once it resolves again. */
export function credentialResolved(
  account: Pick<MachineAccount, "vendor" | "configDir">,
  root = stateRoot(),
): void {
  try {
    recordAccountSignInSuccess(account, isoFromMs(currentMs()), root);
  } catch (error) {
    swallow(error, "the resolved credential could not be recorded");
  }
}
