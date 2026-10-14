// Bundle operated entry points; copy the companion data files they read at runtime.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { walk } from "../lib/files.ts";
if (import.meta.main)
  cli(async () => {
    const entries = ["scripts", "modules", "tools"].flatMap((root) =>
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
    // Smoke-test the bundled origin-reference gate. With an explicit pattern
    // file that has no allow patterns, a clean fixture passes. With its
    // default companion file, copied above, it reads the real patterns: on
    // that fixture their allow patterns exempt nothing, so it must report
    // exactly that (exit 1), never fail to find the file (exit 2).
    const bundled = (args: string[]) =>
      Bun.spawnSync([
        process.execPath,
        "dist/scripts/check-no-tracker-refs.js",
        "scripts/tests/fixtures/pass",
        ...args,
      ]);
    const clean = bundled(["scripts/tests/fixtures/tracker-key-patterns.txt"]);
    if (clean.exitCode !== 0) {
      console.error(
        `bundled check-no-tracker-refs failed a clean fixture (exit ${clean.exitCode})\n${clean.stderr.toString()}`,
      );
      return 1;
    }
    const companion = bundled([]);
    if (
      companion.exitCode !== 1 ||
      !companion.stderr.toString().includes("[origin-reference-allowlist]")
    ) {
      console.error(
        `bundled check-no-tracker-refs did not read its companion pattern file (exit ${companion.exitCode})\n${companion.stderr.toString()}`,
      );
      return 1;
    }
    console.log(`built ${entries.length} entry points`);
    return 0;
  });
