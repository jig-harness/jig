// Scope: Jig's release step, through M12's change-notes mechanism
// (plugin/skills/changelog/scripts) with Jig's
// values from check-changelog.ts. After a merge to main it writes the change
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
import { runRelease } from "../plugin/skills/changelog/scripts/release.ts";
import { CHANGE_NOTES } from "./check-changelog.ts";

if (import.meta.main)
  cli(() => {
    const { values } = parseArgs({
      options: {
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        date: { type: "string" },
      },
    });
    return runRelease(
      {
        root: join(import.meta.dir, ".."),
        ...CHANGE_NOTES,
        date: values.date,
        dryRun: values["dry-run"],
      },
      values.json,
    );
  });
