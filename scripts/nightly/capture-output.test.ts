import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, DRAIN_GRACE_MS } from "./capture-output.ts";

const root = mkdtempSync(join(tmpdir(), "jig-capture-output-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a descendant that keeps standard error open does not hold the capture", async () => {
  const tailFile = join(root, "tail.txt");
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
