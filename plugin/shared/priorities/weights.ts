/**
 * The host's weights file, `$JIG_HOME/weights.local.yaml` (default
 * `~/.jig/weights.local.yaml`): the host's own, never committed, read again
 * on every tick so a change takes effect on the next one. Its `lanes`
 * section holds each weighted lane's weight (0 to 100). Its `accounts`
 * section, each account's weight for its share of new launches, is read by
 * the accounts allocation (issue #1402); this reader accepts it and leaves it
 * to that reader.
 *
 * It fails closed for what it cannot read: an invalid entry for a known lane
 * takes that lane out of rotation, while an unknown lane name, an unknown
 * section or a file that cannot be parsed takes every weighted lane out. A
 * broken file therefore never resumes a lane the person paused. A missing
 * file or entry means the built-in default. Every problem is named, for the
 * tick report.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jigHome } from "../config-layers.ts";
import { load } from "../yaml.ts";
import { isRecord } from "../guards.ts";
import {
  DEFAULT_WEIGHTS,
  isWeightedLane,
  WEIGHTED_LANES,
  type WeightedLane,
} from "./lanes.ts";

/** The lane weights read this tick: `null` is a lane taken out because its entry failed closed. */
export interface LaneWeights {
  weights: Record<WeightedLane, number | null>;
  /** Where they were read from, or that the defaults apply. */
  source: string;
  /** Each problem found, in plain language; empty when the file read cleanly. */
  problems: string[];
}

const WEIGHTS_FILE = "weights.local.yaml";

/** The weights file's path. */
export function weightsFilePath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jigHome(env), WEIGHTS_FILE);
}

/** Read the weights file now; a missing file is the defaults. */
export function readLaneWeights(file: string = weightsFilePath()): LaneWeights {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        weights: { ...DEFAULT_WEIGHTS },
        source: "defaults",
        problems: [],
      };
    return allOut(file, `${file} cannot be read: ${(error as Error).message}`);
  }
  return parseLaneWeights(raw, file);
}

/** The weights file's text, already read; `file` names it in problems. */
export function parseLaneWeights(raw: string, file: string): LaneWeights {
  let values: unknown;
  try {
    values = load(raw);
  } catch (error) {
    return allOut(
      file,
      `${file} is not YAML: ${(error as Error).message.split("\n")[0]}`,
    );
  }
  if (values === null || values === undefined)
    return { weights: { ...DEFAULT_WEIGHTS }, source: file, problems: [] };
  if (!isRecord(values)) return allOut(file, `${file} is not a mapping`);
  for (const key of Object.keys(values))
    if (key !== "lanes" && key !== "accounts")
      return allOut(file, `${file} has an unknown section \`${key}\``);
  const lanes = values.lanes;
  if (lanes === undefined)
    return { weights: { ...DEFAULT_WEIGHTS }, source: file, problems: [] };
  if (!isRecord(lanes))
    return allOut(file, `${file}: \`lanes\` is not a mapping`);
  for (const key of Object.keys(lanes))
    if (!isWeightedLane(key))
      return allOut(
        file,
        `${file}: \`lanes\` names an unknown lane \`${key}\` (known: ${WEIGHTED_LANES.join(", ")})`,
      );
  const weights = { ...DEFAULT_WEIGHTS } as Record<WeightedLane, number | null>;
  const problems: string[] = [];
  for (const lane of WEIGHTED_LANES) {
    if (!(lane in lanes)) continue;
    const value = lanes[lane];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 100
    ) {
      weights[lane] = null;
      problems.push(
        `${file}: lanes.${lane} is ${JSON.stringify(value)}, not a number from 0 to 100; ${lane} is out of rotation`,
      );
    } else weights[lane] = value;
  }
  return { weights, source: file, problems };
}

function allOut(file: string, problem: string): LaneWeights {
  const weights = {} as Record<WeightedLane, number | null>;
  for (const lane of WEIGHTED_LANES) weights[lane] = null;
  return {
    weights,
    source: file,
    problems: [`${problem}; every weighted lane is out of rotation`],
  };
}
