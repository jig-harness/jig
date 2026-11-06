// Jig's review and drive adapter: changed paths arrive one per line on stdin.
// Validate Jig's catalog extensions before using the shared routing projection.
import { cli } from "../lib/cli.ts";
import { validCatalog, resolveAreas } from "./change-areas.ts";
import { toResolution } from "../plugin/skills/change-areas/scripts/lib/emit.ts";

if (import.meta.main)
  cli(async () => {
    const files = [
      ...new Set((await Bun.stdin.text()).split(/\r?\n/).filter(Boolean)),
    ];
    const areas = validCatalog(process.cwd());
    const resolution = resolveAreas(files, areas);
    const plan = toResolution(
      {
        changedFiles: files,
        catalog: { areas },
        seed: new Set(resolution.seedAreas),
        resolved: new Set(resolution.areas),
      },
      (ctx) => ({
        sourceAreas: [...ctx.seed].sort(),
        profiles: [],
        localChecks: ["bun run gates"],
        verificationChecks: ["bun run gates"],
        testbox: {
          required: false,
          command: null,
          warmupCommand: null,
          reason: null,
          requiredBy: [],
        },
        repositoryHooksRequired: true,
        githubCiRequired: true,
      }),
    );
    console.log(JSON.stringify(plan));
    return 0;
  });
