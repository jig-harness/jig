/**
 * Source text to HTML: issue ids become links, and the
 * first use of a glossary term in a region becomes a link to its entry with
 * the meaning in a tooltip. Everything else is escaped text.
 *
 * Nothing here finds a reference by pattern in prose, except the issue id:
 * the shape of the sheet's own tracker (`ENG-1234`, `#1234`) is unambiguous.
 * A genre that links its own ids (an option, a step) does it with an explicit
 * token, before calling `textHtml`.
 */
import {
  type IssueKeys,
  numberKeys,
  teamKeys,
} from "../../../do-item/scripts/lib/tracker/keys.ts";
import { esc, reEscape, slug } from "./html.ts";

export interface GlossaryEntry {
  term: string;
  meaning: string;
}

interface Term {
  id: string;
  meaning: string;
  pattern: RegExp;
}

/** One anchor id per glossary entry, unique even when two terms slug to the same text. */
export function glossaryIds(glossary: readonly GlossaryEntry[]): string[] {
  const used = new Set<string>();
  return glossary.map((g, i) => {
    const base = slug(g.term) || String(i + 1);
    let id = `t-${base}`;
    for (let n = 2; used.has(id); n++) id = `t-${base}-${n}`;
    used.add(id);
    return id;
  });
}

function termsOf(glossary: readonly GlossaryEntry[], ids: string[]): Term[] {
  const out: Term[] = [];
  glossary.forEach((g, i) => {
    const id = ids[i] as string;
    const parts = [g.term];
    // "Keep / Delete" is two words on the page: mark each capitalised part too.
    if (g.term.includes(" / "))
      for (const p of g.term.split(" / ")) if (/^[A-Z]/.test(p)) parts.push(p);
    for (const p of parts) {
      const first = p.charAt(0);
      out.push({
        id,
        meaning: g.meaning,
        pattern: new RegExp(
          `(^|[^\\wÀ-ÿ-])([${reEscape(first.toUpperCase())}${reEscape(first.toLowerCase())}]${reEscape(p.slice(1))})(?![\\wÀ-ÿ])`,
        ),
      });
    }
  });
  return out;
}

/** Which ids in prose are issues, and the web address of each. */
export interface IssueLinks {
  keys: IssueKeys;
  href(key: string): string;
}

/**
 * How a sheet links issue ids, from the web address of its own issue, so no
 * organisation name is written here. A GitHub issue
 * (`https://github.com/<owner>/<repo>/issues/<n>`) links `#<n>` to that
 * repository's issue; another tracker's (`…/issue/<TEAM>-<n>`) links the
 * keys of `team`, else of the team the address names, to the same path.
 * `undefined` when the address names no issue.
 */
export function issueLinks(
  url: string | undefined,
  team?: string,
): IssueLinks | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    return undefined;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  return parsed.hostname === "github.com" && parts[2] === "issues"
    ? githubLinks(parsed.origin, parts)
    : teamLinks(parsed.origin, parts, team);
}

/** `#<n>` to `<origin>/<owner>/<repo>/issues/<n>`. */
function githubLinks(origin: string, parts: string[]): IssueLinks {
  const base = `${origin}/${parts.slice(0, 3).join("/")}/`;
  return {
    keys: numberKeys(`${parts[0]}/${parts[1]}`),
    href: (key) => base + key.replace(/^#/, ""),
  };
}

/** A team's keys to the path before `/issue/`, or `undefined` without one. */
function teamLinks(
  origin: string,
  parts: string[],
  team: string | undefined,
): IssueLinks | undefined {
  const at = parts.indexOf("issue");
  const named = team || /^([A-Z][A-Z0-9]*)-\d+$/.exec(parts[at + 1] ?? "")?.[1];
  if (at < 1 || !named) return undefined;
  const base = `${origin}/${parts.slice(0, at + 1).join("/")}/`;
  return { keys: teamKeys(named), href: (key) => base + key };
}

export interface InlineOptions {
  glossary: readonly GlossaryEntry[];
  /** An issue URL of the sheet; issue ids link to its tracker. No URL, no issue links. */
  issueUrl?: string;
  /** The team whose keys link, when the sheet's own id names it (`ENG`). */
  team?: string | undefined;
}

export interface Inline {
  /** The anchor id of each glossary entry, in order. */
  termIds: string[];
  /**
   * Plain text to HTML. `seen` is the region's set of terms already linked:
   * a term links at its first use in a region only.
   */
  textHtml(text: string, seen: Set<string>): string;
}

/** One instance per sheet: tooltip ids count up across the whole sheet. */
export function createInline(o: InlineOptions): Inline {
  const termIds = glossaryIds(o.glossary);
  const terms = termsOf(o.glossary, termIds);
  const links = issueLinks(o.issueUrl, o.team);
  const docId = links && new RegExp(links.keys.source, "g");
  let tips = 0;

  function textHtml(text: string, seen: Set<string>): string {
    const found: { at: number; end: number; html: string; term?: string }[] =
      [];
    if (links && docId)
      for (const m of text.matchAll(docId))
        found.push({
          at: m.index,
          end: m.index + m[0].length,
          html: `<a class="ref-x" href="${esc(links.href(m[0]))}">${esc(m[0])}</a>`,
        });
    for (const t of terms) {
      if (seen.has(t.id)) continue;
      const m = t.pattern.exec(text);
      if (!m) continue;
      const at = m.index + (m[1] ?? "").length;
      const hit = m[2] ?? "";
      const end = at + hit.length;
      if (found.some((f) => at < f.end && end > f.at)) continue;
      const tip = `tip-${++tips}`;
      found.push({
        at,
        end,
        term: t.id,
        html: `<span class="tw"><a class="term" href="#${esc(t.id)}" aria-describedby="${tip}">${esc(hit)}</a><span class="tip" role="tooltip" id="${tip}">${esc(t.meaning)}</span></span>`,
      });
    }
    found.sort((a, b) => a.at - b.at);
    let out = "";
    let last = 0;
    for (const f of found) {
      if (f.at < last) continue;
      out += esc(text.slice(last, f.at)) + f.html;
      last = f.end;
      if (f.term) seen.add(f.term);
    }
    return out + esc(text.slice(last));
  }

  return { termIds, textHtml };
}
