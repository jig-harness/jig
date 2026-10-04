import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Preserve the small scalar grammar used by the reference schema and docs. */
export function frontmatterValue(text: string, key: string): string {
  const lines = text.split("\n");
  if (!/^---\s*$/.test(lines[0] ?? "")) return "";
  for (const line of lines.slice(1)) {
    if (/^---\s*$/.test(line)) break;
    if (line.startsWith(`${key}:`) && /^\s/.test(line.slice(key.length + 1))) {
      return line
        .slice(key.length + 1)
        .trimStart()
        .replace(/^["']/, "")
        .replace(/["']\s*$/, "");
    }
  }
  return "";
}
export function markdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...markdownFiles(path));
    else if (entry.name.endsWith(".md")) result.push(path);
  }
  return result;
}
export function readDocument(file: string): string {
  if (!existsSync(file) || !statSync(file).isFile())
    throw new Error(`not a file: ${file}`);
  return readFileSync(file, "utf8");
}
export function cli(action: () => number): void {
  try {
    process.exitCode = action();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
