import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cli } from "../../lib/cli.ts";
import {
  digest,
  inventory,
  MANIFEST,
  type Manifest,
  releaseExcluded,
  verify,
} from "./integrity.ts";

/** Importable support modules: preserve paths and their relative imports. */
export const sharedHelpers = [
  "lib/guarded-git-spawn.ts",
  "lib/test-helpers/expect-spawn-exit.ts",
  "lib/test-tmpdir.ts",
  "lib/test-tmpdir-bun-preload.ts",
] as const;

/** Public imports used by sibling skills; bundle dependencies into each export. */
export const skillExports = new Set([
  "resolve-review-comments/scripts/lib/ladder.ts",
  "resolve-review-comments/scripts/lib/proc.ts",
  "resolve-review-comments/scripts/lib/gh-conditional.ts",
]);

/**
 * Build a self-contained payload. Existing output is refused to avoid stale
 * files. The payload is assembled beside the output and renamed into place only
 * after its manifest verifies, so a failure leaves nothing behind.
 */
export async function release(
  source: string,
  output: string,
  version: string,
): Promise<string> {
  source = resolve(source);
  output = resolve(output);
  if (existsSync(output))
    throw new Error(`release output already exists: ${output}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version))
    throw new Error("invalid release version");
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(`${output}.partial-`);
  try {
    const sum = await build(source, staging, version);
    renameSync(staging, output);
    return sum;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function build(
  source: string,
  output: string,
  version: string,
): Promise<string> {
  // The runtime pin is part of the contract: consumers run the payload with it.
  if (!existsSync(join(source, "mise.toml")))
    throw new Error(`release source needs mise.toml: ${source}`);
  copyFileSync(join(source, "mise.toml"), join(output, "mise.toml"));
  // These helpers depend only on the native runtime and each other. Unlike
  // skill commands, consumers import them, including from a test preload.
  // Minimal skill-only sources may omit lib/; a partial helper set is invalid.
  if (existsSync(join(source, "lib")))
    for (const path of sharedHelpers) {
      const to = join(output, path);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(source, path), to);
      chmodSync(to, 0o644);
    }
  const entries: string[] = [];
  // Supporting TypeScript modules are inlined into entry points, never shipped as duplicate sources.
  if (existsSync(join(source, "skills"))) {
    for (const file of inventory(join(source, "skills"), releaseExcluded)) {
      const from = join(source, "skills", file.path),
        to = join(output, "skills", file.path);
      if (file.path.endsWith(".ts")) {
        if (
          skillExports.has(file.path) ||
          /\bif\s*\(\s*(?:import\.meta\.main|isEntryPoint\s*\()|^\s*runMain\s*\(/m.test(
            readFileSync(from, "utf8"),
          )
        )
          entries.push(from);
        continue;
      }
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      chmodSync(to, file.executable ? 0o755 : 0o644);
    }
  }
  // Keep the original .ts path: existing procedures invoke bun scripts/name.ts.
  for (const entry of entries) {
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      packages: "bundle",
      splitting: false,
      plugins: [
        {
          name: "entrypoint-guards",
          setup(build) {
            build.onLoad({ filter: /\.ts$/ }, (args) => {
              if (resolve(args.path) === resolve(entry)) return undefined;
              // Bundling makes import.meta.url the entry's URL in every module.
              // Imported command modules must retain their original non-main state.
              const text = readFileSync(args.path, "utf8").replace(
                /\bisEntryPoint\s*\(\s*import\.meta\.url\s*\)|\bimport\.meta\.main/g,
                "false",
              );
              return { contents: text, loader: "ts" };
            });
          },
        },
      ],
    });
    const [built] = result.outputs;
    if (!result.success || result.outputs.length !== 1 || !built)
      throw new Error(`bundle failed: ${entry}: ${result.logs.join("\n")}`);
    const relative = entry.slice(source.length + 1),
      to = join(output, relative);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, await built.text());
    chmodSync(to, 0o755);
  }
  // The installer is shipped with the payload so restored caches can install offline.
  const installer = await Bun.build({
    entrypoints: [
      existsSync(join(source, "tools/install/install.ts"))
        ? join(source, "tools/install/install.ts")
        : join(import.meta.dir, "install.ts"),
    ],
    target: "bun",
    packages: "bundle",
    splitting: false,
  });
  const [builtInstaller] = installer.outputs;
  if (!installer.success || installer.outputs.length !== 1 || !builtInstaller)
    throw new Error(`installer bundle failed: ${installer.logs.join("\n")}`);
  mkdirSync(join(output, "tools"));
  writeFileSync(join(output, "tools/install.js"), await builtInstaller.text());
  const manifest: Manifest = { schema: 1, version, files: inventory(output) };
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(output, MANIFEST), bytes);
  chmodSync(join(output, MANIFEST), 0o644);
  // Refuse to report success for a payload the installer would reject.
  const sum = digest(bytes);
  verify(output, sum);
  return sum;
}
if (import.meta.main)
  cli(async () => {
    const [source, output, version, ...extra] = process.argv.slice(2);
    if (!source || !output || !version || extra.length)
      throw new Error("usage: release.ts <source> <output> <version>");
    console.log(await release(source, output, version));
    return 0;
  });
