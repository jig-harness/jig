import { test, expect } from "bun:test";
import { join } from "node:path";
import cases from "./cases.json";
for (const [want, label, filter, catalog] of cases) {
  test(String(label), () => {
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "check-catalog-regex-sync.ts")],
      {
        env: {
          ...process.env,
          FILTER_FILE: join(import.meta.dir, "fixtures", String(filter)),
          CATALOG: join(import.meta.dir, "fixtures", String(catalog)),
          RE_VAR: "CODE_PATH_RE",
        },
      },
    );
    expect(result.exitCode).toBe(Number(want));
  });
}
