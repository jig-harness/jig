#!/usr/bin/env bun
/**
 * Vendors Drizzle, the object-relational mapper the hub's storage is
 * written with, into the plugin. The plugin runs from a copy with no
 * `node_modules` and Drizzle ships no single-file build, so this bundles the
 * parts the hub imports from the pinned package, with Bun's bundler and no
 * minification, in one build of two entries:
 *
 *   drizzle-entry.ts            the portable parts: SQLite's dialect, the
 *                               schema builders and the query operators
 *   drizzle-bun-sqlite-entry.ts the `bun:sqlite` driver and its migrator,
 *                               which only the process adapter imports
 *
 * The build splits the code both entries use into one shared chunk, so the
 * hub runs one copy of Drizzle whichever entry it reaches it through, and
 * only the driver's bundle imports `bun:sqlite`. It writes beside the
 * plugin's other vendored code:
 *
 *   plugin/shared/vendor/drizzle.mjs               the portable entry
 *   plugin/shared/vendor/drizzle-bun-sqlite.mjs    the driver's entry
 *   plugin/shared/vendor/drizzle-shared.mjs        the chunk both import
 *   plugin/shared/vendor/drizzle.d.mts             each entry's declarations:
 *   plugin/shared/vendor/drizzle-bun-sqlite.d.mts  the package's own types,
 *                                                  which the type check reads
 *                                                  from node_modules
 *
 * The package ships no licence file, so `plugin/shared/vendor/drizzle.LICENSE`
 * is the licence from Drizzle's repository at the pinned version's tag, kept
 * by hand; the check confirms the package still declares that licence.
 *
 * Usage:
 *   bun tools/plugin/vendor-drizzle.ts           write the five files
 *   bun tools/plugin/vendor-drizzle.ts --check   exit 1 naming each file that
 *                                                differs from a fresh build
 *
 * The bundle is what the pinned Bun writes for the pinned package, so an
 * update of either is followed by a run of this script.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cli } from "../../lib/cli.ts";

const ROOT = resolve(import.meta.dir, "../..");
const PACKAGE = "node_modules/drizzle-orm";
const VENDOR_DIR = "plugin/shared/vendor";
const COMMAND = "bun tools/plugin/vendor-drizzle.ts";
/** The licence the package declares, which drizzle.LICENSE holds. */
const LICENCE = "Apache-2.0";
const LICENCE_FILE = "drizzle.LICENSE";

/** Each entry, the file the build writes for it, and the name its bundle and declarations go by. */
const ENTRIES = [
  {
    entry: "tools/plugin/drizzle-entry.ts",
    built: "drizzle-entry.mjs",
    name: "drizzle",
  },
  {
    entry: "tools/plugin/drizzle-bun-sqlite-entry.ts",
    built: "drizzle-bun-sqlite-entry.mjs",
    name: "drizzle-bun-sqlite",
  },
] as const;
/** The one chunk the entries share, named so the entries' imports of it stay stable. */
const CHUNK = "drizzle-shared.mjs";

/** A bundle that could not be built; the message says why. */
class VendorError extends Error {
  override name = "VendorError";
}

function packageField(field: string): string {
  const manifest: unknown = JSON.parse(
    readFileSync(join(ROOT, PACKAGE, "package.json"), "utf8"),
  );
  const value =
    typeof manifest === "object" && manifest !== null && field in manifest
      ? (manifest as Record<string, unknown>)[field]
      : undefined;
  if (typeof value !== "string")
    throw new VendorError(`${PACKAGE}/package.json names no ${field}`);
  return value;
}

/**
 * Bun's bundle of both entries, by output name. The bundler names each
 * module's source path relative to its working directory in a comment, so
 * it runs from the repository root wherever this is called from. An entry's
 * bundle is written as `<entry file name>.mjs` and renamed here; nothing
 * imports an entry, so the rename changes no import.
 */
function bundles(banner: string): Record<string, string> {
  const scratch = mkdtempSync(join(tmpdir(), "vendor-drizzle-"));
  try {
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        ...ENTRIES.map((e) => e.entry),
        "--target=bun",
        "--format=esm",
        "--splitting",
        "--entry-naming=[name].mjs",
        `--chunk-naming=${CHUNK}`,
        `--banner=${banner}`,
        `--outdir=${scratch}`,
      ],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    if (build.exitCode !== 0)
      throw new VendorError(
        `bun build failed (exit ${build.exitCode}):\n${build.stderr.toString()}`,
      );
    const written = readdirSync(scratch).sort();
    const expected = [...ENTRIES.map((e) => e.built), CHUNK].sort();
    if (written.join() !== expected.join())
      throw new VendorError(
        `bun build wrote ${written.join(", ")}, not ${expected.join(", ")}: a second shared chunk needs its own stable name here`,
      );
    const out: Record<string, string> = {
      [CHUNK]: readFileSync(join(scratch, CHUNK), "utf8"),
    };
    for (const { built, name } of ENTRIES)
      out[`${name}.mjs`] = readFileSync(join(scratch, built), "utf8");
    return out;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** An entry's export statements, which name the package's own types. */
function declarations(entry: string, bundle: string, version: string): string {
  const source = readFileSync(join(ROOT, entry), "utf8");
  const exports = source.slice(source.search(/^export /m));
  return `// Types for the vendored Drizzle ${version} bundle (${bundle}): the pinned
// package's own, read from node_modules when the repository is type-checked.
// Generated by \`${COMMAND}\`; do not edit.
${exports}`;
}

/** Each vendored file's name and the content a fresh build gives it. */
export function vendoredDrizzle(): Record<string, string> {
  const version = packageField("version");
  const licence = packageField("license");
  if (licence !== LICENCE)
    throw new VendorError(
      `${PACKAGE} now declares the licence ${licence}, not ${LICENCE}: replace ${VENDOR_DIR}/${LICENCE_FILE} with its licence and its NOTICE lines`,
    );
  const files = bundles(
    `// Drizzle (drizzle-orm) ${version}, Apache License 2.0 (${LICENCE_FILE}), bundled by \`${COMMAND}\`; do not edit.`,
  );
  for (const { entry, name } of ENTRIES)
    files[`${name}.d.mts`] = declarations(entry, `${name}.mjs`, version);
  return files;
}

function main(args: string[]): number {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error(`Usage: ${COMMAND} [--check]`);
    return 2;
  }
  const files = vendoredDrizzle();
  if (args[0] !== "--check") {
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(ROOT, VENDOR_DIR, name), content);
    return 0;
  }
  const stale = Object.entries(files)
    .map(([name, content]) => ({ path: `${VENDOR_DIR}/${name}`, content }))
    .filter(
      ({ path, content }) =>
        !existsSync(join(ROOT, path)) ||
        readFileSync(join(ROOT, path), "utf8") !== content,
    )
    .map(({ path }) => path);
  for (const path of stale)
    console.error(`${path} differs from a fresh build; run ${COMMAND}`);
  return stale.length === 0 ? 0 : 1;
}

if (import.meta.main) cli(() => main(process.argv.slice(2)));
