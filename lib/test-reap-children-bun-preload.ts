// Bun `[test] preload` adapter for test-reap-children.ts: after the last test
// in this process, kill every descendant a test left running, and say so on
// stderr, because a leak is a test defect worth seeing even when the run
// passed. A preload-scope `afterAll` runs once per test process (each
// `--parallel` worker loads the preloads), including when tests failed. It
// does not run when the process is killed by a signal (the same residual
// test-tmpdir-bun-preload.ts records), which a scheduled host sweep covers.
import { afterAll } from "bun:test";
import { reapSurvivingDescendants } from "./test-reap-children.ts";

afterAll(async () => {
  const report = await reapSurvivingDescendants(process.pid);
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
});
