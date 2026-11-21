import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The command line the vendoring scripts share: with no argument, write each
 * vendored file under `vendorDir`; with `--check`, exit 1 naming each file
 * that differs from a fresh build.
 */
export function vendorMain(
  args: string[],
  root: string,
  vendorDir: string,
  command: string,
  build: () => Record<string, string>,
): number {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error(`Usage: ${command} [--check]`);
    return 2;
  }
  const files = build();
  if (args[0] !== "--check") {
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(root, vendorDir, name), content);
    return 0;
  }
  const stale = Object.entries(files)
    .map(([name, content]) => ({ path: `${vendorDir}/${name}`, content }))
    .filter(
      ({ path, content }) =>
        !existsSync(join(root, path)) ||
        readFileSync(join(root, path), "utf8") !== content,
    )
    .map(({ path }) => path);
  for (const path of stale)
    console.error(`${path} differs from a fresh build; run ${command}`);
  return stale.length === 0 ? 0 : 1;
}
