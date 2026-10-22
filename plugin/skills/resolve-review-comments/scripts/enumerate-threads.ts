#!/usr/bin/env bun
/** Enumerate and label one thread stream; a failed producer never becomes an empty pass. */
import { lstatSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Defect } from "../../../shared/errors.ts";
import { runMain } from "../../../shared/cli.ts";
import { siblingSkill } from "../../../shared/consumer.ts";
import { run } from "../../../shared/proc.ts";

export async function enumerateThreads(
  argv: string[],
  driveRoot = siblingSkill("drive-pr", import.meta.dirname),
  execute = run,
): Promise<{ code: number; stdout: string }> {
  const listed = await execute(
    [
      process.execPath,
      join(import.meta.dirname, "list-unresolved-threads.ts"),
      ...argv,
    ],
    { timeoutSec: 120, stderr: "inherit" },
  );
  if (listed.code !== 0) return { code: listed.code, stdout: "" };
  try {
    lstatSync(driveRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!statSync(dirname(driveRoot)).isDirectory())
      throw new Defect("skill parent is not a directory");
    if (process.env.DRIVE_PR_TARGET)
      throw new Defect("drive context exists but the drive skill is missing");
    return { code: 0, stdout: listed.stdout };
  }
  const labelled = await execute(
    [
      process.execPath,
      join(driveRoot, "scripts/self-inflicted.ts"),
      ...argv.filter((arg) => /^\d+$/.test(arg)),
    ],
    { timeoutSec: 120, stdin: listed.stdout, stderr: "inherit" },
  );
  return {
    code: labelled.code,
    stdout: labelled.code === 0 ? labelled.stdout : "",
  };
}

if (import.meta.main)
  runMain("enumerate-threads", async () => {
    const result = await enumerateThreads(process.argv.slice(2));
    process.stdout.write(result.stdout);
    return result.code;
  });
