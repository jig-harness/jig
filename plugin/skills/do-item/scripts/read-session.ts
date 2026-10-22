#!/usr/bin/env bun
/** Read a session snapshot and refresh retention without shell-specific touch. */
import { swallow } from "../../../shared/errors.ts";
import { readFileSync, utimesSync } from "node:fs";

const [path, ...extra] = process.argv.slice(2);
if (!path || extra.length) {
  console.error("Usage: read-session.ts <sessionPath>");
  process.exitCode = 2;
} else {
  try {
    const content = readFileSync(path, "utf8");
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch (error) {
      swallow(
        error,
        "session retention refresh failed; the snapshot read remains valid",
      );
    }
    process.stdout.write(content);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
