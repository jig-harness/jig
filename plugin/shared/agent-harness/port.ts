/**
 * The agent-harness interface
 * ([ADR-0026](../../../docs/adr/ADR-0026-the-agent-harness-is-an-interface.md)):
 * what Jig asks of the program that runs a model as an agent. Claude Code and
 * Codex implement it (`claude-code.ts`, `codex.ts`) and the registry
 * (`index.ts`) lists them; code outside this directory holds a harness
 * through the interface and names none by value.
 *
 * Each operation is a function from facts the caller holds to a value or an
 * `Outcome`. An operation no caller needs yet answers through
 * `capabilities` that the harness does not supply it, and its function
 * returns a `not-supplied` failure.
 *
 * Code in this directory imports no skill (`plugin/shared` never does). A
 * reader whose code lives in a skill is named here by its key and resolved
 * where it lives: the wall reader by `wallReader`, which names the quota
 * adapter in drive-pr's quota registry; the directory walk a transcript
 * search uses is the caller's to pass.
 */
import type { Dirent } from "node:fs";
import type { Outcome } from "../outcome.ts";

/**
 * A registered harness's name: the value an account's `vendor` and a launch
 * record's `vendor` hold, and the name `run.ts identity <name>` takes.
 */
export type HarnessName = string;

/** Which account a pass bills against, as a harness reads it from its own login state. */
export interface AccountIdentity {
  /** The resolved identity (an email address, or an account id when no email is available); `null` when nothing resolved. */
  account: string | null;
  /** The harness this identity was resolved for; `null` when the pass command named no registered harness. */
  vendor: HarnessName | null;
  /** How `account` was resolved, present whether or not it resolved, so a `null` account still says what was tried. */
  provenance: string;
  /** Only when `account` is `null`: why nothing resolved. */
  reason: string | null;
}

/** One headless pass: the facts its command line is built from. */
export interface PassRequest {
  prompt: string;
  /** The model in the harness's own naming; none leaves the harness's default. */
  model?: string | null;
  /** The effort level; none leaves the harness's default. */
  effort?: string | null;
  /** The session id the launch minted, for a harness that takes one. */
  sessionId?: string | null;
  /** Whether the host opted in to an unattended run without sandbox or approvals, for a harness that asks for it. */
  bypass?: boolean;
  /** The host's own extra words for this harness's pass. */
  hostArgs?: readonly string[];
}

/** A session a person attaches to. */
export interface InteractiveRequest {
  prompt: string;
  model?: string | null;
  effort?: string | null;
  sessionId?: string | null;
}

/** The facts a transcript is found from. */
export interface TranscriptQuery {
  /** The account's configuration directory. */
  configDir: string;
  session: string;
  /** When the run was made, for a harness that files transcripts by day. */
  startedMs: number;
  /** How a directory is read: the caller's bounded walk; `onEntry` returns false to stop. */
  walk: (dir: string, onEntry: (entry: Dirent) => boolean) => boolean;
}

/** What a launch carries and removes for this harness. */
export interface HarnessEnvironment {
  /** The variable naming the account's configuration directory. */
  directoryVariable: string;
  /** The credential variables a launch on any account removes. */
  credentialVariables: readonly string[];
  /** Whether `name` is a variable the harness sets in its own sessions, removed so a launched session detects its own agent. */
  isSessionMarker(name: string): boolean;
  /** The variables the harness's own session would carry on `configDir`, for a child that must read as running inside it. */
  sessionMarkers(configDir: string): Record<string, string>;
}

/**
 * What the program has, as facts callers check instead of a harness's name.
 * A `false` operation (`usage`, `classifyStop`) is one the harness does not
 * supply: a caller that needs it refuses with that reason.
 */
export interface HarnessCapabilities {
  /** How a launch learns its session id: minted by the launch and passed in, or printed by the program at its start. */
  sessionId: "minted" | "printed";
  /** Whether a pass has a turn cap of its own; without one only the pass deadline bounds it. */
  turnCap: boolean;
  /** Whether an unattended pass needs the host's opt-in to run without sandbox and approvals. */
  bypassOptIn: boolean;
  /** When the host's extra pass words are read: as the pass starts, or kept on the launch record at admission. */
  hostArgsAt: "launch" | "admission";
  /** Whether the dispatcher checks the account's sign-in before a launch and reads a sign-in failure at startup. */
  signInProbe: boolean;
  /** Background tasks, which a headless pass turns off where the harness has them. */
  backgroundTasks: boolean;
  subagents: boolean;
  hooks: boolean;
  /** Whether a skill runs from its slash command (`/jig:drive-pr`) rather than from the prompt naming it. */
  slashCommands: boolean;
  permissionModes: boolean;
  /** A tool that asks the user a structured question. */
  structuredQuestion: boolean;
  /** Whether `usage` reads what a pass cost. */
  usage: boolean;
  /** Whether `classifyStop` reads an exit as a failure class. */
  classifyStop: boolean;
}

/** `identify`'s answer. */
export interface HarnessIdentity {
  name: HarnessName;
  /** The program as a person reads it: `Claude Code`. */
  label: string;
  /** The command that starts it: `claude`. */
  program: string;
  /** The runtime name a session detects and a route's `routing.models` row is keyed by: `claude-code`. */
  runtime: string;
  /** The program versions Jig checks before running one; `null` when no check is made. */
  versions: { minimum: string } | null;
}

/** An operation the harness does not supply. */
export type NotSupplied = "not-supplied";

export interface AgentHarness {
  readonly name: HarnessName;
  readonly label: string;
  readonly program: string;
  readonly runtime: string;
  /** Its name and the versions of the program it can run. */
  identify(): HarnessIdentity;
  /** The command that runs one headless pass. */
  passCommand(request: PassRequest): string[];
  /** The command of a session a person attaches to. */
  interactiveCommand(request: InteractiveRequest): string[];
  /** The command that resumes the session `session`, run with the account's directory variable set. */
  resumeCommand(session: string): string[];
  /** A skill's invocation (`/jig:drive-pr …`) in the form the harness runs it from a prompt. */
  skillPrompt(invocation: string): string;
  /** The words that run the pass on `model`. */
  model(model: string): string[];
  /** The words that run the pass at `effort`. */
  effort(effort: string): string[];
  /** The option words a pass command names its model with. */
  readonly modelFlags: readonly string[];
  /** `argv` (its model option already removed) with `model` put where this harness takes it; `firstAt` is where the removed option was. */
  withModel(
    argv: readonly string[],
    model: string,
    firstAt: number | null,
  ): string[];
  readonly environment: HarnessEnvironment;
  /** The account a pass started in `env` bills against, read from the harness's own login state. */
  accountIdentity(env: Record<string, string | undefined>): AccountIdentity;
  /** The key of the quota adapter that reads this harness's walls (drive-pr's quota registry); `null` when none does. */
  readonly wallReader: string | null;
  /** The session id the program printed at its start, in `output`; `null` when it printed none or mints none. */
  sessionIdIn(output: string | undefined): string | null;
  /** Where the transcript of a session is, or `null` when it was not found. */
  transcript(query: TranscriptQuery): string | null;
  /** The tokens, model and cost a pass reported. */
  usage(output: string): Outcome<never, NotSupplied>;
  /** An exit and its output as one of the closed failure classes. */
  classifyStop(
    code: number | null,
    output: string,
  ): Outcome<never, NotSupplied>;
  readonly capabilities: HarnessCapabilities;
}
