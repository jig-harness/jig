/**
 * Load and validate the consumer's fleet-health configuration — what the
 * fleet-health sensor counts as progress and ceremony and where a suspicion
 * starts — and the vocabulary it reads the tracker with.
 *
 * The file is the consumer's: `fleet_health.config` in
 * `.config/jig.yaml`, default `.config/fleet-health.yaml`. Its
 * schema is this module's. Optional sections:
 *
 *   labels:        # tracker labels the sensor reads
 *     epic: epic                    # default review.taxonomy.epic_label, else `epic`
 *     followup: follow-up           # default the overlay's declared follow-up label; null, or none declared = not measured
 *     delivery_system: delivery     # the label a delivery-system change area and issue carry; unset = not measured
 *   ledger:        # the debt ledger fractal-metrics reports
 *     label: follow-up              # default labels.followup
 *     project: Debt                 # optional: the ledger is the label ∪ the project
 *     closed_state_types: [completed, canceled, duplicate]
 *   baselines:     # fractal-metrics' recorded baselines, by metric id
 *     rounds_median: { value: 4, source: { file: docs/metrics.md, needle: "4 rounds" } }
 *
 * The team key comes from `issue_tracker.team` and the change-area catalog
 * from `drive.change_areas_catalog`.
 *
 * FAILS CLOSED: a default threshold nobody configured is a confident answer
 * to an unasked question. An absent, unparseable or structurally invalid
 * config is an error, never a silent fallback to built-in numbers — and an
 * unknown key is an error too, so a retuned knob the sensor does not read
 * cannot look like a retune.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  fieldInMessage,
  type LayeredConfig,
  sourceOf,
} from "../../../../shared/config-layers.ts";
import {
  consumerRoot,
  isDistinctNonEmptyList,
  layeredConfig,
} from "../../../../shared/consumer.ts";
import {
  parseTrackerLabels,
  type TrackerLabels,
} from "../../../../shared/tracker-labels.ts";
import { load as loadYaml } from "../../../../shared/yaml.ts";

/** Repo-relative default — also the config's display label in errors. */
export const CONFIG_RELPATH = ".config/fleet-health.yaml";

/** What the consumer overlay contributes to the configuration. */
export interface ConfigContext {
  /** The consumer repository the paths below resolve against. */
  root: string | null;
  /** `issue_tracker.team`. */
  teamKey: string | null;
  /** `review.taxonomy.epic_label`. */
  epicLabel: string | null;
  /** `review.taxonomy.provenance_label`. */
  followupLabel: string | null;
  /** `review.taxonomy.repos`: the labels that name a repository. */
  repositoryLabels: string[];
  /** `drive.change_areas_catalog`, resolved. */
  catalogPath: string | null;
  /** `fleet_health.config`, resolved. */
  configPath: string | null;
}

export const EMPTY_CONTEXT: ConfigContext = {
  root: null,
  teamKey: null,
  epicLabel: null,
  followupLabel: null,
  repositoryLabels: [],
  catalogPath: null,
  configPath: null,
};

function isRecordValue(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringAt(obj: unknown, ...path: string[]): string | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (!isRecordValue(cur)) return null;
    cur = cur[k];
  }
  return typeof cur === "string" && cur.trim() !== "" ? cur.trim() : null;
}

/**
 * `review.taxonomy.repos`: only an absent field is none. Any present value
 * must satisfy the same list rule the overlay's own validator applies to
 * every taxonomy list, so this reader cannot accept a value it rejects.
 */
function repositoryLabelsOf(config: LayeredConfig): string[] {
  const path = ["review", "taxonomy", "repos"];
  let cur: unknown = config.values;
  for (const k of path) {
    if (!isRecordValue(cur) || !Object.hasOwn(cur, k)) return [];
    cur = cur[k];
  }
  if (!isDistinctNonEmptyList(cur))
    throw new FleetHealthConfigError(
      `${sourceOf(config, path)}: ${path.join(".")} must contain distinct nonempty strings`,
    );
  return cur as string[];
}

/**
 * The overlay's contribution for the repository at `root`. A missing overlay
 * is an empty context (the sensor then reports what it cannot measure); an
 * unparseable one is an error.
 */
export function overlayContext(root: string): ConfigContext {
  let config: LayeredConfig;
  try {
    config = layeredConfig(root);
  } catch (err) {
    throw new FleetHealthConfigError(
      err instanceof Error ? err.message : String(err),
    );
  }
  if (config.layers.length === 0) return { ...EMPTY_CONTEXT, root };
  const overlay = config.values;
  let labels: TrackerLabels;
  try {
    labels = parseTrackerLabels(overlay);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The labels are read from issue_tracker.labels and, for older
    // configurations, from review.taxonomy.
    const section = message.startsWith("review") ? "review" : "issue_tracker";
    throw new FleetHealthConfigError(
      `${sourceOf(config, fieldInMessage(message, section))}: ${message}`,
    );
  }
  const at = (p: string | null): string | null =>
    p === null ? null : isAbsolute(p) ? p : join(root, p);
  return {
    root,
    teamKey: stringAt(overlay, "issue_tracker", "team"),
    // Only a label the consumer named counts: an unnamed follow-up label
    // means follow-ups are not measured, not that the default is measured.
    epicLabel: labels.declared.has("epic") ? labels.epic : null,
    followupLabel: labels.declared.has("followup") ? labels.followup : null,
    repositoryLabels: repositoryLabelsOf(config),
    catalogPath: at(stringAt(overlay, "drive", "change_areas_catalog")),
    configPath: at(stringAt(overlay, "fleet_health", "config")),
  };
}

/** The consumer's configuration path: `fleet_health.config`, else the default. */
export function defaultConfigPath(root: string = consumerRoot()): string {
  return overlayContext(root).configPath ?? join(root, CONFIG_RELPATH);
}

export interface MetricBaseline {
  value: number;
  /** The document that records the number, and a substring that must still appear in it. */
  source: { file: string; needle: string } | null;
}

export interface FleetHealthConfig {
  version: 1;
  window: { days: number };
  progress: {
    productAreas: string[];
    weights: {
      mergedProductPr: number;
      criterionClosed: number;
      epicAccepted: number;
    };
  };
  ceremony: {
    freeRounds: number;
    weights: {
      roundsBeyondFree: number;
      followupsMinted: number;
      sdlcIssuesOpened: number;
    };
    /** unit name → why it cannot be measured. */
    unmeasured: Record<string, string>;
  };
  signals: {
    stuckEpic: { days: number };
    /** An epic at least `minDoneShare` done, with at most `maxOpen` children open. */
    tailBlocked: { minDoneShare: number; maxOpen: number };
    ceremonyRatio: { suspectAt: number; highAt: number; minCeremony: number };
    followupDepth: { suspectAt: number; maxWalk: number };
    /** `null` = reported, never raises. */
    deliverySystemShare: { suspectAt: number | null };
    reviewCarousel: {
      minRounds: number;
      highRounds: number;
      minPostReviewShare: number;
    };
  };
  lifecycle: { cooldownDays: number };
  /** The team key issue identifiers carry; `null` = any key. */
  teamKey: string | null;
  labels: {
    epic: string;
    /** `null`: follow-ups are not measured. */
    followup: string | null;
    /** `null`: the delivery-system share and its issues are not measured. */
    deliverySystem: string | null;
    /** Labels that name a repository; none = orphan-risk is not measured. */
    repositories: string[];
  };
  ledger: {
    /** `null`: no ledger label, so the ledger is not measured. */
    label: string | null;
    project: string | null;
    closedStateTypes: string[];
  };
  mergeConflicts: { coverageFloor: number };
  baselines: Record<string, MetricBaseline>;
  /** The consumer repository this configuration belongs to, when known. */
  root: string | null;
  /** The change-area catalog, when the consumer declares one. */
  catalogPath: string | null;
}

export class FleetHealthConfigError extends Error {}

const DEFAULT_CLOSED_STATE_TYPES = ["completed", "canceled", "duplicate"];

function optLabel(
  obj: Record<string, unknown>,
  key: string,
  where: string,
): string | null | undefined {
  if (!(key in obj)) return undefined;
  const v = obj[key];
  if (v === null) return null;
  if (typeof v !== "string" || v.trim() === "")
    bad(`${where}.${key}`, "must be a nonempty string or null");
  return v as string;
}

function optLabelList(
  obj: Record<string, unknown>,
  key: string,
  where: string,
): string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (
    !Array.isArray(v) ||
    !v.every((r) => typeof r === "string" && r.trim() !== "")
  )
    bad(`${where}.${key}`, "must be a list of labels");
  return v as string[];
}

/** The census's nearly-done thresholds; optional, the census's definition by default. */
function parseTailBlocked(
  raw: unknown,
): FleetHealthConfig["signals"]["tailBlocked"] {
  const where = "signals.tail_blocked";
  const tail = raw === undefined ? {} : record(raw, where);
  for (const k of Object.keys(tail))
    if (!["done_share", "max_open"].includes(k))
      bad(`${where}.${k}`, "is not a key the sensor reads");
  return {
    minDoneShare:
      tail.done_share === undefined
        ? 0.8
        : num(tail, "done_share", where, { min: 0, max: 1 }),
    maxOpen:
      tail.max_open === undefined
        ? 2
        : num(tail, "max_open", where, { min: 1, integer: true }),
  };
}

function parseLabels(
  raw: unknown,
  ctx: ConfigContext,
): FleetHealthConfig["labels"] {
  const obj = raw === undefined ? {} : record(raw, "labels");
  for (const k of Object.keys(obj))
    if (!["epic", "followup", "delivery_system", "repositories"].includes(k))
      bad(`labels.${k}`, "is not a key the sensor reads");
  const epic = optLabel(obj, "epic", "labels");
  const followup = optLabel(obj, "followup", "labels");
  const delivery = optLabel(obj, "delivery_system", "labels");
  const repositories = optLabelList(obj, "repositories", "labels");
  return {
    epic: epic ?? ctx.epicLabel ?? "epic",
    followup: followup === undefined ? ctx.followupLabel : followup,
    deliverySystem: delivery ?? null,
    repositories: repositories ?? ctx.repositoryLabels,
  };
}

function parseLedger(
  raw: unknown,
  labels: FleetHealthConfig["labels"],
): FleetHealthConfig["ledger"] {
  const obj = raw === undefined ? {} : record(raw, "ledger");
  for (const k of Object.keys(obj))
    if (!["label", "project", "closed_state_types"].includes(k))
      bad(`ledger.${k}`, "is not a key the sensor reads");
  const label = optLabel(obj, "label", "ledger");
  const project = optLabel(obj, "project", "ledger");
  const closed = obj.closed_state_types;
  if (
    closed !== undefined &&
    (!Array.isArray(closed) ||
      closed.length === 0 ||
      !closed.every((c) => typeof c === "string" && c !== ""))
  )
    bad("ledger.closed_state_types", "must be a non-empty list of state types");
  return {
    label: label === undefined ? labels.followup : label,
    project: project ?? null,
    closedStateTypes:
      closed === undefined ? DEFAULT_CLOSED_STATE_TYPES : (closed as string[]),
  };
}

function parseBaselines(raw: unknown): Record<string, MetricBaseline> {
  if (raw === undefined || raw === null) return {};
  const obj = record(raw, "baselines");
  const out: Record<string, MetricBaseline> = {};
  for (const [id, entry] of Object.entries(obj)) {
    const e = record(entry, `baselines.${id}`);
    for (const k of Object.keys(e))
      if (!["value", "source"].includes(k))
        bad(`baselines.${id}.${k}`, "is not a key the sensor reads");
    const value = num(e, "value", `baselines.${id}`);
    let source: MetricBaseline["source"] = null;
    if (e.source !== undefined && e.source !== null) {
      const src = record(e.source, `baselines.${id}.source`);
      if (
        typeof src.file !== "string" ||
        src.file === "" ||
        typeof src.needle !== "string" ||
        src.needle === ""
      )
        bad(`baselines.${id}.source`, "must name a file and a needle");
      source = { file: src.file as string, needle: src.needle as string };
    }
    out[id] = { value, source };
  }
  return out;
}

function bad(where: string, why: string): never {
  throw new FleetHealthConfigError(`${CONFIG_RELPATH}: ${where} ${why}`);
}

function record(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return bad(where, "must be a mapping");
  }
  return v as Record<string, unknown>;
}

/** Reject keys the sensor does not read: a knob nothing reads retunes nothing. */
function exactKeys(
  obj: Record<string, unknown>,
  where: string,
  allowed: readonly string[],
): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k))
      bad(`${where}.${k}`, "is not a key the sensor reads");
  }
  for (const k of allowed) {
    if (!(k in obj)) bad(`${where}.${k}`, "is required");
  }
}

function num(
  obj: Record<string, unknown>,
  key: string,
  where: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return bad(`${where}.${key}`, "must be a finite number");
  }
  if (opts.integer === true && !Number.isInteger(v)) {
    bad(`${where}.${key}`, "must be a whole number");
  }
  if (opts.min !== undefined && v < opts.min) {
    bad(`${where}.${key}`, `must be at least ${opts.min}`);
  }
  if (opts.max !== undefined && v > opts.max) {
    bad(`${where}.${key}`, `must be at most ${opts.max}`);
  }
  return v;
}

export function parseConfig(
  raw: unknown,
  ctx: ConfigContext = EMPTY_CONTEXT,
): FleetHealthConfig {
  const whole = record(raw, "config");
  const {
    labels: rawLabels,
    ledger: rawLedger,
    baselines: rawBaselines,
    merge_conflicts: rawMergeConflicts,
    ...root
  } = whole;
  const labels = parseLabels(rawLabels, ctx);
  const conflicts =
    rawMergeConflicts === undefined
      ? { coverage_floor: 0.9 }
      : record(rawMergeConflicts, "merge_conflicts");
  exactKeys(conflicts, "merge_conflicts", ["coverage_floor"]);
  exactKeys(root, "config", [
    "version",
    "window",
    "progress",
    "ceremony",
    "signals",
    "lifecycle",
  ]);
  if (root.version !== 1) bad("version", "must be 1");

  const window = record(root.window, "window");
  exactKeys(window, "window", ["days"]);

  const progress = record(root.progress, "progress");
  exactKeys(progress, "progress", ["product_areas", "weights"]);
  const areas = progress.product_areas;
  if (
    !Array.isArray(areas) ||
    areas.length === 0 ||
    !areas.every((a) => typeof a === "string" && a !== "")
  ) {
    bad("progress.product_areas", "must be a non-empty list of area keys");
  }
  if (new Set(areas as string[]).size !== (areas as string[]).length) {
    bad("progress.product_areas", "must not repeat a key");
  }
  const pw = record(progress.weights, "progress.weights");
  exactKeys(pw, "progress.weights", [
    "merged_product_pr",
    "criterion_closed",
    "epic_accepted",
  ]);

  const ceremony = record(root.ceremony, "ceremony");
  exactKeys(ceremony, "ceremony", ["free_rounds", "weights", "unmeasured"]);
  const cw = record(ceremony.weights, "ceremony.weights");
  exactKeys(cw, "ceremony.weights", [
    "rounds_beyond_free",
    "followups_minted",
    "sdlc_issues_opened",
  ]);
  const unmeasuredRaw = record(ceremony.unmeasured, "ceremony.unmeasured");
  const unmeasured: Record<string, string> = {};
  for (const [k, v] of Object.entries(unmeasuredRaw)) {
    if (typeof v !== "string" || v.trim() === "") {
      bad(`ceremony.unmeasured.${k}`, "must state why it cannot be measured");
    }
    unmeasured[k] = v as string;
  }

  // `tail_blocked` is optional (its defaults are the epic census's definition),
  // so a file written before the census still loads.
  const { tail_blocked: rawTail, ...requiredSignals } = record(
    root.signals,
    "signals",
  );
  const signals = requiredSignals;
  exactKeys(signals, "signals", [
    "stuck_epic",
    "ceremony_ratio",
    "followup_depth",
    "delivery_system_share",
    "review_carousel",
  ]);
  const stuck = record(signals.stuck_epic, "signals.stuck_epic");
  exactKeys(stuck, "signals.stuck_epic", ["days"]);
  const ratio = record(signals.ceremony_ratio, "signals.ceremony_ratio");
  exactKeys(ratio, "signals.ceremony_ratio", [
    "suspect_at",
    "high_at",
    "min_ceremony",
  ]);
  const suspectAt = num(ratio, "suspect_at", "signals.ceremony_ratio", {
    min: 0,
  });
  const highAt = num(ratio, "high_at", "signals.ceremony_ratio", { min: 0 });
  if (highAt < suspectAt) {
    bad("signals.ceremony_ratio.high_at", "must not be below suspect_at");
  }
  const depth = record(signals.followup_depth, "signals.followup_depth");
  exactKeys(depth, "signals.followup_depth", ["suspect_at", "max_walk"]);
  const share = record(
    signals.delivery_system_share,
    "signals.delivery_system_share",
  );
  exactKeys(share, "signals.delivery_system_share", ["suspect_at"]);
  const shareAt = share.suspect_at;
  if (shareAt !== null) {
    num(share, "suspect_at", "signals.delivery_system_share", {
      min: 0,
      max: 1,
    });
  }
  const carousel = record(signals.review_carousel, "signals.review_carousel");
  exactKeys(carousel, "signals.review_carousel", [
    "min_rounds",
    "high_rounds",
    "min_post_review_share",
  ]);
  const minRounds = num(carousel, "min_rounds", "signals.review_carousel", {
    min: 1,
    integer: true,
  });
  const highRounds = num(carousel, "high_rounds", "signals.review_carousel", {
    min: 1,
    integer: true,
  });
  if (highRounds < minRounds) {
    bad("signals.review_carousel.high_rounds", "must not be below min_rounds");
  }
  // fleet-health.ts skips sampling a PR with at most `free_rounds` reviewed
  // heads, so a carousel threshold at or below it could never be measured.
  const freeRounds = num(ceremony, "free_rounds", "ceremony", {
    min: 0,
    integer: true,
  });
  if (minRounds <= freeRounds) {
    bad(
      "signals.review_carousel.min_rounds",
      "must exceed ceremony.free_rounds (PRs at or below it are never sampled)",
    );
  }
  const lifecycle = record(root.lifecycle, "lifecycle");
  exactKeys(lifecycle, "lifecycle", ["cooldown_days"]);

  return {
    version: 1,
    window: {
      days: num(window, "days", "window", { min: 1, max: 366, integer: true }),
    },
    progress: {
      productAreas: areas as string[],
      weights: {
        mergedProductPr: num(pw, "merged_product_pr", "progress.weights", {
          min: 0,
        }),
        criterionClosed: num(pw, "criterion_closed", "progress.weights", {
          min: 0,
        }),
        epicAccepted: num(pw, "epic_accepted", "progress.weights", { min: 0 }),
      },
    },
    ceremony: {
      freeRounds: num(ceremony, "free_rounds", "ceremony", {
        min: 0,
        integer: true,
      }),
      weights: {
        roundsBeyondFree: num(cw, "rounds_beyond_free", "ceremony.weights", {
          min: 0,
        }),
        followupsMinted: num(cw, "followups_minted", "ceremony.weights", {
          min: 0,
        }),
        sdlcIssuesOpened: num(cw, "sdlc_issues_opened", "ceremony.weights", {
          min: 0,
        }),
      },
      unmeasured,
    },
    signals: {
      stuckEpic: {
        days: num(stuck, "days", "signals.stuck_epic", {
          min: 1,
          max: 366,
          integer: true,
        }),
      },
      tailBlocked: parseTailBlocked(rawTail),
      ceremonyRatio: {
        suspectAt,
        highAt,
        minCeremony: num(ratio, "min_ceremony", "signals.ceremony_ratio", {
          min: 1,
          integer: true,
        }),
      },
      followupDepth: {
        suspectAt: num(depth, "suspect_at", "signals.followup_depth", {
          min: 1,
          integer: true,
        }),
        maxWalk: num(depth, "max_walk", "signals.followup_depth", {
          min: 1,
          max: 20,
          integer: true,
        }),
      },
      deliverySystemShare: {
        suspectAt: shareAt === null ? null : (shareAt as number),
      },
      reviewCarousel: {
        minRounds,
        highRounds,
        minPostReviewShare: num(
          carousel,
          "min_post_review_share",
          "signals.review_carousel",
          { min: 0, max: 1 },
        ),
      },
    },
    lifecycle: {
      cooldownDays: num(lifecycle, "cooldown_days", "lifecycle", {
        min: 0,
        integer: true,
      }),
    },
    teamKey: ctx.teamKey,
    labels,
    ledger: parseLedger(rawLedger, labels),
    mergeConflicts: {
      coverageFloor: num(conflicts, "coverage_floor", "merge_conflicts", {
        min: 0,
        max: 1,
      }),
    },
    baselines: parseBaselines(rawBaselines),
    root: ctx.root,
    catalogPath: ctx.catalogPath,
  };
}

/**
 * Load the consumer's configuration. With no argument, the path is the
 * consumer's (`fleet_health.config`, resolved against `consumerRoot()`). With
 * a path, the consumer repository is the one that holds it, so a caller
 * running outside the checkout still reads that repository's overlay.
 */
export function loadConfig(path?: string): FleetHealthConfig {
  const root =
    path === undefined ? consumerRoot() : consumerRoot(dirname(resolve(path)));
  const ctx = overlayContext(root);
  const file = path ?? ctx.configPath ?? join(root, CONFIG_RELPATH);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new FleetHealthConfigError(
      `${CONFIG_RELPATH}: could not be read (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  let raw: unknown;
  try {
    raw = loadYaml(text);
  } catch (err) {
    throw new FleetHealthConfigError(
      `${CONFIG_RELPATH}: is not valid YAML (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return parseConfig(raw, ctx);
}
