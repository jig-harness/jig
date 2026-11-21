/**
 * The JavaScript lockfile names `package-manager.ts` detects, in the order
 * it checks them. Kept free of Node runtime imports so browser bundles that
 * reach `merge-ready.ts` do not pull in `node:fs` or `node:path`.
 */
export const LOCKFILE_NAMES = [
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
] as const;

export type LockfileName = (typeof LOCKFILE_NAMES)[number];
