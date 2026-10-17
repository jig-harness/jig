import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestVersion, pluginVersion } from "../plugin-version.ts";

const root = join(import.meta.dir, "..", "..");

test("the version is the one the plugin's manifest names", () => {
  const manifest: unknown = JSON.parse(
    readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"),
  );
  expect(pluginVersion()).toMatch(/^\d+\.\d+\.\d+/);
  expect(manifest).toMatchObject({ version: pluginVersion() });
});

test("either manifest names it, and a folder with neither names none", () => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-version-"));
  try {
    expect(manifestVersion(dir)).toBeNull();
    mkdirSync(join(dir, ".codex-plugin"));
    writeFileSync(
      join(dir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ version: "1.2.3" }),
    );
    expect(manifestVersion(dir)).toBe("1.2.3");
    mkdirSync(join(dir, ".claude-plugin"));
    writeFileSync(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ version: "2.0.0" }),
    );
    expect(manifestVersion(dir)).toBe("2.0.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
