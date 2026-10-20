import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverSourceFiles } from "./terminal-state-source-files.ts";
import {
  closeTypeScriptService,
  findBareLiteralExits,
} from "./terminal-states-consistency.ts";

afterAll(closeTypeScriptService);

test("the terminal-state scan discovers a newly extracted phase and its nested helper", async () => {
  const scripts = mkdtempSync(join(tmpdir(), "drive-terminal-source-layout-"));
  try {
    const phases = join(scripts, "lib", "driver");
    const nested = join(phases, "checks");
    mkdirSync(nested, { recursive: true });
    const entry = join(scripts, "drive.ts");
    const phase = join(phases, "another-phase.ts");
    const helper = join(nested, "final-check.ts");
    writeFileSync(entry, "export {};\n");
    writeFileSync(
      phase,
      "export function phase() { return WORKTREE_UNCLEAN_EXIT; }\n",
    );
    writeFileSync(
      helper,
      "export function finalCheck() { return STALLED_EXIT; }\n",
    );
    const paths = driverSourceFiles(scripts);
    expect(paths).toEqual([entry, phase, helper]);
    for (const path of paths) {
      expect(
        await findBareLiteralExits(await Bun.file(path).text(), path),
      ).toEqual([]);
    }
    // A regression in either extracted module must remain visible to the scan.
    for (const [path, code] of [
      [phase, 12],
      [helper, 14],
    ] as const) {
      writeFileSync(path, `export function phase() { return ${code}; }\n`);
      const mismatches = await findBareLiteralExits(
        await Bun.file(path).text(),
        path,
      );
      expect(mismatches.map((mismatch) => mismatch.value)).toEqual([code]);
    }
  } finally {
    rmSync(scripts, { recursive: true, force: true });
  }
});
