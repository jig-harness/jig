/**
 * A process that has no credential for an outside system learns it once,
 * at its first call, and asks the system nothing more.
 *
 * A transport whose first answer says no credential is configured (no key
 * in the environment, and a command-line client that is not logged in or
 * not installed) notes it here under the identity it would have sent with
 * (`noteMissingCredential`); from then, for `NOTE_HOLDS_MS`, every call
 * through that identity is refused before it leaves, as an `unauthorized`
 * failure that names what was looked for. Until the process knows whether
 * it has a credential there, its calls go out one at a time
 * (`throughCredential`), so concurrent reads ask the client once. A dispatch tick forgets what an earlier run noted as it starts
 * (`forgetMissingCredentials`) and lists what this run noted on its receipt
 * (`missingCredentials`).
 *
 * The cost ledger keeps a call that had no credential under `NO_CREDENTIAL`
 * with no requests, never under a credential's identity: no credential spent
 * anything, and every keyless process on a machine would otherwise share
 * one identity that reads like a failing key. `credentialLabel` names the
 * identities that are not a hashed key: that one, and a logged-in client's
 * own login.
 */
import { currentMs } from "../time.ts";
import { credentialKey } from "./budget.ts";

/** The ledger's credential of a call that had no credential to send with. No hashed credential takes this form. */
export const NO_CREDENTIAL = "(no credential)";

/** What a process found it lacks for one system. */
export interface MissingCredential {
  system: string;
  /** What is missing, in a few words: `no Linear key configured`. */
  reason: string;
  /** What gives the process one: the variables looked for and the client's login. */
  remedy: string;
  /** What the client answered, when a client was asked. */
  answer?: string;
}

/** The few words that name a system's missing credential. */
const NO_CREDENTIAL_REASONS: Readonly<Record<string, string>> = {
  linear: "no Linear key configured",
};

/** The reason a call to `system` had no credential: `no Linear key configured`. */
export function noCredentialReason(system: string): string {
  return NO_CREDENTIAL_REASONS[system] ?? `no ${system} credential configured`;
}

/** The command-line clients whose own login a transport sends with, by system: their identity is `cli:<program>`. */
const CLIENTS: ReadonlyArray<{ system: string; program: string }> = [
  { system: "linear", program: "linear" },
];

/** The identity a client's own login is recorded under. */
export function clientCredential(system: string, program: string): string {
  return credentialKey(system, `cli:${program}`);
}

/**
 * How a report names a ledger credential that is not a hashed key: a call
 * with none, or a client's own login; `null` for a key's identity.
 */
export function credentialLabel(
  system: string,
  credential: string,
): string | null {
  if (credential === NO_CREDENTIAL) return noCredentialReason(system);
  const client = CLIENTS.find(
    (c) =>
      c.system === system && clientCredential(system, c.program) === credential,
  );
  return client === undefined
    ? null
    : `the \`${client.program}\` client's own login`;
}

/** The message a refused call fails with: the reason, the remedy and what the client answered. */
export function missingCredentialMessage(missing: MissingCredential): string {
  const answered =
    missing.answer === undefined
      ? ""
      : ` (the client answered: ${missing.answer})`;
  return `${missing.reason}: ${missing.remedy}${answered}`;
}

/**
 * How long a note holds: past it, the next call is sent, so a long-lived
 * process (a drive's driver, a person's session) finds a key set or a
 * login made since. A tick still lists every note it made (`missingCredentials`).
 */
export const NOTE_HOLDS_MS = 5 * 60_000;

/** Each identity's state: noted as lacking a credential, or answered by a call that had one, with when. */
const noted = new Map<string, { missing: MissingCredential; atMs: number }>();
const answered = new Map<string, number>();
/** What was noted and then recovered from, kept for the receipt but never refusing a call. */
const history = new Map<string, MissingCredential>();
/** The first call through an identity whose credential is not known yet, which the calls that come meanwhile wait for. */
const first = new Map<string, Promise<void>>();

/** Whether a mark made at `atMs` still holds. */
const holds = (atMs: number): boolean => currentMs() - atMs < NOTE_HOLDS_MS;

/** Note that the process has no credential behind `identity`: later calls through it are refused before they leave. */
export function noteMissingCredential(
  identity: string,
  missing: MissingCredential,
): void {
  const known = noted.get(identity);
  noted.set(identity, {
    missing: known?.missing ?? missing,
    atMs: currentMs(),
  });
  answered.delete(identity);
}

/** What the process noted it lacks behind `identity`, while the note holds. */
export function missingCredentialOf(
  identity: string,
): MissingCredential | undefined {
  const note = noted.get(identity);
  return note !== undefined && holds(note.atMs) ? note.missing : undefined;
}

/**
 * One call through `identity`. While the process does not know whether it
 * has a credential there, one call goes out at a time: the first, which
 * the others wait for; then each is sent, or refused with `refuse` once a
 * call noted the credential missing. A call whose caller cancelled it
 * (`cancelled`) says nothing of the credential, and a caller whose `signal`
 * aborts stops waiting for the first call.
 */
export async function throughCredential<T>(
  identity: string,
  send: () => Promise<T>,
  refuse: (missing: MissingCredential) => Promise<T>,
  cancelled: () => boolean = () => false,
  signal?: AbortSignal,
): Promise<T> {
  for (;;) {
    const missing = missingCredentialOf(identity);
    if (missing !== undefined) return refuse(missing);
    const at = answered.get(identity);
    if (at !== undefined && holds(at)) return send();
    const out = first.get(identity);
    if (out === undefined) break;
    // A caller that cancels stops waiting and sends on its own, so its call fails at once by its own signal.
    if (signal?.aborted === true) return send();
    await Promise.race([out.catch(() => undefined), aborted(signal)]);
  }
  const done = Promise.withResolvers<void>();
  first.set(identity, done.promise);
  try {
    const result = await send();
    if (missingCredentialOf(identity) === undefined && !cancelled())
      recovered(identity);
    return result;
  } finally {
    first.delete(identity);
    done.resolve();
  }
}

/** Resolves when `signal` aborts; never when there is none. */
function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise(() => undefined);
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

/** A call went out and was answered with a credential: the identity is known to have one, and an expired note no longer counts as active. */
function recovered(identity: string): void {
  answered.set(identity, currentMs());
  const note = noted.get(identity);
  if (note === undefined) return;
  history.set(identity, note.missing);
  noted.delete(identity);
}

/** What the process lacks now, one entry per system: the notes no later call recovered from, held or expired. A preflight refuses on these. */
export function missingCredentials(): MissingCredential[] {
  return bySystem([...noted.values()].map((n) => n.missing));
}

/** What the process noted it lacked since it last forgot, one entry per system, recovered from or not: what a tick's receipt lists. */
export function notedMissingCredentials(): MissingCredential[] {
  return bySystem([
    ...history.values(),
    ...[...noted.values()].map((n) => n.missing),
  ]);
}

function bySystem(all: readonly MissingCredential[]): MissingCredential[] {
  const out = new Map<string, MissingCredential>();
  for (const m of all) if (!out.has(m.system)) out.set(m.system, m);
  return [...out.values()];
}

/** Forget what was noted: a new run asks again. */
export function forgetMissingCredentials(): void {
  noted.clear();
  answered.clear();
  history.clear();
}
