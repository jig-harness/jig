/** The committed JSON is formatted with the repository's pinned development formatter. */
import { join } from "node:path";
import { Defect } from "../../plugin/shared/errors.ts";

const root = join(import.meta.dir, "..", "..");
const formatted = new Map<string, string>();

/** Format generated JSON, including scalar arrays, before it is written or staged. */
export function jsonText(value: unknown): string {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  const cached = formatted.get(raw);
  if (cached !== undefined) return cached;
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(root, "node_modules", "@biomejs", "biome", "bin", "biome"),
      "format",
      "--stdin-file-path=plugin/protocol/schemas/shape.json",
    ],
    {
      cwd: root,
      stdin: Buffer.from(raw),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
  if (result.exitCode !== 0)
    throw new Defect(
      `the Protocol's JSON formatter failed: ${result.stderr.toString().trim()}`,
    );
  const text = result.stdout.toString();
  formatted.set(raw, text);
  return text;
}
