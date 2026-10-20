import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Discover phase modules instead of keeping a list that can silently omit an extraction. */
export function driverSourceFiles(scriptsDir: string): string[] {
  const directory = join(scriptsDir, "lib", "driver");
  return [
    join(scriptsDir, "drive.ts"),
    ...readdirSync(directory, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".ts"))
      .sort()
      .map((path) => join(directory, path)),
  ];
}
