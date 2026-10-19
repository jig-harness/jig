#!/usr/bin/env bun
/**
 * Resolve a change to its change-areas and print what it owes: the entry
 * point of `lib/cli.ts`'s `runCli`, with no composer options. Run it with
 * the consumer repository as the working directory.
 *
 *   bun <skill-dir>/scripts/resolve.ts --files changed.txt
 *   bun <skill-dir>/scripts/resolve.ts --base main --format gha
 *   bun <skill-dir>/scripts/resolve.ts --format dorny
 */
import { runMain } from "../../../shared/cli.ts";
import { runCli } from "./lib/cli.ts";

if (import.meta.main)
  runMain("change-areas", () => runCli(process.argv.slice(2)));
