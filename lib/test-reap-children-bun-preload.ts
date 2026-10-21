// Bun `[test] preload` adapter for test-reap-children.ts: as tests run,
// capture the identities of this process's descendants, and after the last
// test kill every descendant a test left running, captured ones init has
// since adopted included, and say so on stderr, because a leak is a test
// defect worth seeing even when the run passed. The capture runs after a
// test at most once per CAPTURE_INTERVAL_MS, so a suite of thousands of
// short tests does not read the process table thousands of times. A
// preload-scope `afterAll` runs once per test process (each `--parallel`
// worker loads the preloads), including when tests failed. It does not run
// when the process is killed by a signal (the same residual
// test-tmpdir-bun-preload.ts records), which a scheduled host sweep covers.
import { afterAll, afterEach } from "bun:test";
import {
  captureDescendants,
  reapSurvivingDescendants,
} from "./test-reap-children.ts";

const CAPTURE_INTERVAL_MS = 2_000;
const captured = new Map<string, { pid: number; start: string }>();
let lastCapture = 0;

afterEach(async () => {
  if (Date.now() - lastCapture < CAPTURE_INTERVAL_MS) return;
  lastCapture = Date.now();
  for (const identity of (await captureDescendants(process.pid)) ?? [])
    captured.set(`${identity.pid}:${identity.start}`, identity);
});

afterAll(async () => {
  const report = await reapSurvivingDescendants(process.pid, {}, [
    ...captured.values(),
  ]);
  if (report === null) {
    console.error(
      "test-reap: the process table could not be read; processes a test left running were not reaped",
    );
    return;
  }
  if (report.signalled.length)
    console.error(
      `test-reap: killed ${report.signalled.length} process(es) a test left running (pid ${report.signalled.join(", ")})`,
    );
  if (report.unreadable.length)
    console.error(
      `test-reap: left ${report.unreadable.length} process(es) a test left running, whose identity could not be read (pid ${report.unreadable.join(", ")})`,
    );
  if (report.survived.length)
    console.error(
      `test-reap: ${report.survived.length} process(es) a test left running could not be confirmed stopped (pid ${report.survived.join(", ")})`,
    );
});
