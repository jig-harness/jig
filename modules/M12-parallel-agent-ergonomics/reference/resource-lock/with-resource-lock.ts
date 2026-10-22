#!/usr/bin/env bun
// The reference entry point and the installed collector use one lock protocol.
import { main } from "../../../../plugin/shared/resource-lock.ts";
export { main };
if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
