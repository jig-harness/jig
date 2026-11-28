/**
 * A repository whose tracker part the newest tick kept from an earlier
 * reading, for want of a credential (`trackerKept`): the repository list
 * marks it with that reading's time and what was missing, and the list's
 * head counts it, so kept cards do not read as fresh. A repository whose
 * tracker was asked carries no mark.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { fixture } from "../fixtures.ts";
import { RepoRows } from "./line.tsx";
import { type Clock, repoSummary } from "./view.ts";

const NOW = Date.UTC(2026, 10, 3, 16, 47, 30);
const CLOCK: Clock = { nowMs: NOW, timeZone: "UTC" };
const KEPT_AT = new Date(Date.UTC(2026, 10, 3, 14, 30)).toISOString();
const REASON = "no Linear key configured";

function lineWithKept(): { line: LineSnapshot; kept: string; asked: string } {
  const { line } = fixture("loud");
  if (line === null) throw new Error("the loud scenario has no line");
  const [first, second] = line.repos;
  if (first === undefined || second === undefined)
    throw new Error("the loud scenario has fewer than two repositories");
  return {
    line: {
      ...line,
      repos: line.repos.map((r) =>
        r === first
          ? {
              ...r,
              trackerKept: {
                readAt: KEPT_AT,
                runId: "earlier",
                reason: REASON,
              },
            }
          : r,
      ),
    },
    kept: first.slug ?? first.path,
    asked: second.slug ?? second.path,
  };
}

/** The `<dd>` the list renders for the repository named `name`. */
function rowOf(html: string, name: string): string {
  const at = html.indexOf(`<dt class="m">${name}</dt>`);
  if (at < 0) throw new Error(`no row for ${name}`);
  const end = html.indexOf("</dd>", at);
  return html.slice(at, end);
}

describe("a repository whose tracker part is kept", () => {
  it("carries the mark, the kept reading's time and the reason; one whose tracker was asked carries none", () => {
    const { line, kept, asked } = lineWithKept();
    const html = renderToStaticMarkup(
      <RepoRows repos={line.repos} clock={CLOCK} />,
    );
    const row = rowOf(html, kept);
    expect(row).toContain('<span class="chip">tracker kept</span>');
    expect(row).toContain(
      `as of the 14:30 reading, 2 h 17 min ago (${REASON})`,
    );
    expect(rowOf(html, asked)).not.toContain("tracker kept");
    expect(html.match(/tracker kept/g)?.length).toBe(1);
  });

  it("says when no tick has read its tracker with a credential", () => {
    const { line, kept } = lineWithKept();
    const html = renderToStaticMarkup(
      <RepoRows
        repos={line.repos.map((r) =>
          (r.slug ?? r.path) === kept
            ? { ...r, trackerKept: { readAt: null, reason: REASON } }
            : r,
        )}
        clock={CLOCK}
      />,
    );
    expect(rowOf(html, kept)).toContain(
      `No tick has read its tracker with a credential, so it shows no item cards or needs about items (${REASON})`,
    );
  });

  it("is counted in the list's head, which shows while the list is folded", () => {
    const { line } = lineWithKept();
    expect(repoSummary(line.repos)).toContain(", 1 with its tracker kept");
    const { line: plain } = fixture("loud");
    expect(repoSummary(plain?.repos ?? [])).not.toContain("tracker kept");
  });
});
