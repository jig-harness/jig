import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST = "groundwork-release.json";
export interface FileRecord {
  path: string;
  digest: string;
  executable: boolean;
}
export interface Manifest {
  schema: 1;
  version: string;
  files: FileRecord[];
}
export const digest = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
/** Names Windows cannot keep as written: device names, and trailing dots or spaces. */
export const windowsUnsafeName = (name: string): boolean =>
  /^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³])(?:\..*)?$/i.test(name) ||
  /[. ]$/.test(name);
export function safePath(path: string): void {
  if (
    !path ||
    /[\\:<>"|?*]/.test(path) ||
    [...path].some((char) => char.charCodeAt(0) < 32) ||
    path
      .split("/")
      .some((p) => !p || p === "." || p === ".." || windowsUnsafeName(p))
  )
    throw new Error(`unsafe release path: ${path}`);
}
export function record(root: string, path: string): FileRecord {
  const file = join(root, path),
    stat = lstatSync(file);
  if (!stat.isFile()) throw new Error(`not a regular file: ${file}`);
  return {
    path,
    digest: digest(readFileSync(file)),
    executable: Boolean(stat.mode & 0o111),
  };
}
/** Source paths under skills/ that are never shipped in a release. */
export const releaseExcluded = (path: string): boolean =>
  path.split("/").some((part) => ["fixtures", "node_modules"].includes(part)) ||
  path.endsWith(".test.ts");
/** `skip` prunes paths (relative to root) before they are validated or entered. */
export function inventory(
  root: string,
  skip?: (path: string) => boolean,
  /** The manifest filename is only special at a release root, not inside a copied skill. */
  includeManifest = false,
): FileRecord[] {
  const files: FileRecord[] = [];
  function visit(prefix: string): void {
    for (const entry of readdirSync(join(root, prefix), {
      withFileTypes: true,
    })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (skip?.(path)) continue;
      safePath(path);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        if (includeManifest || path !== MANIFEST)
          files.push(record(root, path));
      } else
        throw new Error(`release contains a link or special file: ${path}`);
    }
  }
  visit("");
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
/**
 * Case-insensitive hosts merge directories that differ only by case and cannot
 * hold a file and a directory of one name, so reject both in directory prefixes.
 */
function rejectFoldedConflicts(paths: string[]): void {
  const spelling = new Map<string, string>(),
    files = new Set([MANIFEST, ...paths].map((path) => path.toLowerCase()));
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/"),
        key = dir.toLowerCase();
      if (files.has(key) || (spelling.get(key) ?? dir) !== dir)
        throw new Error(`invalid manifest record: ${path}`);
      spelling.set(key, dir);
    }
  }
}
export function verify(root: string, expectedDigest?: string): Manifest {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new Error("release root must be a real directory");
  const file = join(root, MANIFEST);
  const manifestStat = lstatSync(file);
  if (!manifestStat.isFile())
    throw new Error("manifest must be a regular file");
  if (process.platform !== "win32" && manifestStat.mode & 0o111)
    throw new Error("manifest must not be executable");
  const bytes = readFileSync(file);
  if (expectedDigest && digest(bytes) !== expectedDigest)
    throw new Error("release manifest digest mismatch");
  const manifest = JSON.parse(bytes.toString()) as Manifest;
  if (
    manifest.schema !== 1 ||
    typeof manifest.version !== "string" ||
    !Array.isArray(manifest.files)
  )
    throw new Error("invalid release manifest");
  const names = new Set<string>();
  for (const file of manifest.files) {
    safePath(file.path);
    const key = file.path.toLowerCase();
    if (
      names.has(key) ||
      key === MANIFEST.toLowerCase() ||
      !/^[a-f0-9]{64}$/.test(file.digest) ||
      typeof file.executable !== "boolean"
    )
      throw new Error(`invalid manifest record: ${file.path}`);
    names.add(key);
  }
  rejectFoldedConflicts(manifest.files.map((file) => file.path));
  const actual = inventory(root);
  if (actual.length !== manifest.files.length)
    throw new Error("release file set changed");
  const byPath = new Map(actual.map((file) => [file.path, file]));
  for (const expected of manifest.files) {
    const found = byPath.get(expected.path);
    // Windows has no POSIX executable bit; content and type remain enforced.
    if (
      !found ||
      found.digest !== expected.digest ||
      (process.platform !== "win32" && found.executable !== expected.executable)
    )
      throw new Error(`release integrity mismatch: ${expected.path}`);
  }
  return manifest;
}
