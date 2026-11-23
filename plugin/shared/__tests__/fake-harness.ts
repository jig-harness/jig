/**
 * A third agent harness that Jig does not ship, for tests: registered with
 * `registerHarness` for the length of one test, it shows that a harness is
 * added by writing one implementation and registering it, with no caller
 * changed.
 *
 * Its program is the Bun running the test, and its pass command prints the
 * prompt it was given, so a test can start the pass a caller built and read
 * what it ran.
 */
import { basename } from "node:path";
import { failed } from "../outcome.ts";
import type { AgentHarness, PassRequest } from "../agent-harness/index.ts";

export const FAKE_NAME = "fake-harness";
export const FAKE_DIRECTORY_VARIABLE = "FAKE_HARNESS_HOME";
export const FAKE_CREDENTIAL = "FAKE_HARNESS_TOKEN";
export const FAKE_MARKER = "FAKE_HARNESS_SESSION";

/** The program the fake runs: this process's Bun, by the path it was started from. */
export const FAKE_PROGRAM = process.execPath;

/** The script the fake's pass runs: it prints the prompt, its last word. */
const PRINT_PROMPT = "console.log(process.argv.at(-1))";

function route(request: { model?: string | null; effort?: string | null }) {
  return [
    ...(request.model == null ? [] : ["--fake-model", request.model]),
    ...(request.effort == null ? [] : ["--fake-effort", request.effort]),
  ];
}

export const fakeHarness: AgentHarness = {
  name: FAKE_NAME,
  label: "Fake Harness",
  program: basename(FAKE_PROGRAM),
  runtime: "fake-runtime",
  identify: () => ({
    name: FAKE_NAME,
    label: "Fake Harness",
    program: basename(FAKE_PROGRAM),
    runtime: "fake-runtime",
    versions: null,
  }),
  passCommand: (request: PassRequest) => [
    FAKE_PROGRAM,
    "-e",
    PRINT_PROMPT,
    ...route(request),
    ...(request.hostArgs ?? []),
    request.prompt,
  ],
  interactiveCommand: (request) => [
    FAKE_PROGRAM,
    ...route(request),
    request.prompt,
  ],
  resumeCommand: (session) => [FAKE_PROGRAM, "--fake-resume", session],
  skillPrompt: (invocation) => `Fake skill run: ${invocation}`,
  model: (value) => ["--fake-model", value],
  effort: (value) => ["--fake-effort", value],
  modelFlags: ["--fake-model"],
  withModel: (argv, value, firstAt) => {
    const at = firstAt ?? 1;
    return [...argv.slice(0, at), "--fake-model", value, ...argv.slice(at)];
  },
  environment: {
    directoryVariable: FAKE_DIRECTORY_VARIABLE,
    credentialVariables: [FAKE_CREDENTIAL],
    isSessionMarker: (variable) => variable === FAKE_MARKER,
    sessionMarkers: () => ({ [FAKE_MARKER]: "1" }),
  },
  accountIdentity: (env) => {
    const home = env[FAKE_DIRECTORY_VARIABLE];
    return home === undefined || home === ""
      ? {
          account: null,
          vendor: FAKE_NAME,
          provenance: FAKE_DIRECTORY_VARIABLE,
          reason: `${FAKE_DIRECTORY_VARIABLE} is not set`,
        }
      : {
          account: `fake@${basename(home)}`,
          vendor: FAKE_NAME,
          provenance: FAKE_DIRECTORY_VARIABLE,
          reason: null,
        };
  },
  wallReader: null,
  sessionIdIn: () => null,
  transcript: () => null,
  usage: () => failed("not-supplied", "the fake harness reports no usage"),
  classifyStop: () =>
    failed("not-supplied", "the fake harness classifies no stop"),
  capabilities: {
    sessionId: "minted",
    turnCap: true,
    bypassOptIn: false,
    hostArgsAt: "launch",
    signInProbe: false,
    backgroundTasks: false,
    subagents: false,
    hooks: false,
    slashCommands: false,
    permissionModes: false,
    structuredQuestion: false,
    usage: false,
    classifyStop: false,
  },
};
