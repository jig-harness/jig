import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
const script = new URL("check-external-preconditions.ts", import.meta.url)
  .pathname;
const registry = new URL("fixtures/registry.yaml", import.meta.url).pathname;
const input = new URL("fixtures/protection.json", import.meta.url).pathname;
const spawn = (...args: string[]) =>
  Bun.spawnSync([process.execPath, script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
test("offline CLI emits machine-readable success without git context", () => {
  const result = spawn("--registry", registry, "--input", input, "--json");
  expectSpawnExit(result, 0);
  expect(JSON.parse(result.stdout.toString()).entries[0].outcome).toBe("pass");
});
test("pending fixture exits nonzero with owner and remediation", () => {
  const dir = mkdtempSync(join(tmpdir(), "external-preconditions-"));
  try {
    const pending = join(dir, "registry.yaml");
    writeFileSync(
      pending,
      readFileSync(registry, "utf8").replace("state: active", "state: pending"),
    );
    const result = spawn("--registry", pending, "--input", input);
    expectSpawnExit(result, 1);
    expect(result.stdout.toString()).toContain("PENDING verified-branch");
    expect(result.stdout.toString()).toContain(
      "owner: repository-administrators",
    );
    expect(result.stdout.toString()).toContain("Remediation:");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("CLI rejects clock override in live mode and invalid calendar timestamps", () => {
  expectSpawnExit(
    spawn("--registry", registry, "--now", "2026-10-20T00:00:00.000Z"),
    2,
  );
  expectSpawnExit(
    spawn(
      "--registry",
      registry,
      "--input",
      input,
      "--now",
      "2026-02-30T00:00:00.000Z",
    ),
    2,
  );
  expectSpawnExit(spawn("--registry", registry, "--unknown"), 2);
});
