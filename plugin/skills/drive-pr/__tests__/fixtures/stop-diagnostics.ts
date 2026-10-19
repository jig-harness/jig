import { mock } from "bun:test";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import * as tableModule from "../../../../shared/process-table.ts";
import * as registryModule from "../../../../shared/process-registry.ts";

if (process.env.NODE_ENV === "test") {
  const table = tableModule.processTable;
  const registry = registryModule.processRegistrySnapshot;
  let probes = 0;
  let registries = 0;
  mock.module(
    fileURLToPath(
      new URL("../../../../shared/process-table.ts", import.meta.url),
    ),
    () => ({
      ...tableModule,
      processTable: async (timeoutSec?: number) => {
        const started = Date.now();
        const rows = await table(timeoutSec);
        if (probes++ < 100)
          console.error(
            "stop-test process-table",
            JSON.stringify({
              elapsedMs: Date.now() - started,
              timeoutSec,
              rows:
                rows
                  ?.filter(
                    (row) =>
                      row.pid === process.pid ||
                      row.ppid === process.pid ||
                      row.args.includes("running-pass"),
                  )
                  .map((row) => ({
                    pid: row.pid,
                    ppid: row.ppid,
                    start: row.start,
                    stat: row.stat,
                    role: row.args.includes("running-pass")
                      ? "pass"
                      : row.pid === process.pid
                        ? "driver"
                        : "helper",
                  })) ?? null,
            }),
          );
        return rows;
      },
    }),
  );
  mock.module(
    fileURLToPath(
      new URL("../../../../shared/process-registry.ts", import.meta.url),
    ),
    () => ({
      ...registryModule,
      processRegistrySnapshot: (dir: string, ignoreMarker?: string) => {
        const snapshot = registry(dir, ignoreMarker);
        if (
          (ignoreMarker !== undefined || !snapshot.complete) &&
          registries++ < 100
        ) {
          let files: string[] | null = null;
          try {
            files = readdirSync(dir);
          } catch {
            /* An unreadable scope is part of the diagnostic. */
          }
          console.error(
            "stop-test registry",
            JSON.stringify({
              dir,
              ignoreMarker,
              files,
              complete: snapshot.complete,
              roots: snapshot.roots.map(({ pid, start }) => ({ pid, start })),
            }),
          );
        }
        return snapshot;
      },
    }),
  );
}
