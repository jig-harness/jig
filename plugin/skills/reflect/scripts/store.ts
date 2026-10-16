#!/usr/bin/env bun
/**
 * Run one store operation against the configured store, under its deadline.
 *
 * Usage: bun store.ts <check|append|list|diagnose>
 *
 * stdin and stdout are the store contract's: `append` reads JSONL events,
 * `list` reads an optional {"since":…} and writes JSONL events, `check`
 * and `diagnose` read nothing. For a person or a skill that needs the store
 * directly; `reflect.ts` and `review.ts` use the same client.
 *
 * Exit codes: the store's own (0 done, 1 failed, 2 usage, 3 unavailable); a
 * deadline that passes is 3. With reflection off, exits 0 and says so.
 */
import { readStdinAll, runMain } from "../../../shared/cli.ts";
import { reflectionSettings } from "./lib/settings.ts";
import {
  EXIT,
  OPERATIONS,
  type Operation,
  runStore,
  storeCommand,
} from "./lib/store-client.ts";

export async function main(argv: string[]): Promise<number> {
  const [op, ...rest] = argv;
  if (
    op === undefined ||
    !(OPERATIONS as readonly string[]).includes(op) ||
    rest.length > 0
  ) {
    console.error(`usage: store.ts <${OPERATIONS.join("|")}>`);
    return EXIT.usage;
  }
  const settings = reflectionSettings();
  if (!settings.on) {
    console.error("reflection is off: no store is configured");
    return 0;
  }
  const command = storeCommand(settings);
  const input = op === "append" || op === "list" ? await readStdinAll() : "";
  const r = await runStore(
    command,
    op as Operation,
    input,
    settings.timeoutSec,
  );
  process.stdout.write(r.stdout);
  if (r.stderr !== "")
    process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
  return r.code;
}

if (import.meta.main) runMain("store.ts", () => main(process.argv.slice(2)));
