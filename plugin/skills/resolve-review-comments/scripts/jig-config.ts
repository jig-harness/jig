#!/usr/bin/env bun
/**
 * Print the Jig configuration as the skills see it: every field set in any
 * layer, its merged value, and the layer that set it.
 *
 * Usage: bun jig-config.ts [<field>] [--json]
 *   <field>  a dotted field (`review.bots`) or section (`review`); default all.
 *            A key holding a dot is quoted: `do_item.agents.labels."node.js"`
 *   --json   one object keyed by field: `{ value, layer, source }`
 *
 *   Run from inside the repository (any directory of it). `JIG_CONSUMER_ROOT`,
 *   `JIG_OVERLAY` and `JIG_HOME` move the repository, its file and the user
 *   layer, as they do for every skill.
 *
 * Output: the layers read, then one `field = value  (source)` line per field.
 * A list is one field; a mapping is opened into its fields. Field names are
 * written as `formatField` writes them, so a key holding a dot stays one key.
 *
 * Exit codes: 0 printed; 1 a layer could not be read (the reason on stderr);
 * 2 usage, or the field is set in no layer.
 */

import { fail, runMain } from "../../../shared/cli.ts";
import {
  formatField,
  isMapping,
  type LayeredConfig,
  layerOf,
  parseField,
  sourceOf,
  valueAt,
} from "../../../shared/config-layers.ts";
import { consumerRoot, layeredConfig } from "../../../shared/consumer.ts";

const USAGE = "usage: jig-config.ts [<field>] [--json]";

/** Every leaf field under `prefix`, as path segments. */
export function leafFields(value: unknown, prefix: string[]): string[][] {
  if (
    !isMapping(value) ||
    (prefix.length > 0 && Object.keys(value).length === 0)
  )
    return prefix.length === 0 ? [] : [prefix];
  return Object.entries(value).flatMap(([key, inner]) =>
    leafFields(inner, [...prefix, key]),
  );
}

export interface FieldReport {
  value: unknown;
  layer: string;
  source: string;
}

/** The report for every field at or under `field` (all when empty). */
export function report(
  config: LayeredConfig,
  field = "",
): Record<string, FieldReport> {
  const prefix = field === "" ? [] : parseField(field);
  const scope = valueAt(config.values, prefix);
  const out: Record<string, FieldReport> = {};
  for (const leaf of leafFields(scope, prefix))
    out[formatField(leaf)] = {
      value: valueAt(config.values, leaf),
      layer: layerOf(config, leaf)?.name ?? "default",
      source: sourceOf(config, leaf),
    };
  return out;
}

async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const rest = argv.filter((arg) => arg !== "--json");
  if (rest.length > 1 || rest.some((arg) => arg.startsWith("-")))
    fail(2, USAGE);
  const field = rest[0] ?? "";
  let config: LayeredConfig;
  try {
    config = layeredConfig();
  } catch (err) {
    fail(1, `jig-config: ${err instanceof Error ? err.message : err}`);
  }
  let set: boolean;
  try {
    set = field === "" || valueAt(config.values, field) !== undefined;
  } catch (err) {
    fail(2, `jig-config: ${err instanceof Error ? err.message : err}`);
  }
  if (!set) fail(2, `jig-config: ${field} is not set in any layer`);
  const fields = report(config, field);
  if (json) {
    console.log(JSON.stringify(fields, null, 2));
    return 0;
  }
  console.log(`repository: ${consumerRoot()}`);
  for (const layer of config.layers)
    console.log(`layer ${layer.name}: ${layer.source}`);
  if (!config.hasRepository)
    console.log(`(no repository file: ${config.repositoryPath})`);
  for (const [name, entry] of Object.entries(fields))
    console.log(`${name} = ${JSON.stringify(entry.value)}  (${entry.source})`);
  return 0;
}

if (import.meta.main) runMain("jig-config", () => main(process.argv.slice(2)));
