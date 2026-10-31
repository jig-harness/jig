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
import { afterEach, beforeEach } from "bun:test";
import { markRunningTests } from "./test-helpers/windows-skip.ts";
import { normalizePathKey } from "./test-env.ts";

if (process.platform === "win32") normalizePathKey(process.env);
delete process.env.GITHUB_ACTIONS;
markRunningTests(beforeEach, afterEach);
