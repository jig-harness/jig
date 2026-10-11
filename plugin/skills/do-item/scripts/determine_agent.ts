#!/usr/bin/env bun
/**
 * Decide which agent(s) implement an issue, and which scouts gather context
 * first, from the issue's labels and title.
 *
 * The routing is the consumer's, read from `.config/groundwork-overlay.yaml`:
 *
 *   do_item:
 *     agents:
 *       default: <agent>              # nothing matched; default general-purpose
 *       integrator: <agent>           # more than two agents; default `default`
 *       catalog: {<catalog agent>: <agent>}     # change-area `agent:` value → agent
 *       codearea_areas: {<label>: <area key>}   # label → change-area key
 *       labels: {<label>: <agent>}              # label → agent
 *       title_keywords: {<word>: <agent>}       # optional title heuristics
 *     scouts: {<agent>: [<scout>, ...]}         # agent → pre-flight scouts
 *   drive:
 *     change_areas_catalog: <path>    # change-area catalog (YAML with `areas:`)
 *
 * Lookup order:
 *   1. a label's change area (`codearea_areas`), whose catalog `agent` value
 *      maps through `catalog`;
 *   2. `labels`, for labels the catalog did not answer;
 *   3. `title_keywords`, matched case-insensitively in the title;
 *   4. `default`.
 * More than two agents → `integrator` coordinates.
 *
 * Type: Discovery
 * Input: JSON with the issue's `labels` and `title` (from get_issue.ts)
 * Output: JSON with the agent recommendation and scouts
 *
 * Usage:
 *     bun determine_agent.ts <issue-json-file>
 *     bun get_issue.ts ENG-123 | bun determine_agent.ts -
 *     bun determine_agent.ts - --catalog /path/to/catalog.yaml
 *
 * Runs under Bun and under Node ≥ 22.18 (type stripping). YAML parsing uses
 * the review skill's vendored js-yaml build (the plugin cache has no
 * `node_modules`).
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  consumerRoot,
  readOverlay,
} from "../../resolve-review-comments/scripts/lib/consumer.ts";
import { load as loadYaml } from "../../resolve-review-comments/scripts/lib/yaml.ts";
import { isEntryPoint, parseArgs } from "./lib/cli.ts";
import { doItemSection } from "./lib/overlay.ts";

/** The agent used when the consumer declares none. */
export const DEFAULT_AGENT = "general-purpose";

export interface AgentRouting {
  default: string;
  integrator: string;
  catalog: Record<string, string>;
  codeareaAreas: Record<string, string>;
  labels: Record<string, string>;
  titleKeywords: Record<string, string>;
  scouts: Record<string, string[]>;
}

export interface Catalog {
  areas?: Record<string, { agent?: string }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringMap(v: unknown, where: string): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (!isRecord(v)) throw new Error(`${where} must be a mapping`);
  // Null-prototype: a key such as `__proto__` stays an ordinary entry.
  const out: Record<string, string> = Object.create(null);
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== "string" || x.trim() === "")
      throw new Error(`${where}.${k} must be a nonempty string`);
    // Labels are matched case-insensitively.
    out[k.toLowerCase()] = x;
  }
  return out;
}

/** Validate `do_item.agents` and `do_item.scouts` from a parsed overlay. */
export function parseAgentRouting(
  overlay: Record<string, unknown>,
): AgentRouting {
  const section = doItemSection(overlay) ?? {};
  if (!isRecord(section)) throw new Error("do_item must be a mapping");
  const agents = section.agents ?? {};
  if (!isRecord(agents)) throw new Error("do_item.agents must be a mapping");
  const name = (v: unknown, where: string, fallback: string): string => {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "string" || v.trim() === "")
      throw new Error(`${where} must be a nonempty string`);
    return v;
  };
  const dflt = name(agents.default, "do_item.agents.default", DEFAULT_AGENT);
  const scoutsRaw = section.scouts ?? {};
  if (!isRecord(scoutsRaw))
    throw new Error("do_item.scouts must map an agent to a list of scouts");
  const scouts: Record<string, string[]> = Object.create(null);
  for (const [agent, list] of Object.entries(scoutsRaw)) {
    if (
      !Array.isArray(list) ||
      list.some((s) => typeof s !== "string" || s.trim() === "")
    )
      throw new Error(`do_item.scouts.${agent} must be a list of scout names`);
    scouts[agent] = list as string[];
  }
  return {
    default: dflt,
    integrator: name(agents.integrator, "do_item.agents.integrator", dflt),
    catalog: stringMap(agents.catalog, "do_item.agents.catalog"),
    codeareaAreas: stringMap(
      agents.codearea_areas,
      "do_item.agents.codearea_areas",
    ),
    labels: stringMap(agents.labels, "do_item.agents.labels"),
    titleKeywords: stringMap(
      agents.title_keywords,
      "do_item.agents.title_keywords",
    ),
    scouts,
  };
}

/**
 * A lookup keyed by external input (a label, a catalog `agent` value),
 * resolved against own properties only: a plain object inherits
 * `Object.prototype`, so `table["constructor"]` would otherwise return a
 * function and push it into the agent list.
 */
function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The catalog path the consumer declares (`drive.change_areas_catalog`), or `null`. */
export function catalogPathFromOverlay(
  overlay: Record<string, unknown>,
): string | null {
  const drive = overlay.drive;
  if (drive === undefined || drive === null) return null;
  if (!isRecord(drive)) throw new Error("drive must be a mapping");
  const p = drive.change_areas_catalog;
  if (p === undefined || p === null) return null;
  if (typeof p !== "string" || p.trim() === "")
    throw new Error("drive.change_areas_catalog must be a path");
  return isAbsolute(p) ? p : join(consumerRoot(), p);
}

/** Load a catalog; `null` if it is unavailable or unparseable. */
export function loadCatalog(path: string): Catalog | null {
  try {
    const parsed = loadYaml(readFileSync(path, "utf8"));
    return isRecord(parsed) ? (parsed as Catalog) : null;
  } catch {
    return null;
  }
}

/**
 * The catalog's `agent` for every label with a change area. Returns the agents
 * and the labels they came from as one answer: a label counts as resolved only
 * if it yielded an agent, so an unknown catalog value never suppresses the
 * label's own mapping.
 */
function catalogAgentsFromLabels(
  labels: string[],
  catalog: Catalog | null,
  routing: AgentRouting,
): { agentTypes: string[]; resolvedLabels: Set<string> } {
  const agentTypes: string[] = [];
  const resolvedLabels = new Set<string>();
  if (catalog === null) return { agentTypes, resolvedLabels };
  const areas = catalog.areas ?? {};
  const hits: Array<[string, string, string]> = [];
  for (const label of labels) {
    const labelLower = label.toLowerCase();
    const areaKey = lookup(routing.codeareaAreas, labelLower);
    if (areaKey === undefined) continue;
    const catalogAgent = lookup(areas, areaKey)?.agent;
    if (typeof catalogAgent === "string" && catalogAgent !== "")
      hits.push([areaKey, catalogAgent, labelLower]);
  }
  // Ordered by area key, so the primary preference on a tie is stable.
  hits.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [, catalogAgent, labelLower] of hits) {
    const type = lookup(routing.catalog, catalogAgent.toLowerCase());
    if (type === undefined) continue;
    resolvedLabels.add(labelLower);
    if (!agentTypes.includes(type)) agentTypes.push(type);
  }
  return { agentTypes, resolvedLabels };
}

/** Decide the agents and scouts for an issue. */
export function determineAgents(
  labels: string[],
  title: string,
  catalog: Catalog | null,
  routing: AgentRouting,
): Record<string, unknown> {
  const agents = new Set<string>();
  const scouts = new Set<string>();
  const addAgent = (agent: string) => {
    agents.add(agent);
    for (const scout of lookup(routing.scouts, agent) ?? []) scouts.add(scout);
  };

  const { agentTypes: catalogAgents, resolvedLabels } = catalogAgentsFromLabels(
    labels,
    catalog,
    routing,
  );
  for (const a of catalogAgents) addAgent(a);
  const catalogSource = catalogAgents[0] ?? null;

  for (const label of labels) {
    const labelLower = label.toLowerCase();
    if (resolvedLabels.has(labelLower)) continue;
    const agent = lookup(routing.labels, labelLower);
    if (agent !== undefined) addAgent(agent);
  }

  const titleLower = title.toLowerCase();
  for (const [word, agent] of Object.entries(routing.titleKeywords)) {
    if (titleLower.includes(word) && !agents.has(agent)) addAgent(agent);
  }

  if (agents.size === 0) addAgent(routing.default);

  const agentsList = [...agents];
  let primaryAgent: string;
  let coordinationNeeded: boolean;
  if (agentsList.length > 2) {
    primaryAgent = routing.integrator;
    coordinationNeeded = true;
  } else if (agentsList.length === 2) {
    primaryAgent =
      catalogSource !== null && agentsList.includes(catalogSource)
        ? catalogSource
        : (agentsList[0] as string);
    coordinationNeeded = true;
  } else {
    primaryAgent = agentsList[0] as string;
    coordinationNeeded = false;
  }

  const result: Record<string, unknown> = {
    primary_agent: primaryAgent,
    all_agents: agentsList,
    scouts: [...scouts],
    coordination_needed: coordinationNeeded,
    labels_matched: labels.filter(
      (l) => lookup(routing.labels, l.toLowerCase()) !== undefined,
    ),
    recommendation: `Task tool with subagent_type: "${primaryAgent}"`,
  };
  if (catalogSource !== null) result.catalog_source = catalogSource;
  return result;
}

async function readAllStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), {
    flags: ["verbose"],
    values: ["catalog"],
    // A bare invocation reads stdin.
    defaultPositional: "-",
    usage:
      "usage: determine_agent.ts [issue-json-file|-] [--verbose] [--catalog PATH]",
  });
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }
  const verbose = parsed.args.flags.has("verbose");
  const catalogArg = parsed.args.values.get("catalog") ?? null;
  const input = parsed.args.positional;

  try {
    const text =
      input === "-" ? await readAllStdin() : readFileSync(input, "utf8");

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error(
        `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
      return 2;
    }

    // Valid JSON of the wrong shape is a usage error, not a crash.
    const shapeError = (what: string): number => {
      console.error(`Invalid input: ${what}`);
      return 2;
    };
    if (!isRecord(data)) return shapeError("expected a JSON object");
    const { labels: rawLabels, title: rawTitle } = data as {
      labels?: unknown;
      title?: unknown;
    };
    if (
      rawLabels !== undefined &&
      (!Array.isArray(rawLabels) ||
        rawLabels.some((l) => typeof l !== "string"))
    ) {
      return shapeError("`labels` must be an array of strings");
    }
    if (rawTitle !== undefined && typeof rawTitle !== "string") {
      return shapeError("`title` must be a string");
    }
    const labels = (rawLabels ?? []) as string[];
    const title = rawTitle ?? "";

    const overlay = readOverlay();
    const routing = parseAgentRouting(overlay);
    const catalogPath = catalogArg ?? catalogPathFromOverlay(overlay);
    const catalog = catalogPath === null ? null : loadCatalog(catalogPath);

    if (verbose) {
      console.error(`Labels: ${JSON.stringify(labels)}`);
      console.error(`Title: ${title}`);
      console.error(
        catalogPath === null
          ? "Catalog not configured (drive.change_areas_catalog)"
          : catalog !== null
            ? `Catalog loaded: ${catalogPath}`
            : `Catalog unavailable: ${catalogPath}`,
      );
    }

    const result = determineAgents(labels, title, catalog, routing);

    if (verbose) {
      console.error(`Primary agent: ${String(result.primary_agent)}`);
      console.error(`Scouts: ${JSON.stringify(result.scouts)}`);
      if ("catalog_source" in result) {
        console.error(`Catalog source: ${String(result.catalog_source)}`);
      }
    }

    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    if (verbose && e instanceof Error) console.error(e.stack);
    return 1;
  }
}

if (isEntryPoint(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
