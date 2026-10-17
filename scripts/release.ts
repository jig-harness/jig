// Scope: Jig's release step, through the `changelog` skill's release script
// (plugin/skills/changelog/scripts) with Jig's values from the `changelog:`
// section of .config/jig.yaml. After a merge to main it writes the change
// notes under changes/ into CHANGELOG.md, moves both plugin manifests to the
// next version when a note asks for a release, and deletes the notes.
// .github/workflows/release.yml runs it on every push to main and commits,
// tags and pushes what it writes. Every note waiting is one release (ADR-0002).
//
// Usage: bun scripts/release.ts [--dry-run] [--json] [--date YYYY-MM-DD]
// Exit: 0 written, or nothing to write; 1 a note is malformed; 2 an error.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { cli } from "../lib/cli.ts";
import { runReleaseCommand } from "../plugin/skills/changelog/scripts/release.ts";

if (import.meta.main)
  cli(() => {
    const { values } = parseArgs({
      options: {
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        date: { type: "string" },
      },
    });
    return runReleaseCommand({
      root: join(import.meta.dir, ".."),
      date: values.date,
      dryRun: values["dry-run"],
      json: values.json,
    });
  });
