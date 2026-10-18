#!/usr/bin/env bun
/**
 * A store that breaks the contract the way a ranked or capped search does:
 * the filesystem store, with `list` cut to the newest `--cap` events, or with
 * `--since-only` only a `list` given a `since`.
 *
 * Usage: bun capped-store.ts --path <folder> --cap <n> [--since-only]
 *        <operation>
 */
import { tsArgv } from "../../../../shared/proc.ts";
import { jsonlLines, parseObject } from "../../scripts/lib/events.ts";

const [, , pathFlag, path, capFlag, cap, ...rest] = process.argv;
const sinceOnly = rest[0] === "--since-only";
const op = sinceOnly ? rest[1] : rest[0];
if (
  pathFlag !== "--path" ||
  path === undefined ||
  capFlag !== "--cap" ||
  !/^[0-9]+$/.test(cap ?? "") ||
  op === undefined ||
  rest.length !== (sinceOnly ? 2 : 1)
) {
  console.error(
    "usage: capped-store.ts --path <folder> --cap <n> [--since-only] <operation>",
  );
  process.exit(2);
}
const input = await Bun.stdin.text();
const child = Bun.spawnSync(
  tsArgv(`${import.meta.dir}/../../scripts/filesystem-store.ts`, [
    "--path",
    path,
    op,
  ]),
  {
    stdin: Buffer.from(input),
  },
);
let out = child.stdout.toString();
const capped =
  op === "list" &&
  child.exitCode === 0 &&
  (!sinceOnly || parseObject(input || "{}", "the list input").since !== undefined);
if (capped) {
  const key = (line: string): string => {
    const event = parseObject(line, "a listed event");
    return `${String(event.at)} ${String(event.id)}`;
  };
  const newest = jsonlLines(out)
    .sort((x, y) => (key(x) < key(y) ? 1 : -1))
    .slice(0, Number(cap));
  out = newest.map((line) => `${line}\n`).join("");
}
process.stdout.write(out);
process.stderr.write(child.stderr);
// Not process.exit: it can cut a large listing short on a pipe.
process.exitCode = child.exitCode ?? 1;
