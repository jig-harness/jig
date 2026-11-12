import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { captureOutput, DRAIN_GRACE_MS } from "./capture-output.ts";

const root = mkdtempSync(join(tmpdir(), "jig-capture-output-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The command writes a line, starts a descendant that inherits its standard
// error and outlives it, and exits 3.
const script = `
  console.error("closing summary");
  Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, ${DRAIN_GRACE_MS * 4})"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });
  process.exit(3);
`;

test("a descendant that keeps standard error open does not hold the capture", async () => {
  const tailFile = join(root, "tail.txt");
  const started = Date.now();
  const status = await captureOutput([
    tailFile,
    process.execPath,
    "-e",
    script,
  ]);
  expect(status).toBe(3);
  expect(Date.now() - started).toBeLessThan(DRAIN_GRACE_MS * 3);
  expect(readFileSync(tailFile, "utf8")).toContain("closing summary");
});

test("the wrapper process exits while a descendant still holds standard error", async () => {
  const tailFile = join(root, "tail-cli.txt");
  const started = Date.now();
  const child = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "capture-output.ts"),
      tailFile,
      process.execPath,
      "-e",
      script,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(child, 3);
  expect(Date.now() - started).toBeLessThan(DRAIN_GRACE_MS * 3);
  expect(readFileSync(tailFile, "utf8")).toContain("closing summary");
});
