#!/usr/bin/env bun
/**
 * Check a change-area catalog: its schema, its `impliedBy` graph and what
 * it states about the repository (workspaces, generated files). Exit 0
 * valid, 1 a problem (each printed), 2 the catalog cannot be read.
 *
 *   bun <skill-dir>/scripts/check.ts [--catalog <path>]
 */
import { runMain } from "../../../shared/cli.ts";
import { runCheck } from "./lib/cli.ts";

if (import.meta.main)
  runMain("change-areas", () => runCheck(process.argv.slice(2)));
