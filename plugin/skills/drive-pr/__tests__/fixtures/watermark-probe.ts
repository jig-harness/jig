// Reads the final check-run watermark through a stub `gh` whose body is argv[3].
// Runs in its own process, so the PATH it changes is never the test runner's.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { writeFakeProgram } from "../../../../../lib/test-helpers/fake-program.ts";
import { headWatermark } from "../../scripts/lib/ci-hold-state.ts";

const dir = mkdtempSync(join(tmpdir(), "ci-hold-watermark-read-"));
try {
  writeFakeProgram(join(dir, "gh"), `#!/bin/sh\n${process.argv[3]}\n`);
  process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
  const read = await headWatermark(process.argv[2] ?? "", "before the unlabel");
  process.stdout.write(read.ok ? "ok" : read.failure.code);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
