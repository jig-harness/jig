/**
 * A provider account's credential, resolved from its reference through the
 * machine file's `credential_command` at each launch.
 *
 * The command is an argument list run without a shell, the reference
 * appended as one last argument, with the environment of the process that
 * resolves it (the host's, where a vault's session lives), within
 * `credential_timeout`. Its standard output is the value, one trailing
 * newline removed; an empty value, one with a line break inside it, one
 * under 8 bytes or one over 4 KiB is refused. It runs with the base and the
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
 * carries it, and the command's error output is masked for it before a
 * reason quotes it.
 */
import {
  maskCredentials,
  redactExact,
  rememberSecret,
} from "../../shared/credentials.ts";
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
/** The shortest: exact masking leaves shorter text alone, so a shorter value could not be kept out of what is recorded. */
const SHORTEST_VALUE = 8;

const MARK = "<redacted>";

/** The command's error output, short and masked, for a reason to quote. */
function errorTail(stderr: string, stdout: string): string {
  // Whatever the command printed may be the value, whole or one line of it.
  const printed = [
    stdout.trim(),
    ...stdout.split(/\r?\n/).map((l) => l.trim()),
  ];
  for (const part of printed) rememberSecret(part);
  const line = stderr.trim().split("\n").at(-1) ?? "";
  const shown = maskCredentials(redactExact(line, MARK, printed), MARK).slice(
    0,
    200,
  );
  return shown === "" ? "" : `: ${shown}`;
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
    stderr: "pipe",
  });
  if (done.timedOut)
    return failed(
      "unreachable",
      `the credential command did not answer within ${timeoutSec}s; a later tick tries again`,
    );
  if (done.code !== 0)
    return failed(
      "unauthorized",
      `the credential command ${done.spawnFailed === true ? "could not start" : `exited ${done.code}`}${errorTail(done.stderr, done.stdout)}`,
    );
  const value = done.stdout.endsWith("\n")
    ? done.stdout.slice(0, -1)
    : done.stdout;
  if (value === "")
    return failed("unauthorized", "the credential command printed no value");
  // A refused value is still remembered, so nothing this process records later can carry it.
  rememberSecret(value);
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
  if (Buffer.byteLength(value) < SHORTEST_VALUE)
    return failed(
      "unauthorized",
      "the credential command printed a value under 8 bytes, too short to keep out of what is recorded",
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
