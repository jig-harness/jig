#!/usr/bin/env bun
/**
 * Decision sheet CLI for `/decide`. One decision source in, three
 * projections out: the HTML sheet, the full markdown elaboration and the short
 * tracker comment. Usage and the posting procedure:
 * `references/decision-sheet.md`.
 *
 *   bun decision-sheet.ts render <source.json> [--template compact|document] [--out <dir>] [--require-fresh]
 *   bun decision-sheet.ts validate <source.json>
 *   bun decision-sheet.ts trigger --facets <a,b> --options <n,m> [--human-asked]
 *   bun decision-sheet.ts extract <sheet.html>
 *   bun decision-sheet.ts template <sheet.html>
 *   bun decision-sheet.ts stale-attachments --keep <attachment-id> < issue.json
 *
 * Exit codes: 0 ok · 1 usage or invalid input · 3 `--require-fresh` and the
 * freshness check failed, a cited file changed since `verifiedAt.commit`, or a
 * cited path does not exist at that commit (nothing written).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AttachmentRow,
  sheetAttachmentTitle,
  staleSheetAttachments,
} from "./attachments.ts";
import { adrDirectory, readOptionalOverlay } from "../lib/overlay.ts";
import { checkFreshness, type Freshness } from "./freshness.ts";
import { repositoryRoot } from "../sheet-kit/freshness.ts";
import { renderHtml } from "./html.ts";
import {
  DEFAULT_TEMPLATE,
  extractSource,
  extractTemplate,
  SHEET_TEMPLATES,
  type SheetTemplate,
} from "./html-shared.ts";
import { renderComment, renderElaboration, sheetFilename } from "./markdown.ts";
import {
  decisionStatus,
  parseSource,
  SourceError,
  STAKEHOLDER_FACETS,
  sheetTrigger,
  triggerForSource,
} from "./source.ts";

class UsageError extends Error {}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--"))
    throw new UsageError(`${name} needs a value`);
  return value;
}

const VALUE_FLAGS = new Set([
  "--out",
  "--keep",
  "--facets",
  "--options",
  "--template",
]);

/** Every flag each command accepts. A flag outside it is a typo, never ignored. */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  validate: [],
  render: ["--require-fresh", "--out", "--template"],
  trigger: ["--facets", "--options", "--human-asked"],
  extract: [],
  template: [],
  "stale-attachments": ["--keep"],
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

function positional(args: string[], what: string): string {
  const value = args.find(
    (a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1] ?? ""),
  );
  if (!value) throw new UsageError(`missing ${what}`);
  return value;
}

function readSource(path: string) {
  return parseSource(JSON.parse(readFileSync(path, "utf8")));
}

function templateFlag(args: string[]): SheetTemplate {
  const value = flag(args, "--template");
  if (value === undefined) return DEFAULT_TEMPLATE;
  if (!(SHEET_TEMPLATES as readonly string[]).includes(value))
    throw new UsageError(
      `--template takes ${SHEET_TEMPLATES.join(" or ")}; not: ${value}`,
    );
  return value as SheetTemplate;
}

function repoRoot(): string {
  const root = repositoryRoot();
  if (root === undefined)
    throw new UsageError(
      "not inside a git repository; pass --out and run from a checkout",
    );
  return root;
}

function numbers(value: string | undefined, name: string): number[] {
  if (value === undefined) return [];
  return value.split(",").map((part) => {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0)
      throw new UsageError(`${name} takes comma-separated whole numbers`);
    return n;
  });
}

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
          calls: source.calls.length,
          status: decisionStatus(source),
        }),
      );
      return 0;
    }
    case "render": {
      const path = positional(args, "<source.json>");
      const source = readSource(path);
      // A missing checkout is a freshness error, not a usage error: only the
      // default output directory needs the root.
      let root: string | undefined;
      let freshness: Freshness | { error: string };
      try {
        root = repoRoot();
        freshness = checkFreshness(
          source,
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
        // Fail closed: a citation the guard cannot resolve is one it did not check.
        if (freshness.unresolved.length > 0) {
          console.error(
            `refusing to render for posting: these cited paths do not exist at ${freshness.commit}, so the guard cannot check them:\n- ${freshness.unresolved.join("\n- ")}\nCite repository-rooted paths, then render again.`,
          );
          return 3;
        }
      }
      const template = templateFlag(args);
      const outFlag = flag(args, "--out");
      if (!outFlag && !root)
        throw new UsageError("not inside a git repository; pass --out");
      const out = resolve(
        outFlag ?? join(root as string, ".context", "decide", source.id),
      );
      mkdirSync(out, { recursive: true });
      const html = renderHtml(source, template);
      const files = {
        sheet: join(out, sheetFilename(source)),
        elaboration: join(out, `${source.id}-elaboration.md`),
        comment: join(out, `${source.id}-comment.md`),
      };
      writeFileSync(files.sheet, html);
      writeFileSync(files.elaboration, renderElaboration(source));
      writeFileSync(files.comment, renderComment(source));
      const size = Buffer.byteLength(html);
      console.log(
        JSON.stringify(
          {
            id: source.id,
            status: decisionStatus(source),
            template,
            trigger: triggerForSource(source),
            freshness,
            files,
            attachment: {
              filename: sheetFilename(source),
              contentType: "text/html",
              size,
              title: sheetAttachmentTitle(source.id),
              subtitle: `${decisionStatus(source)} · facts verified ${source.verifiedAt.date} @ ${source.verifiedAt.commit}`,
            },
          },
          null,
          2,
        ),
      );
      return 0;
    }
    case "trigger": {
      // Takes stakeholder names (`compliance`), which do not depend on how the repository names its
      // `hitl` label. The default label's prefix (`hitl:compliance`) is still accepted. Anything else is
      // not a stakeholder facet and must not count.
      const facets = (flag(args, "--facets") ?? "")
        .split(",")
        .map((f) => f.trim().replace(/^hitl:/, ""))
        .filter(Boolean);
      const unknown = facets.filter(
        (f) => !(STAKEHOLDER_FACETS as readonly string[]).includes(f),
      );
      if (unknown.length > 0)
        throw new UsageError(
          `--facets takes stakeholder names (${STAKEHOLDER_FACETS.join(", ")}); not: ${unknown.join(", ")}`,
        );
      console.log(
        JSON.stringify(
          sheetTrigger({
            stakeholderFacets: facets,
            optionCounts: numbers(flag(args, "--options"), "--options"),
            humanAsked: args.includes("--human-asked"),
          }),
        ),
      );
      return 0;
    }
    case "extract": {
      const source = parseSource(
        extractSource(readFileSync(positional(args, "<sheet.html>"), "utf8")),
      );
      console.log(JSON.stringify(source, null, 2));
      return 0;
    }
    case "template": {
      // The layout a posted sheet was made with, so a regenerated sheet keeps it.
      console.log(
        extractTemplate(readFileSync(positional(args, "<sheet.html>"), "utf8")),
      );
      return 0;
    }
    case "stale-attachments": {
      const keep = flag(args, "--keep");
      if (!keep) throw new UsageError("--keep <attachment-id> is required");
      const input: unknown = JSON.parse(readFileSync(0, "utf8"));
      const rows = Array.isArray(input)
        ? input
        : (input as { attachments?: unknown }).attachments;
      if (!Array.isArray(rows))
        throw new UsageError(
          'stdin must be an attachment array or an issue object with "attachments"',
        );
      console.log(
        JSON.stringify(staleSheetAttachments(rows as AttachmentRow[], keep)),
      );
      return 0;
    }
    default:
      throw new UsageError(
        `unknown command ${command ?? "(none)"}; use render, validate, trigger, extract, template or stale-attachments`,
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
