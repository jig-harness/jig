/** Fixture launch interception. Only recursively participating Bun programs close their launch edges. */
import { isAbsolute } from "node:path";
import { fixtureProgram, type LaunchOptions } from "./test-fixture-program.ts";
import { fixtureObserverActive } from "../plugin/shared/fixture-observer.ts";
import { JigError } from "../plugin/shared/errors.ts";
import {
  FIXTURE_NODE_ENV,
  FIXTURE_REGISTRY_ENV,
  acknowledgeFixtureLaunch,
  beginFixtureLaunch,
  registerFixtureScope,
  type FixtureMembership,
} from "../plugin/shared/test-fixture-registry.ts";

interface TrackingState {
  current?: FixtureMembership;
  installed: boolean;
  observing: boolean;
  trusted: boolean;
  started: boolean;
  startupEnv: Readonly<NodeJS.ProcessEnv>;
}
const key = Symbol.for("jig.test-fixture-tracking");
const globals = globalThis as typeof globalThis & {
  [key: symbol]: TrackingState | undefined;
};
// Watch cycles reload modules in one process. Keep one interception layer and
// one membership context rather than wrapping the previous cycle's wrapper.
const state = globals[key] ?? {
  installed: false,
  observing: false,
  trusted: false,
  started: false,
  startupEnv: Object.freeze({ ...process.env }),
};
globals[key] = state;
function inherited(): FixtureMembership | undefined {
  const registry = process.env[FIXTURE_REGISTRY_ENV];
  const node = process.env[FIXTURE_NODE_ENV];
  return registry &&
    isAbsolute(registry) &&
    node &&
    /^[a-f0-9-]{36}$/.test(node)
    ? { registry, node }
    : undefined;
}
function must<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; failure: { reason: string; cause?: unknown } },
): T {
  if (!result.ok)
    throw new JigError("fixture-registration", result.failure.reason, {
      cause: result.failure.cause,
    });
  return result.value;
}
/** Bootstrap executes before the child program, closing its pending launch edge first. */
function acknowledgeTrackedFixture(): void {
  const membership = inherited();
  if (!membership) return;
  const trusted = must(acknowledgeFixtureLaunch(membership));
  state.current = membership;
  state.trusted = trusted;
  state.started = true;
  if (trusted) install();
}
/** Register every scope, including scopes manually nested by tests. */
export function trackFixtureScope(root: string, startup = false): void {
  const parent = state.current ?? inherited();
  const rootStartup = !parent && !state.started && startup;
  state.started = true;
  const registration = registerFixtureScope(root, parent);
  if (!registration.ok) {
    const code = (
      registration.failure.cause as NodeJS.ErrnoException | undefined
    )?.code;
    // Without a durable registration the general scratch collector remains
    // report-only. Read-only homes must still be able to run their tests.
    if (["EROFS", "EACCES", "EPERM"].includes(code ?? "")) {
      console.warn(
        `[test-fixtures] ${registration.failure.reason}; the scope remains report-only: ${root}`,
        registration.failure.cause,
      );
      return;
    }
  }
  const membership = must(registration);
  // A helper called halfway through a program cannot account for children
  // started before interception. Only the runner's initial preload claims
  // startup coverage; a late first scope remains explicitly incomplete.
  if (!parent && !rootStartup)
    must(beginFixtureLaunch(membership, false, "prior-work"));
  state.current = membership;
  if (rootStartup) state.trusted = true;
  // A late or opaque realm cannot reconstruct Bun's startup environment.
  // Its durable unknown membership keeps scratch safe without changing its
  // native spawn behavior, even if a later helper claims startup coverage.
  if (state.trusted) install();
}
type Launch = { command: string[]; options: LaunchOptions; arrayForm: boolean };
function launchArguments(args: unknown[]): Launch | null {
  const arrayForm = Array.isArray(args[0]);
  const options = (arrayForm ? args[1] : args[0]) as LaunchOptions | undefined;
  const command = arrayForm ? args[0] : options?.cmd;
  if (
    !Array.isArray(command) ||
    !command.every((part) => typeof part === "string")
  )
    return null;
  return { command: [...command], options: { ...options }, arrayForm };
}
function opaqueLaunch(): void {
  if (state.current && !fixtureObserverActive())
    must(beginFixtureLaunch(state.current, false));
}
type Callable = (...args: unknown[]) => unknown;
function opaqueShell(shell: Callable): Callable {
  return new Proxy(shell, {
    apply(target, receiver, args) {
      opaqueLaunch();
      return Reflect.apply(target, receiver, args);
    },
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const configured: unknown = Reflect.apply(value, target, args);
        return typeof configured === "function"
          ? opaqueShell(configured as Callable)
          : configured;
      };
    },
  });
}
function install(): void {
  if (state.installed) return;
  state.installed = true;
  const nativeSpawn = Bun.spawn.bind(Bun);
  const nativeSync = Bun.spawnSync.bind(Bun);
  Bun.$ = opaqueShell(Bun.$ as unknown as Callable) as typeof Bun.$;
  globalThis.Worker = new Proxy(globalThis.Worker, {
    construct(target, args, newTarget) {
      opaqueLaunch();
      return Reflect.construct(target, args, newTarget);
    },
  });
  // Bun's node adapter captures its native worker constructor separately.
  // Replace the CommonJS export before fixture modules import its binding.
  const workers: typeof import("node:worker_threads") = require("node:worker_threads");
  workers.Worker = new Proxy(workers.Worker, {
    construct(target, args, newTarget) {
      opaqueLaunch();
      return Reflect.construct(target, args, newTarget);
    },
  });
  const wrap =
    (original: (...args: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      if (state.observing || fixtureObserverActive() || !state.current)
        return original(...args);
      const launch = launchArguments(args);
      if (!launch) {
        must(beginFixtureLaunch(state.current, false));
        return original(...args);
      }
      // Bun's implicit environment is its startup snapshot. Node's adapter
      // supplies its live environment explicitly, which stays explicit here.
      // Copy outside observer admission so user-supplied getters still have
      // their own launches registered.
      const effective = {
        ...launch.options,
        env: { ...(launch.options.env ?? state.startupEnv) },
      };
      // Lock/identity probes are observers, never fixture programs. They run
      // before launch and cannot recursively acquire membership of themselves.
      state.observing = true;
      let edge: FixtureMembership;
      let rewritten: string[] | null;
      try {
        rewritten = fixtureProgram(
          launch.command,
          effective,
          state.current.registry,
        );
        edge = must(beginFixtureLaunch(state.current, rewritten !== null));
      } finally {
        state.observing = false;
      }
      const options = {
        ...effective,
        env: {
          ...effective.env,
          [FIXTURE_REGISTRY_ENV]: edge.registry,
          [FIXTURE_NODE_ENV]: edge.node,
        },
      };
      const command = rewritten ?? launch.command;
      // Even a throwing launch retains its pending edge: a partial platform
      // spawn must never become an invented no-child completion witness.
      return launch.arrayForm
        ? original(command, options)
        : original({ ...options, cmd: command });
    };
  Bun.spawn = wrap(
    nativeSpawn as (...args: unknown[]) => unknown,
  ) as typeof Bun.spawn;
  Bun.spawnSync = wrap(
    nativeSync as (...args: unknown[]) => unknown,
  ) as typeof Bun.spawnSync;
}

// The same statically imported module is the child bootstrap. Root test
// preloads have no inherited edge; injected child preloads acknowledge it
// before their program imports or executes fixture code.
acknowledgeTrackedFixture();
