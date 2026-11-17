/** Read or append an item's predicted paths through the tracker's footprint port. */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { consumerRoot, readConfig } from "../../../../shared/consumer.ts";
import { isRecord } from "../../../../shared/guards.ts";
import {
  footprintBody,
  type FootprintRecord,
} from "../../../../shared/footprint.ts";
import { recordKind } from "../../../../shared/records/registry.ts";
import { localWriter } from "../../../../shared/records/writer.ts";
import { currentIso } from "../../../../shared/time.ts";
import { OutboundError } from "../../../../shared/outbound/failure.ts";
import { withOperation } from "../../../../shared/outbound/ledger.ts";
import { loadCatalogFile } from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";
import { openTracker } from "./tracker/index.ts";
import { TrackerRequestError, type Tracker } from "./tracker/port.ts";
import type { AttachmentOperation } from "./attachment-ops.ts";

const MAX_INPUT_BYTES = 2_000_000;
function invalid(message: string, cause?: unknown): TrackerRequestError {
  const error = new TrackerRequestError("invalid", `footprint: ${message}`);
  if (cause !== undefined) error.cause = cause;
  return error;
}

async function boundedInput(path: string): Promise<string> {
  if ((await stat(path)).size > MAX_INPUT_BYTES)
    throw invalid("input exceeds 2,000,000 bytes");
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw) > MAX_INPUT_BYTES)
    throw invalid("input exceeds 2,000,000 bytes");
  return raw;
}
function inputRecord(key: string, raw: string): FootprintRecord {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (cause) {
    throw invalid("input is not JSON", cause);
  }
  if (!isRecord(input)) throw invalid("input must be a JSON object");
  const allowed = new Set([
    "key",
    "source",
    "base",
    "paths",
    "areas",
    "pickup",
  ]);
  if (Object.keys(input).some((field) => !allowed.has(field)))
    throw invalid("unknown input field");
  if (input.key !== undefined && input.key !== key)
    throw invalid("input key does not match the argument");
  const record = {
    ...input,
    key,
    writer: localWriter("tracker"),
    at: currentIso(),
  } as FootprintRecord;
  try {
    footprintBody(record);
  } catch (cause) {
    if (!(cause instanceof OutboundError) || cause.code !== "invalid")
      throw cause;
    throw invalid(`invalid prediction payload: ${cause.message}`, cause);
  }
  return record;
}
function ownAreaLabels(): Record<string, readonly string[]> {
  const config = readConfig();
  const drive = isRecord(config?.drive) ? config.drive : {};
  if (drive.change_areas_catalog === undefined) return {};
  if (typeof drive.change_areas_catalog !== "string")
    throw invalid("drive.change_areas_catalog must be a path");
  const catalog = loadCatalogFile(
    resolve(consumerRoot(), drive.change_areas_catalog),
  );
  return Object.fromEntries(
    [...catalog].map(([key, area]) => [key, area.labels]),
  );
}
interface Dependencies {
  tracker(): Pick<Tracker, "getIssue" | "footprints" | "writeFootprint">;
  readInput(path: string): Promise<string>;
  areaLabels(): Record<string, readonly string[]>;
}

async function readPrediction(key: string, deps: Dependencies) {
  const tracker = deps.tracker();
  const issue = await tracker.getIssue(key);
  if (issue === null)
    throw new OutboundError("not-found", `footprint item ${key} was not found`);
  const readings = await tracker.footprints(
    [
      {
        key: issue.identifier,
        labels: issue.labels,
        ...(issue.updatedAt === undefined
          ? {}
          : { updatedAt: issue.updatedAt }),
      },
    ],
    {
      cycle: {},
      scopeRead: currentIso(),
      cache: new Map(),
      areaLabels: deps.areaLabels(),
    },
  );
  return readings.get(issue.identifier);
}

/** Dependency injection keeps command validation testable without a tracker credential. */
export function footprintOperations(
  deps: Dependencies = {
    tracker: openTracker,
    readInput: boundedInput,
    areaLabels: ownAreaLabels,
  },
): Record<string, AttachmentOperation> {
  return {
    footprint: {
      arity: 1,
      takes: "one issue key, optionally --input prediction.json",
      input: "input",
      indent: true,
      async run([key], _flags, input) {
        if (
          key === undefined ||
          !recordKind("tracker-footprint")?.key?.test(key)
        )
          throw invalid("expected an item key like #123 or ENG-123");
        if (input !== undefined) {
          const record = inputRecord(key, await deps.readInput(input));
          await deps.tracker().writeFootprint(record);
          return { issue: key, written: true };
        }
        return withOperation("footprint", () => readPrediction(key, deps));
      },
    },
  };
}
