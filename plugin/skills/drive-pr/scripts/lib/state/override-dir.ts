/** Overrides relocate the state root while preserving clone isolation. */
import { readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fail } from "../cli.ts";
import { classifyArtifactName } from "./artifacts.ts";
import { cloneKey, peekCloneKey } from "./clone-key.ts";

/** An already-resolved clone directory is idempotent for inherited passes. */
export function scopedOverrideDir(
  root: string,
  commonDir: string,
  readOnly = false,
): string {
  const key = readOnly ? peekCloneKey(commonDir) : cloneKey(commonDir);
  const absolute = resolve(root);
  if (key !== null && basename(absolute) === key) return absolute;
  // Never start a fresh history beside a flat history whose owner is unknown.
  // The old schema did not record a repository, so even valid JSON is no proof
  // that it is safe to migrate. Locks and leases must be accounted for too.
  let names: string[];
  try {
    names = readdirSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    names = [];
  }
  const flat = names.find(
    (name) => classifyArtifactName(absolute, name).category !== "unrelated",
  );
  if (flat !== undefined) {
    fail(
      2,
      `drive-state.ts: unscoped state artifact at ${join(absolute, flat)}`,
      `Current clone: ${commonDir}; legacy repository: unknown (the old format has no repository binding).`,
      key === null
        ? "Clone key is not initialized yet (read-only inspection)."
        : `Expected clone directory: ${join(absolute, key)}`,
      "Refusing to adopt or bypass this history. Stop all participants and explicitly",
      "identify and relocate the legacy artifacts before using this override root.",
      "No existing state has been moved or rewritten. See README: Relocating the state dir.",
    );
  }
  // A read-only probe of an uninitialized clone cannot have state under a key
  // that has never been minted. Return the empty root without minting an id.
  return key === null ? absolute : join(absolute, key);
}
