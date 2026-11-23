/**
 * The registry of agent harnesses
 * ([ADR-0026](../../../docs/adr/ADR-0026-the-agent-harness-is-an-interface.md)):
 * Claude Code and Codex, in that order, which is the order every caller that
 * asks each harness in turn (the quota adapters, the environment's removals)
 * reads them in. A harness is added by writing an implementation of
 * `port.ts` and listing it here; `registerHarness` adds one for the life of
 * the process, which is how a test runs a harness Jig does not ship.
 *
 * Callers find a harness by what they hold: an account's or a launch
 * record's vendor (`harnessNamed`), the program a pass command starts
 * (`harnessOfProgram`) or the runtime a session detects (`harnessOfRuntime`).
 */
import { basename } from "node:path";
import { Defect } from "../outcome.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import type { AgentHarness, HarnessName } from "./port.ts";

export type {
  AccountIdentity,
  AgentHarness,
  HarnessName,
  PassRequest,
} from "./port.ts";

const registered: AgentHarness[] = [claudeCode, codex];

/** Every registered harness, built-in ones first. */
export function harnesses(): readonly AgentHarness[] {
  return registered;
}

/** The harness a caller with no session to read falls back to: the first registered, Claude Code. */
export function defaultHarness(): AgentHarness {
  return registered[0] as AgentHarness;
}

/**
 * Add `harness` to the registry until the returned function removes it. A
 * name already registered is a defect: two implementations of one name
 * would make every lookup a guess.
 */
export function registerHarness(harness: AgentHarness): () => void {
  if (registered.some((h) => h.name === harness.name))
    throw new Defect(`a harness named ${harness.name} is already registered`);
  registered.push(harness);
  return () => {
    const at = registered.indexOf(harness);
    if (at !== -1) registered.splice(at, 1);
  };
}

/** The harness `name` names; `null` when none is registered under it. */
export function harnessNamed(
  name: string | null | undefined,
): AgentHarness | null {
  if (name === null || name === undefined) return null;
  return registered.find((h) => h.name === name) ?? null;
}

/** Whether `name` names a registered harness. */
export function isHarnessName(name: unknown): name is HarnessName {
  return typeof name === "string" && harnessNamed(name) !== null;
}

/**
 * The harness `name` names, for a caller that holds a name validated
 * earlier (a launch record read through its guard, an admitted account):
 * an unregistered one there is a defect.
 */
export function harnessFor(name: HarnessName): AgentHarness {
  const harness = harnessNamed(name);
  if (harness === null)
    throw new Defect(`no agent harness is registered under ${name}`);
  return harness;
}

/**
 * The harness `name` names, else the default one: for a caller whose
 * record or account predates its validation, which reads an unknown vendor
 * the way it always read one that is not Codex.
 */
export function harnessOrDefault(
  name: string | null | undefined,
): AgentHarness {
  return harnessNamed(name) ?? defaultHarness();
}

/** A trailing platform binary extension, so `claude.exe` and `codex.cmd` read as their Unix names. */
const BINARY_EXT_RE = /\.(exe|cmd|bat|ps1)$/i;

/** The harness whose program `argv0` starts, by its base name; `null` for any other program. */
export function harnessOfProgram(
  argv0: string | undefined,
): AgentHarness | null {
  if (argv0 === undefined || argv0 === "") return null;
  const name = basename(argv0).replace(BINARY_EXT_RE, "");
  return registered.find((h) => h.program === name) ?? null;
}

/** The harness of a detected session runtime (`claude-code`, `codex`); `null` for any other. */
export function harnessOfRuntime(
  runtime: string | null | undefined,
): AgentHarness | null {
  if (runtime === null || runtime === undefined) return null;
  return registered.find((h) => h.runtime === runtime) ?? null;
}

/** Every registered harness's configuration-directory variable. */
export function directoryVariables(): string[] {
  return registered.map((h) => h.environment.directoryVariable);
}

/** Every registered harness's credential variables. */
export function credentialVariables(): string[] {
  return registered.flatMap((h) => h.environment.credentialVariables);
}

/** Whether `name` is a variable some registered harness marks its own sessions with. */
export function isSessionMarker(name: string): boolean {
  return registered.some((h) => h.environment.isSessionMarker(name));
}

/** The programs of the registered harnesses, as a person reads the list (`claude/codex`). */
export function programList(): string {
  return registered.map((h) => h.program).join("/");
}
