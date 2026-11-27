/**
 * `jig dispatch check [--repo <path>]`: check the configuration a tick reads
 * from a repository with the tick's own readers (`lib/config-check.ts`), for
 * the repository's CI. Each reading the tick would refuse is printed with
 * the tick's sentence, and the command exits 1; a configuration the tick
 * reads whole exits 0.
 */
import { checkConfiguration } from "./lib/config-check.ts";

/** Exit when the tick would refuse a reading. */
const CHECK_FAILED_EXIT = 1;

export function checkMain(root: string): number {
  const findings = checkConfiguration(root);
  if (findings.length === 0) {
    console.log(
      `jig dispatch check: the tick reads the configuration in ${root} whole: its dispatch section, its tracker and issue facets, and its change-area catalog`,
    );
    return 0;
  }
  for (const finding of findings)
    console.error(`jig dispatch check: ${finding.part}: ${finding.message}`);
  return CHECK_FAILED_EXIT;
}
