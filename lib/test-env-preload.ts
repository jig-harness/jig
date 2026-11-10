// Bun `[test] preload`: spells the search path variable `PATH` in every test
// process, so a test's own `PATH` override is the one a child reads on Windows
// (see test-env.ts). Children inherit it. Also records whether a test is
// running, which exceptOnWindows and byPlatform
// (test-helpers/windows-skip.ts) require.
//
// Removes `GITHUB_ACTIONS`, so no test runs a check as a GitHub Actions job
// because the suite itself runs in one: a check called in-process with a
// failing fixture would print its findings as workflow commands, and the
// runner would show each as an annotation of the real run. A test of the
// annotations sets the variable itself.
//
// Removes Orca's `ORCA_CLI_COMMAND` and `ORCA_CLI_BIN_DIR` for the same
// reason: a suite run in a terminal Orca opened would otherwise reach the real
// Orca from every drive a test runs, and could move a real workspace card. A
// test of the Orca calls sets the variables itself.
//
// Removes the repository-routing variables a git hook may export from the
// environment tests pass to children. scripts/test.ts also scrubs before
// launching Bun: Bun's implicit child environment retains startup values.
import { afterEach, beforeEach } from "bun:test";
import { LEAKY_GIT_ENV } from "../plugin/shared/guarded-git-spawn.ts";
import { markRunningTests } from "./test-helpers/windows-skip.ts";
import { normalizePathKey } from "./test-env.ts";

if (process.platform === "win32") normalizePathKey(process.env);
for (const key of Object.keys(process.env))
  if (LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()))
    delete process.env[key];
delete process.env.GITHUB_ACTIONS;
delete process.env.ORCA_CLI_COMMAND;
delete process.env.ORCA_CLI_BIN_DIR;
markRunningTests(beforeEach, afterEach);
