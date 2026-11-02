/**
 * The labels part of `jig install dispatch --repo <path> [--yes]` on its
 * own, for the tests: the whole verb with `--yes` would also write the
 * timer, which needs the installed plugin copy.
 */
import { installLabels } from "../../install-labels.ts";

const args = process.argv.slice(2);
process.exit(
  await installLabels(
    args.filter((a) => a !== "--yes"),
    args.includes("--yes"),
  ),
);
