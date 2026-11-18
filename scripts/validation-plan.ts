// Jig's review and drive adapter: changed paths arrive one per line on stdin.
// Validate Jig's catalog extensions, then print the shared routing projection
// with Jig's validation plan (scripts/area-validation.ts): the touched areas'
// profiles, own tests and generated-file checks, the whole gate set when a
// changed file no own test covers.
import { cli } from "../lib/cli.ts";
import { validDocument, resolveAreas } from "./change-areas.ts";
import { jigValidation } from "./area-validation.ts";
import { toResolution } from "../plugin/skills/change-areas/scripts/lib/emit.ts";

if (import.meta.main)
  cli(async () => {
    const files = [
      ...new Set((await Bun.stdin.text()).split(/\r?\n/).filter(Boolean)),
    ];
    const doc = validDocument(process.cwd());
    const resolution = resolveAreas(files, doc.areas);
    const plan = toResolution(
      {
        changedFiles: files,
        catalog: doc,
        seed: new Set(resolution.seedAreas),
        resolved: new Set(resolution.areas),
      },
      jigValidation,
    );
    console.log(JSON.stringify(plan));
    return 0;
  });
