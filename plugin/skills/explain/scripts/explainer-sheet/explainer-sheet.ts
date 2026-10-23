#!/usr/bin/env bun
/**
 * Explainer sheet CLI for `/explain`. One explainer source in, two
 * projections out: the HTML sheet and the markdown text. Usage and the
 * posting procedure: `references/explainer-sheet.md`.
 *
 *   bun explainer-sheet.ts render <source.json> [--out <dir>] [--require-fresh]
 *   bun explainer-sheet.ts validate <source.json>
 *   bun explainer-sheet.ts extract <sheet.html>
 *
 * A source with figures needs each figure built first, by the repository's
 * figure build (`explain.figure_build_command`); `render` reads
 * `<stem>.figure.svg` next to the diagram source and refuses a missing,
 * stale or unsafe one.
 *
 * Exit codes: 0 ok · 1 usage, invalid input or a figure that cannot be
 * embedded · 3 `--require-fresh` and the freshness check failed, a cited file
 * changed since `verifiedAt.commit`, or a cited path does not exist at that
 * commit (nothing written).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  checkFreshness,
  type Freshness,
  repositoryRoot,
} from "../../../decide/scripts/sheet-kit/freshness.ts";
import {
  adrDirectory,
  figureBuildCommand,
  readOptionalOverlay,
} from "../../../decide/scripts/lib/overlay.ts";
import { extractEmbedded } from "../../../decide/scripts/sheet-kit/html.ts";
import { figureDomId, figureFile, figureProblems, sha256 } from "./figures.ts";
import { renderExplainerHtml, SOURCE_BLOCK_ID } from "./html.ts";
import { renderMarkdown, sheetFilename } from "./markdown.ts";
import {
  citations,
  diagramStem,
  type ExplainerSource,
  parseSource,
  SourceError,
} from "./source.ts";

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--out"]);
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  validate: [],
  render: ["--require-fresh", "--out"],
  extract: [],
};

function rejectUnknownFlags(command: string, args: string[]): void {
  const allowed = COMMAND_FLAGS[command] ?? [];
  // Every `--` token is a flag: `flag()` refuses a value that starts with
  // `--`, so no token after a value flag is exempt from this check.
  const flags = args.filter((a) => a.startsWith("--"));
  const unknown = flags.filter((a) => !allowed.includes(a));
  if (unknown.length > 0)
    throw new UsageError(
      `unknown flag for ${command}: ${unknown.join(", ")}${allowed.length ? `; it accepts ${allowed.join(", ")}` : "; it takes no flags"}`,
    );
  // `flag()` reads only the first occurrence, so a repeat would be ignored.
  const repeated = flags.filter((a, i) => flags.indexOf(a) !== i);
  if (repeated.length > 0)
    throw new UsageError(
      `flag given more than once for ${command}: ${[...new Set(repeated)].join(", ")}`,
    );
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--"))
    throw new UsageError(`${name} needs a value`);
  return value;
}

function positional(args: string[], what: string): string {
  const value = args.find(
    (a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1] ?? ""),
  );
  if (!value) throw new UsageError(`missing ${what}`);
  return value;
}

const readSource = (path: string) =>
  parseSource(JSON.parse(readFileSync(path, "utf8")));

function repoRoot(): string {
  const root = repositoryRoot();
  if (root === undefined)
    throw new UsageError(
      "not inside a git repository; run from a checkout of the repository the source cites",
    );
  return root;
}

/** Load and check every figure of the source. Any problem is fatal: a figure is never left out silently. */
export function loadFigures(
  source: ExplainerSource,
  root: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const problems: string[] = [];
  const figures = source.figures ?? [];
  const build =
    figures.length > 0 ? figureBuildCommand(readOptionalOverlay(root)) : "";
  for (const f of figures) {
    const stem = diagramStem(f.diagram);
    const diagramPath = join(root, f.diagram);
    const built = join(root, figureFile(f.diagram));
    if (!existsSync(diagramPath)) {
      problems.push(`figure ${f.id}: no diagram source at ${f.diagram}`);
      continue;
    }
    if (!existsSync(built)) {
      problems.push(
        build
          ? `figure ${f.id}: ${figureFile(f.diagram)} is not built; run ${build} ${stem}`
          : `figure ${f.id}: ${figureFile(f.diagram)} is not built; build it with the repository's figure build (set explain.figure_build_command)`,
      );
      continue;
    }
    const svg = readFileSync(built, "utf8");
    const found = figureProblems(svg, stem, sha256(readFileSync(diagramPath)));
    if (found.length > 0)
      problems.push(
        ...found.map(
          (p) =>
            `figure ${f.id} (${figureFile(f.diagram)}, #${figureDomId(stem)}): ${p}`,
        ),
      );
    else out.set(f.id, svg.trim());
  }
  if (problems.length > 0)
    throw new UsageError(
      `cannot embed the figures:\n- ${problems.join("\n- ")}`,
    );
  return out;
}

/** Said in every successful render summary: a clean scan is not a verdict that the claims are true. */
const FRESHNESS_SCOPE =
  "Staleness check only: it finds cited files that changed since verifiedAt.commit. It cannot tell whether a claim about them is true; that needs a reader.";

function main(argv: string[]): number {
  const [command, ...args] = argv;
  if (command !== undefined && command in COMMAND_FLAGS)
    rejectUnknownFlags(command, args);
  switch (command) {
    case "validate": {
      const source = readSource(positional(args, "<source.json>"));
      console.log(
        JSON.stringify({
          ok: true,
          id: source.id,
          steps: source.flow?.length ?? 0,
          sections: source.sections.length,
          figures: source.figures?.length ?? 0,
        }),
      );
      return 0;
    }
    case "render": {
      const source = readSource(positional(args, "<source.json>"));
      const root = repoRoot();
      let freshness: Freshness | { error: string };
      try {
        freshness = checkFreshness(
          citations(source),
          source.verifiedAt.commit,
          root,
          adrDirectory(readOptionalOverlay(root), root),
        );
      } catch (err) {
        freshness = { error: (err as Error).message };
      }
      if (args.includes("--require-fresh")) {
        if ("error" in freshness) {
          console.error(`refusing to render for posting: ${freshness.error}`);
          return 3;
        }
        if (freshness.changed.length > 0) {
          console.error(
            `refusing to render for posting: cited files changed since ${freshness.commit}:\n- ${freshness.changed.join("\n- ")}\nRe-verify the claims that cite them, update verifiedAt, and render again.`,
          );
          return 3;
        }
        if (freshness.unresolved.length > 0) {
          console.error(
            `refusing to render for posting: these cited paths do not exist at ${freshness.commit}, so the guard cannot check them:\n- ${freshness.unresolved.join("\n- ")}\nCite repository-rooted paths, then render again.`,
          );
          return 3;
        }
      }
      const figures = loadFigures(source, root);
      const out = resolve(
        flag(args, "--out") ?? join(root, ".context", "explain", source.id),
      );
      mkdirSync(out, { recursive: true });
      const html = renderExplainerHtml(source, figures);
      const files = {
        sheet: join(out, sheetFilename(source)),
        markdown: join(out, `${source.id}.md`),
      };
      writeFileSync(files.sheet, html);
      writeFileSync(files.markdown, renderMarkdown(source));
      console.log(
        JSON.stringify(
          {
            id: source.id,
            freshness,
            freshnessScope: FRESHNESS_SCOPE,
            files,
            attachment: {
              filename: sheetFilename(source),
              contentType: "text/html",
              size: Buffer.byteLength(html),
              title: `Explainer: ${source.title}`,
              subtitle: `facts verified ${source.verifiedAt.date} @ ${source.verifiedAt.commit}`,
            },
          },
          null,
          2,
        ),
      );
      return 0;
    }
    case "extract": {
      const html = readFileSync(positional(args, "<sheet.html>"), "utf8");
      const source = parseSource(
        extractEmbedded(html, SOURCE_BLOCK_ID, "explainer source").value,
      );
      console.log(JSON.stringify(source, null, 2));
      return 0;
    }
    default:
      throw new UsageError(
        `unknown command ${command ?? "(none)"}; use render, validate or extract`,
      );
  }
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    if (err instanceof SourceError || err instanceof UsageError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

export { main };
