// Scope: Jig's own lifecycle map (docs/LIFECYCLE.md), through M6's lifecycle
// map gate (modules/M6-feature-delivery-pipeline/reference/lifecycle-map):
// every owner a stage names resolves to a plugin skill, one of Jig's own
// skills (.claude/skills), a package script, a file, a document or the
// plugin's `jig` command, which `jig install` puts on PATH; every
// plugin skill appears in the map; AGENTS.md links the map; and every
// Markdown document that names a `/jig:` skill names one that exists. The
// documents that record the past (the changelog, change notes, calibration
// runs), the plans (they name skills not built yet), vendored seeds,
// templates and test fixtures are left out of the last check: they may name
// skills that were renamed, are planned or are only examples.
// Exit 1 for a violation; 2 when the map or a file it needs cannot be read.
import { join, relative } from "node:path";
import { cli } from "../lib/cli.ts";
import { markdownFiles } from "../lib/files.ts";
import { runMap } from "../modules/M6-feature-delivery-pipeline/reference/lifecycle-map/check-lifecycle-map.ts";

const MAP = "docs/LIFECYCLE.md";
const HISTORY = ["CHANGELOG.md", "changes", "calibration"];
const PLANS = ["design/", "ROADMAP.md"];

export function checkLifecycleMap(root = "."): number {
  const scan = markdownFiles(root, [
    "templates",
    "fixtures",
    "fixture",
    "seeds",
    ...HISTORY,
  ]).filter((file) => {
    const name = relative(root, file).replaceAll("\\", "/");
    return !PLANS.some((plan) => name.startsWith(plan));
  });
  return runMap(
    {
      map: join(root, MAP),
      root,
      skills: [
        { namespace: "jig", dir: join(root, "plugin/skills") },
        { namespace: "", dir: join(root, ".claude/skills") },
      ],
      external: ["jig"],
      cover: [join(root, "plugin/skills"), join(root, ".claude/skills")],
      scan,
      linkedFrom: join(root, "AGENTS.md"),
    },
    MAP,
  );
}
if (import.meta.main) cli(() => checkLifecycleMap(process.argv[2]));
