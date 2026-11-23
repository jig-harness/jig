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
  for (const part of [stdout.trim(), ...stdout.split(/\r?\n/)])
    rememberSecret(part.trim());
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
    // Error output is never recorded, so it is not captured; standard output is bounded to the longest value plus a line ending and one byte to tell an overlong value apart.
    stderr: "ignore",
    maxBufferBytes: LONGEST_VALUE + 3,
    reapGroup: true,
  });
  if (done.bufferExceeded) {
    learnPrinted(done.stdout);
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
  // A refused value is still remembered, so nothing this process records later can carry it.
  rememberSecret(value);
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
