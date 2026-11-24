/**
 * The package manager a repository uses, from its lockfile, with the commands
 * that install exactly what the lockfile records and that rewrite it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JigError } from "../errors.ts";
import { LOCKFILE_NAMES, type LockfileName } from "./lockfiles.ts";

export interface PackageManager {
  name: string;
  lockfile: string;
  /** Install exactly what the lockfile records; fails when it is stale. */
  install: string;
  /** Install and rewrite the lockfile to match the manifests. */
  relock: string;
}

/** Package manager commands for each lockfile in `LOCKFILE_NAMES`. */
const MANAGER_FOR: Record<
  LockfileName,
  (root: string) => Omit<PackageManager, "lockfile">
> = {
  "bun.lock": () => ({
    name: "bun",
    install: "bun install --frozen-lockfile",
    relock: "bun install",
  }),
  "bun.lockb": () => ({
    name: "bun",
    install: "bun install --frozen-lockfile",
    relock: "bun install",
  }),
  "pnpm-lock.yaml": () => ({
    name: "pnpm",
    install: "pnpm install --frozen-lockfile",
    relock: "pnpm install",
  }),
  // Yarn 2 and later keep their settings in .yarnrc.yml and renamed the
  // frozen-install flag.
  "yarn.lock": (root) => ({
    name: "yarn",
    install: existsSync(join(root, ".yarnrc.yml"))
      ? "yarn install --immutable"
      : "yarn install --frozen-lockfile",
    relock: "yarn install",
  }),
  "package-lock.json": () => ({
    name: "npm",
    install: "npm ci",
    relock: "npm install",
  }),
  "npm-shrinkwrap.json": () => ({
    name: "npm",
    install: "npm ci",
    relock: "npm install",
  }),
};

/** Lockfiles in the order they are checked; the first present one wins. */
const LOCKFILES: [
  LockfileName,
  (root: string) => Omit<PackageManager, "lockfile">,
][] = LOCKFILE_NAMES.map((name) => [name, MANAGER_FOR[name]]);

/**
 * The package manager `package.json` declares in its `packageManager` field
 * (`pnpm@10.1.0` → `pnpm`), or null when it declares none or cannot be read.
 */
function declaredManager(
  root: string,
  requireReadable: boolean,
): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { packageManager?: unknown };
    if (typeof manifest.packageManager !== "string") return null;
    return manifest.packageManager.split("@")[0]?.trim() || null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (requireReadable && code !== "ENOENT")
      throw new JigError(
        "config-invalid",
        `cannot choose a lockfile in ${root}: package.json is ${code ?? "invalid JSON"}`,
      );
    return null;
  }
}

/**
 * The package manager named by the repository's lockfile, or null. When
 * several lockfiles are present (a repository that uses one manager and keeps
 * another's lockfile for a tool), the one `package.json` declares in
 * `packageManager` wins; otherwise the first in `LOCKFILES` order.
 */
export function detectPackageManager(
  root: string,
  /** When acting on a git tree, consider only that tree's lockfiles. */
  lockfiles?: ReadonlySet<string>,
): {
  found: PackageManager | null;
  others: string[];
} {
  const present = LOCKFILES.filter(
    ([file]) => lockfiles?.has(file) ?? existsSync(join(root, file)),
  );
  const declared = declaredManager(
    root,
    lockfiles !== undefined && present.length > 1,
  );
  const preferred = present.findIndex(
    ([, manager]) => manager(root).name === declared,
  );
  if (preferred > 0) present.unshift(...present.splice(preferred, 1));
  const first = present[0];
  if (first === undefined) return { found: null, others: [] };
  return {
    found: { lockfile: first[0], ...first[1](root) },
    others: present.slice(1).map(([file]) => file),
  };
}
