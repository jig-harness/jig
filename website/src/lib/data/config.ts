/**
 * Where an organization's values live: the configuration layers
 * (plugin/CONFIGURATION.md) and the tracker interface the skills call
 * (plugin/README.md), whose operations the factory page draws.
 */
import { paragraphs, section, sections, tableRows } from "../source.ts";

export interface Layer {
  n: string;
  name: string;
  where: string;
  holds: string;
}

export function parseLayers(configuration: string): {
  layers: Layer[];
  flags: string;
} {
  const body = section(sections(configuration), "Configuration layers");
  return {
    layers: tableRows(body)
      .filter((r) => r.length === 3)
      .map(([layer = "", where = "", holds = ""]) => ({
        n: layer.split(".")[0] ?? "",
        name: layer.replace(/^\d+\.\s*/, ""),
        where,
        holds,
      })),
    flags:
      paragraphs(body).find((p) => p.startsWith("Command-line flags")) ?? "",
  };
}

/** The paragraph on how the skills reach the tracker, and the operations it lists. */
export function parseTrackerInterface(pluginReadme: string): {
  paragraph: string;
  operations: string[];
} {
  const paragraph =
    paragraphs(pluginReadme).find((p) =>
      p.startsWith("**How the skills reach the issue tracker"),
    ) ?? "";
  const inner =
    /tracker interface\]\([^)]*\)\s*\(([^)]*)\)/.exec(
      paragraph.replace(/\s*\n\s*/g, " "),
    )?.[1] ?? "";
  return {
    paragraph,
    operations: inner
      .split(/,\s*/)
      .map((op) => op.trim())
      .filter(Boolean),
  };
}
