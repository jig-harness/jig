/** The site's additions to the Protocol's source Markdown. */
import { Defect } from "../../../plugin/shared/outcome.ts";
import { SITE_ORIGIN } from "./origin.ts";

/** Keep the prose and tables; turn each generated value into a link target. */
export function chapterBody(
  source: string,
  chapter?: { chapter: string; version: number },
): string {
  const seen = new Set<string>();
  const linked = chapter
    ? source.replaceAll(
        `(data/${chapter.chapter}.json)`,
        `(/protocol/${chapter.chapter}/v${chapter.version}/data.json)`,
      )
    : source;
  return linked
    .replace(/^# .+\n/, "")
    .replace(/^Version \d+ · .+$/m, "")
    .replace(
      /(<!-- protocol:generated [^>]+-->)([\s\S]*?)(<!-- \/protocol:generated -->)/g,
      (_all, start: string, table: string, end: string) => {
        const rows = table.split("\n");
        let header = true;
        return (
          start +
          rows
            .map((line) => {
              if (!line.startsWith("|")) return line;
              if (header) {
                header = false;
                return line;
              }
              if (/^\|[\s:|-]+\|\s*$/.test(line)) return line;
              return line.replace(
                /^(\|\s*)([^|]+)(\|)/,
                (_row, lead: string, cell: string, tail: string) => {
                  const value = cell.trim().replace(/`/g, "");
                  const base = `value-${encodeURIComponent(value).replaceAll("%", "-")}`;
                  let id = base;
                  for (let n = 2; seen.has(id); n++) id = `${base}-${n}`;
                  seen.add(id);
                  return `${lead}<a id="${id}" href="#${id}">${cell.trim()}</a> ${tail}`;
                },
              );
            })
            .join("\n") +
          end
        );
      },
    );
}

/** Publish a schema unchanged under the chapter/version named in its $id. */
export function schemaResource(
  text: string,
  file: string,
  chapters: readonly { chapter: string; version: number }[],
): { route: string; text: string } {
  const schema: unknown = JSON.parse(text);
  if (
    typeof schema !== "object" ||
    schema === null ||
    !("$id" in schema) ||
    typeof schema.$id !== "string"
  )
    throw new Defect(`Protocol schema ${file} needs a $id`);
  const segments = new URL(schema.$id, SITE_ORIGIN).pathname.split("/");
  const matches = chapters.filter(
    (chapter) =>
      segments.includes(chapter.chapter) &&
      (segments.includes(`v${chapter.version}`) ||
        segments.includes(String(chapter.version))),
  );
  const chapter = matches.length === 1 ? matches[0] : undefined;
  if (!chapter)
    throw new Defect(
      `Protocol schema ${file} needs an unambiguous chapter/version in its $id`,
    );
  return {
    route: `${chapter.chapter}/v${chapter.version}/schemas/${file}`,
    text,
  };
}

/** The index links each data file to the version listed beside its chapter. */
export function indexBody(
  source: string,
  chapters: readonly { chapter: string; version: number }[],
): string {
  let linked = source;
  for (const chapter of chapters)
    linked = linked.replaceAll(
      `(data/${chapter.chapter}.json)`,
      `(/protocol/${chapter.chapter}/v${chapter.version}/data.json)`,
    );
  return linked.replace(/^# .+\n/, "");
}
