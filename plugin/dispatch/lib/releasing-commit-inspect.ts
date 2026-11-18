/** Print one release's commit as JSON so callers can bound the synchronous history scan. */
// fallow-ignore-file unused-file
import { releasingCommit } from "../../skills/changelog/scripts/releasing-commit.ts";

const [root, tag] = process.argv.slice(2);

if (root === undefined || tag === undefined || process.argv.length !== 4) {
  process.stderr.write("usage: releasing-commit-inspect.ts <root> <tag>\n");
  process.exitCode = 2;
} else {
  process.stdout.write(`${JSON.stringify(releasingCommit(root, tag))}\n`);
}
