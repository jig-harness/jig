/**
 * The files a clone's state directory keeps beside the drive's database:
 * what is read or appended as a file and queried by nothing, so it stays
 * one. Each pattern is tagged with its family, which the records registry
 * holds (`shared/records/registry.ts`); the reaper (`reap-state.ts`)
 * retires a merged PR's files by family. The morning report's memory
 * (`morning-report.ts`) and a driver's process registry on Windows
 * (`driver/lifecycle.ts`) live there too.
 */

/** The family a clone-directory file belongs to. */
export type ArtifactFamily = "log" | "pass-handoff" | "arm-output";

interface ClonePattern {
  readonly re: RegExp;
  readonly family: ArtifactFamily;
}

/** The files kept per PR, its number the first capture. */
const CLONE_FILES: readonly ClonePattern[] = [
  { re: /^drive-pr-([0-9]+)\.log(?:\.1)?$/, family: "log" },
  {
    re: /^drive-pr-([0-9]+)\.(?:answers\.json|notice\.md)(?:\.[0-9a-f]{6})?$/,
    family: "pass-handoff",
  },
  { re: /^drive-arm-([0-9]+)\.out$/, family: "arm-output" },
];

/** A driver's process registry on Windows: `pr-drive-<PR>.processes.<lock token>`. */
const PROCESS_REGISTRY = /^pr-drive-([0-9]+)\.processes\.[0-9a-f]+$/;

/** The morning report's memory of when it last ran. */
export const REPORT_MEMORY = "drives-report.json";

/** The PR and family of a file the clone directory keeps, or `null` for any other name. */
export function cloneFile(
  name: string,
): { pr: string; family: ArtifactFamily | "process-registry" } | null {
  for (const { re, family } of CLONE_FILES) {
    const m = re.exec(name);
    if (m !== null) return { pr: m[1] as string, family };
  }
  const registry = PROCESS_REGISTRY.exec(name);
  return registry === null
    ? null
    : { pr: registry[1] as string, family: "process-registry" };
}

/** Whether `name` is a file a clone's state directory keeps beside the database. */
export function isCloneFile(name: string): boolean {
  return name === REPORT_MEMORY || cloneFile(name) !== null;
}
