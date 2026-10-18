// Bun `[test] preload`: spells the search path variable `PATH` in every test
// process, so a test's own `PATH` override is the one a child reads on Windows
// (see test-env.ts). Children inherit it. Also records whether a test is
// running, which exceptOnWindows and byPlatform
// (test-helpers/windows-skip.ts) require.
import { afterEach, beforeEach } from "bun:test";
import { markRunningTests } from "./test-helpers/windows-skip.ts";
import { normalizePathKey } from "./test-env.ts";

if (process.platform === "win32") normalizePathKey(process.env);
markRunningTests(beforeEach, afterEach);
