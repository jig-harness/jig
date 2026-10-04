// Bundle operated entry points; copy the companion data files they read at runtime.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { walk } from "../lib/files.ts";
if (import.meta.main)
  cli(async () => {
    const entries = ["scripts", "modules", "audit", "tools"].flatMap((root) =>
      walk(root, ["fixtures", "node_modules"])
        .filter(
          (file) =>
            file.endsWith(".ts") &&
            !file.endsWith(".test.ts") &&
            !(root === "scripts" && ["build.ts", "gates.ts"].includes(file)),
        )
        .map((file) => join(root, file))
        .filter((file) =>
          readFileSync(file, "utf8").includes("import.meta.main"),
        ),
    );
    rmSync("dist", { recursive: true, force: true });
    mkdirSync("dist", { recursive: true });
    const result = await Bun.build({
      entrypoints: entries,
      outdir: "dist",
      root: ".",
      target: "bun",
      packages: "bundle",
    });
    if (!result.success) {
      console.error(result.logs);
      return 1;
    }
    copyFileSync(
      "scripts/tracker-key-patterns.txt",
      "dist/scripts/tracker-key-patterns.txt",
    );
    // The bundled auditor resolves its default modules directory relative to
    // itself, so it needs the module maturity files laid out as in the source.
    for (const module of readdirSync("modules")) {
      const maturity = join("modules", module, "maturity.yaml");
      if (!existsSync(maturity)) continue;
      mkdirSync(join("dist", "modules", module), { recursive: true });
      copyFileSync(maturity, join("dist", "modules", module, "maturity.yaml"));
    }
    // Smoke-test a bundled gate that needs a companion file at runtime.
    const smoke = Bun.spawnSync([
      process.execPath,
      "dist/scripts/check-no-tracker-refs.js",
      "scripts/tests/fixtures/pass",
    ]);
    if (smoke.exitCode !== 0) {
      console.error(smoke.stderr.toString());
      return smoke.exitCode;
    }
    const auditor = Bun.spawnSync([
      process.execPath,
      "dist/audit/score-modules.js",
      "--check",
    ]);
    if (auditor.exitCode !== 0) {
      console.error(auditor.stdout.toString(), auditor.stderr.toString());
      return auditor.exitCode;
    }
    console.log(`built ${entries.length} entry points`);
    return 0;
  });
