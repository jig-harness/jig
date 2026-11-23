/**
 * The wrapper's part of a provider account's launch: the credential it
 * resolves before the stage starts, the pass's environment that carries it,
 * and the recorded text that must not.
 *
 * The tick stamps a provider account's launch record with what its wrapper
 * needs that is no secret (`stampProvider`): the provider, the harness, the
 * base URL and the account's identity. The wrapper reads the machine file
 * again, finds the account the record names with that identity, and
 * resolves its credential (`provider-credential.ts`); a refusal holds the
 * account and starts nothing. A headless stage runs under a separate
 * supervisor, so the wrapper hands the value to it in the supervisor's own
 * environment (`CREDENTIAL_HANDOFF`), which the supervisor removes from its
 * environment as it starts. Both processes remember the value, so each mask
 * they apply (the output spool, the transcript copy, the closing report)
 * replaces it, and the stage's kept output is redacted for it before the
 * exit is recorded.
 */
import { redactExact } from "../../shared/credentials.ts";
import { Defect } from "../../shared/errors.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { currentIso } from "../../shared/time.ts";
import { passEnvironment, providerPassEnvironment } from "./accounts.ts";
import { type LaunchRecord, recordExit } from "./launches.ts";
import {
  type MachineAccount,
  type MachineConfig,
  type MachineConfigCode,
  readMachineConfig,
} from "./machine-config.ts";
import {
  credentialResolved,
  holdForCredential,
  resolveCredential,
} from "./provider-credential.ts";
import { credentialEnvOf } from "./credential-env.ts";
import {
  CREDENTIAL_HANDOFF,
  withheldFromPasses,
  withoutVariables,
} from "./provider-environment.ts";
import { heldCredential, holdCredential } from "./provider-held.ts";
import type { Ran } from "./run-stage.ts";

/** The record's part of a provider account's launch; `undefined` for a subscription account. */
function providerRecordOf(
  account: Pick<MachineAccount, "identity" | "provider">,
): LaunchRecord["provider"] {
  const provider = account.provider;
  return provider === undefined
    ? undefined
    : {
        provider: provider.provider,
        harness: provider.harness,
        baseUrl: provider.baseUrl,
        identity: account.identity,
      };
}

/** Stamp `record` with its account's provider launch, or leave it a subscription account's. */
export function stampProvider(
  record: LaunchRecord,
  account: Pick<MachineAccount, "identity" | "provider">,
): void {
  const provider = providerRecordOf(account);
  if (provider === undefined) delete record.provider;
  else record.provider = provider;
}

type Readable = () => Outcome<MachineConfig | null, MachineConfigCode>;

/**
 * Resolve a provider launch's credential, before its stage starts; `ok`
 * at once for a subscription account's launch. A refused credential holds
 * the account (`holdForCredential`); every failure starts nothing.
 */
async function resolveLaunchCredential(
  record: LaunchRecord,
  readMachine: Readable = () => readMachineConfig(),
): Promise<Outcome<void, "unauthorized" | "unreachable" | "changed">> {
  if (record.provider === undefined) return ok(undefined);
  const machine = readMachine();
  if (!machine.ok || machine.value === null)
    return failed(
      "changed",
      `the machine file does not read, so ${record.account}'s credential is not resolved`,
    );
  const account = machine.value.accounts.find((a) => a.name === record.account);
  if (
    account?.provider === undefined ||
    account.identity !== record.provider.identity ||
    // The canonical launch fields: what the stage's environment is built from.
    account.provider.harness !== record.provider.harness ||
    account.provider.baseUrl !== record.provider.baseUrl ||
    account.provider.provider !== record.provider.provider ||
    account.configDir !== record.configDir
  )
    return failed(
      "changed",
      `${record.account} is no longer the provider account the launch was admitted on`,
    );
  const value = await resolveCredential(
    machine.value.credentials,
    account.provider.credential,
    credentialEnvOf(machine.value),
  );
  if (!value.ok) {
    if (value.failure.code === "unauthorized")
      holdForCredential(
        account,
        value.failure.reason,
        machine.value.wallBackoffMs,
      );
    return value;
  }
  credentialResolved(account);
  holdCredential(record.id, value.value);
  return ok(undefined);
}

/**
 * In the wrapper: resolve the launch's credential, and when it is refused
 * record the exit (nothing started) and settle the launch's claim with
 * `settle`; whether the stage may start. A subscription account's launch
 * reads the machine file too, for the variables no pass may carry
 * (`credential_env`); one that does not read changes nothing for it.
 */
export async function launchCredential(
  record: LaunchRecord,
  settle: () => Promise<void>,
  readMachine?: Readable,
): Promise<boolean> {
  if (record.provider === undefined) {
    (readMachine ?? (() => readMachineConfig()))();
    return true;
  }
  const resolved = await resolveLaunchCredential(record, readMachine);
  if (resolved.ok) return true;
  console.error(
    `jig dispatch run: ${resolved.failure.code}: ${resolved.failure.reason}; nothing started`,
  );
  recordExit(record.id, {
    at: currentIso(),
    code: 2,
    signal: null,
    beforeStage: true,
  });
  await settle();
  return false;
}

/**
 * The environment of the wrapper's supervisor of the launch `record`: the
 * wrapper's own, without the credential command's variables
 * (`credential_env`), and with the resolved credential where it holds one.
 */
export function supervisorEnvironment(
  record: { id: string },
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base))
    if (value !== undefined) env[name] = value;
  withoutVariables(env, [CREDENTIAL_HANDOFF, ...withheldFromPasses()]);
  const value = heldCredential(record.id);
  if (value !== null) env[CREDENTIAL_HANDOFF] = value;
  return env;
}

/** In the supervisor of the launch `id`: take the credential its wrapper handed over out of this process's environment. */
export function takeHandedCredential(id: string): void {
  const value = process.env[CREDENTIAL_HANDOFF];
  delete process.env[CREDENTIAL_HANDOFF];
  if (value === undefined || value === "") return;
  holdCredential(id, value);
}

/**
 * The environment a launch's stage runs in: a subscription account's as
 * `passEnvironment` gives it, a provider account's with its resolved
 * credential (`providerPassEnvironment`).
 */
export function stageEnvironment(
  base: Record<string, string | undefined>,
  record: LaunchRecord,
): Record<string, string> {
  if (record.provider === undefined) return passEnvironment(base, record);
  const held = heldCredential(record.id);
  if (held === null)
    throw new Defect(
      `${record.id} is a provider account's launch and reached its stage with no resolved credential`,
    );
  return providerPassEnvironment(base, record, record.provider, held);
}

/** `ran` with every exact secret this process holds replaced in the text it keeps. */
export function redactedRan(ran: Ran): Ran {
  const mark = "<redacted>";
  const out: Ran = { ...ran };
  for (const key of [
    "output",
    "errors",
    "startupOutput",
    "said",
    "head",
  ] as const) {
    const text = ran[key];
    if (text !== undefined) out[key] = redactExact(text, mark);
  }
  return out;
}
