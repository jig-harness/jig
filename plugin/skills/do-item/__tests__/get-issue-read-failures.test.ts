import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

it("keeps credential failure distinct from absence in the CLI JSON", () => {
  const bin = mkdtempSync(join(tmpdir(), "get-issue-failure-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !key.startsWith("GIT_") &&
        !["LINEAR_API_KEY", "LINEAR_API_TOKEN"].includes(key),
    ),
  );
  const run = (payload: unknown) => {
    writeFakeProgram(
      join(bin, "linear"),
      `#!/usr/bin/env bun\nconsole.log(${JSON.stringify(JSON.stringify(payload))});\n`,
    );
    const child = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../scripts/get_issue.ts"),
        "ENG-1",
        "--verbose",
      ],
      {
        env: {
          ...env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          JIG_OVERLAY: join(import.meta.dir, "fixtures/overlay.yaml"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(child, 2, "absent or unreadable issue");
    return {
      json: JSON.parse(child.stdout.toString()),
      stderr: child.stderr.toString(),
    };
  };
  try {
    const refused = run({
      errors: [{ message: "Invalid API key" }],
      data: null,
    });
    expect(refused.json.reason).toBe("read-failed");
    expect(refused.json.error).toContain("could not be read");
    expect(refused.json).not.toHaveProperty("suggestions");
    expect(refused.stderr).not.toContain("Not found:");
    const missing = run({ data: { issue: null } });
    expect(missing.json.reason).toBe("not-found");
    expect(missing.json).toHaveProperty("suggestions");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
