/** Read the installed Protocol documents and their generated data at build time. */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Defect } from "../../../plugin/shared/outcome.ts";
import { read, repoRoot } from "./site.ts";
import { schemaResource } from "./protocol.ts";

interface ProtocolChapter {
  chapter: string;
  title: string;
  version: number;
  status: string;
  planItems: { item: number }[];
  values: Record<string, unknown>[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChapter(text: string): ProtocolChapter {
  const data: unknown = JSON.parse(text);
  if (
    !record(data) ||
    typeof data.chapter !== "string" ||
    !/^[a-z0-9-]+$/.test(data.chapter) ||
    typeof data.title !== "string" ||
    typeof data.version !== "number" ||
    !Number.isInteger(data.version) ||
    data.version < 1 ||
    (data.status !== "stable" && data.status !== "provisional") ||
    !Array.isArray(data.values) ||
    !data.values.every(record)
  )
    throw new Defect(
      "Invalid generated Protocol chapter data; regenerate the Protocol",
    );
  const planItems: { item: number }[] = [];
  if (data.planItems !== undefined) {
    if (!Array.isArray(data.planItems))
      throw new Defect("Invalid Protocol plan items");
    for (const item of data.planItems) {
      if (!record(item) || typeof item.item !== "number")
        throw new Defect("Invalid Protocol plan item");
      planItems.push({ item: item.item });
    }
  }
  return {
    chapter: data.chapter,
    title: data.title,
    version: data.version,
    status: data.status,
    planItems,
    values: data.values,
  };
}

export function protocolChapters(): ProtocolChapter[] {
  return readdirSync(join(repoRoot, "plugin/protocol/data"))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => parseChapter(read(`plugin/protocol/data/${file}`)));
}

export function protocolResources(): { route: string; text: string }[] {
  const chapters = protocolChapters();
  const data = chapters.map((chapter) => ({
    route: `${chapter.chapter}/v${chapter.version}/data.json`,
    text: read(`plugin/protocol/data/${chapter.chapter}.json`),
  }));
  const dir = join(repoRoot, "plugin/protocol/schemas");
  if (!existsSync(dir)) return data;
  const schemas = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const resource = schemaResource(
        read(`plugin/protocol/schemas/${file}`),
        file,
        chapters,
      );
      return resource;
    });
  return [...data, ...schemas];
}
