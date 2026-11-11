// Bun `[test] preload` adapter for the temp-dir scope. `bun test` runs as a
// single process (no per-file worker pool), so this fires exactly once, before
// any test executes. See test-tmpdir.ts for what the scope does and why. A
// consumer that needs different names writes its own three-line adapter
// passing options to `scopeTestTmpdir`.
//
// Order it AFTER any preload that can refuse the run outright with
// `process.exit`: a refused run should not have created a directory to clean
// up.
//
// Teardown is a preload-scope `afterAll`, NOT `process.on("exit")`: an `exit`
// handler registered from a preload does not run at all when the runner is
// `bun test` (it does under plain `bun`), so the obvious spelling cleans up
// nothing and looks like it works. A preload-scope `afterAll` runs once after
// the last test file, including when tests failed.
//
// `bun test --watch` reuses one process across file-change cycles, but Bun
// re-evaluates this entire preload module, top-level code included, on every
// cycle, so a fresh root is created before each cycle's tests run.
// test-tmpdir-bun-preload.test.ts pins that behavior.
//
// Deliberate residual: no teardown hook runs when the process is killed by a
// signal, so a suite torn down by a CI timeout or a deadman leaves its root
// behind. That is one prefixed directory tree per killed run, which an
// registered collector reports with its owner record. Installing SIGINT/SIGTERM handlers here
// would change Ctrl-C semantics for every test process to reclaim that
// remainder, which is not a trade worth making.
//
// Bun caches the transpiled output of large source files under the home
// directory. Many fixtures start a child with a fake home inside the scope,
// and each such child rebuilt that cache there: hundreds of files per start,
// most of the dispatch suite's scratch, on a shared /tmp whose inode table
// runs out. Children that inherit this environment share one cache under the
// real home instead, set before the scope so a run that already chose a cache
// keeps it.
import { afterAll } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { scopeTestTmpdir } from "./test-tmpdir.ts";

process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ??= join(
  homedir(),
  ".bun",
  "install",
  "cache",
  "@t@",
);
const scope = scopeTestTmpdir();
afterAll(() => scope.release());
