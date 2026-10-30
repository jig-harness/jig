#!/usr/bin/env bun
// Regenerate the index and orphan report of the docs tree the repository's
// configuration names (docs.root, or the detected tree), the one the docs
// pass reports on. The root reaches the generator as data, never through a
// shell: a configured path may hold any character. Run from the repository
// root (or set JIG_CONSUMER_ROOT); arguments pass through (`--check`).
import { consumerRoot } from "../../../../shared/consumer.ts";
import { cli } from "../lib/docs.ts";
import { loadDocsSettings, SettingsError } from "../lib/settings.ts";
import { runIndex } from "./generate-index.ts";

export function regenerate(args = process.argv.slice(2)): number {
  const repo = consumerRoot();
  const { root } = loadDocsSettings(repo);
  if (root === null) throw new SettingsError("no docs tree (set docs.root)");
  process.chdir(repo);
  return runIndex(args, { ...process.env, DOCS_DIR: root });
}

if (import.meta.main) cli(() => regenerate());
