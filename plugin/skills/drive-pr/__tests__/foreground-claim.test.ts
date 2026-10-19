import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimGenerationLauncher,
  ownsGenerationLauncher,
} from "../scripts/lib/foreground-claim.ts";
function withGeneration(body: (dir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "foreground-claim-"));
  const dir = join(root, "gen-1");
  mkdirSync(dir);
  try {
    body(dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test("exclusive launcher creation never overwrites a replacement capability", () =>
  withGeneration((dir) => {
    const file = join(dir, "launcher.pid");
    writeFileSync(file, "foreign-owner\n");
    expect(claimGenerationLauncher(dir, process.pid)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("foreign-owner\n");
  }));
test("a lost or replaced reservation cannot exempt its old launcher from admission", () =>
  withGeneration((dir) => {
    expect(claimGenerationLauncher(dir, process.pid)).toBe(true);
    expect(ownsGenerationLauncher(dir, process.pid)).toBe(true);
    const file = join(dir, "launcher.pid");
    rmSync(file);
    writeFileSync(file, "replacement-owner\n");
    expect(ownsGenerationLauncher(dir, process.pid)).toBe(false);
    expect(claimGenerationLauncher(dir, process.pid)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("replacement-owner\n");
  }));
test("a removed claim is refused without recreating it", () =>
  withGeneration((dir) => {
    rmSync(dir, { recursive: true });
    expect(claimGenerationLauncher(dir, process.pid)).toBe(false);
    expect(ownsGenerationLauncher(dir, process.pid)).toBe(false);
  }));
test("an unreadable capability is an error rather than permission to reuse its reservation", () =>
  withGeneration((dir) => {
    mkdirSync(join(dir, "launcher.pid"));
    expect(() => ownsGenerationLauncher(dir, process.pid)).toThrow();
    expect(claimGenerationLauncher(dir, process.pid)).toBe(false);
  }));
