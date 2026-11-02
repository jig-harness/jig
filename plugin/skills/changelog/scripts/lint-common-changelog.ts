// The rules of Common Changelog (https://common-changelog.org/), checked over
// a whole changelog. Each rule is one the specification states with "must",
// cited at the rule with its numbered section; what it only recommends
// ("should": one line per change, breaking changes first, a link on every
// version) and what a file cannot show (whether a change is breaking, whether
// the project has one contributor, so may leave authors out) is not checked.
// lint.ts runs these on a changelog whose format is Common Changelog and on no
// other.
import {
  type Changelog,
  type Coverage,
  type Finding,
  finding,
  type Group,
  headingVersion,
  isDate,
  isSemver,
  isStable,
  isUnreleased,
  opensWithTitle,
  type Part,
  precedence,
  type Rule,
  type Section,
  uncovered,
} from "./lint-structure.ts";
import { type Block, type Inline, plain } from "./markdown-tree.ts";

const SPEC = "https://common-changelog.org/";

/** The rules, each with the section of the specification that states it. */
export const COMMON_RULES = {
  // 2.1. File format: "Filename must be `CHANGELOG.md`."
  fileName: {
    id: "common-changelog/file-name",
    section: "Common Changelog, 2.1. File format",
    url: `${SPEC}#21-file-format`,
  },
  // 2.1. File format: content must "start with a first-level heading".
  title: {
    id: "common-changelog/title",
    section: "Common Changelog, 2.1. File format",
    url: `${SPEC}#21-file-format`,
  },
  // 2.1. File format: "Subsequent Markdown content must be zero or more releases."
  content: {
    id: "common-changelog/content",
    section: "Common Changelog, 2.1. File format",
    url: `${SPEC}#21-file-format`,
  },
  // 6.2. How is this different from Keep a Changelog?: "No Unreleased section".
  unreleased: {
    id: "common-changelog/no-unreleased",
    section:
      "Common Changelog, 6.2. How is this different from Keep a Changelog?",
    url: `${SPEC}#62-how-is-this-different-from-keep-a-changelog`,
  },
  // 2.2. Release: `## VERSION - DATE`, VERSION semver-valid "without "v" prefix";
  // 6.2: "No `[YANKED]` tag", a notice instead (6.4).
  heading: {
    id: "common-changelog/release-heading",
    section: "Common Changelog, 2.2. Release",
    url: `${SPEC}#22-release`,
  },
  // 2.2. Release: "The `DATE` must be in the form of `YYYY-MM-DD`."
  date: {
    id: "common-changelog/date",
    section: "Common Changelog, 2.2. Release",
    url: `${SPEC}#22-release`,
  },
  // 2.1. File format: "Releases must be sorted latest-first according to
  // Semantic Versioning rules."
  order: {
    id: "common-changelog/release-order",
    section: "Common Changelog, 2.1. File format",
    url: `${SPEC}#21-file-format`,
  },
  // 2.2. Release: the version links "Preferably" by reference-style links; a
  // version written as a link needs its definition to link at all.
  versionLink: {
    id: "common-changelog/version-link",
    section: "Common Changelog, 2.2. Release",
    url: `${SPEC}#22-release`,
  },
  // 2.2. Release: one or more change groups, or a notice followed by zero or
  // more; "No other content is permitted".
  release: {
    id: "common-changelog/release-content",
    section: "Common Changelog, 2.2. Release",
    url: `${SPEC}#22-release`,
  },
  // 2.3. Notice: "a single-sentence paragraph"; "There can only be one notice
  // per release."
  notice: {
    id: "common-changelog/notice",
    section: "Common Changelog, 2.3. Notice",
    url: `${SPEC}#23-notice`,
  },
  // 2.4. Change group: "The category must be one of (in order): Changed,
  // Added, Removed, Fixed."
  category: {
    id: "common-changelog/category",
    section: "Common Changelog, 2.4. Change group",
    url: `${SPEC}#24-change-group`,
  },
  categoryOrder: {
    id: "common-changelog/category-order",
    section: "Common Changelog, 2.4. Change group",
    url: `${SPEC}#24-change-group`,
  },
  // 2.4. Change group: "The heading must be followed by (and only by) an
  // unnumbered Markdown list."
  list: {
    id: "common-changelog/change-list",
    section: "Common Changelog, 2.4. Change group",
    url: `${SPEC}#24-change-group`,
  },
  // 2.4.2. References: "changes must reference relevant commits"; references
  // "must be wrapped in parentheses" and each "must be a Markdown link".
  reference: {
    id: "common-changelog/reference",
    section: "Common Changelog, 2.4.2. References",
    url: `${SPEC}#242-references`,
  },
  // 2.1. File format: "There must be an entry for every new stable release."
  coverage: {
    id: "common-changelog/coverage",
    section: "Common Changelog, 2.1. File format",
    url: `${SPEC}#21-file-format`,
  },
} as const satisfies Record<string, Rule>;

const CATEGORIES = ["Changed", "Added", "Removed", "Fixed"];

/** A release heading's parts: `VERSION - DATE`, the version maybe a link. */
interface Release {
  section: Section;
  version: string;
  date: string;
  /** The label of a version in brackets that link nowhere; null for a plain or linked one. */
  ref: string | null;
}

const LINK: unique symbol = Symbol("link");
const OTHER: unique symbol = Symbol("other");
/**
 * A paragraph as a reference reads it: each character of its text, a link
 * that renders, or a code span or image. Raw HTML is left out: a comment
 * shows nothing, so it is neither a change's text nor part of a reference.
 */
type Sym = string | typeof LINK | typeof OTHER;

const symbols = (inline: Inline[]): Sym[] =>
  inline.flatMap((i): Sym[] =>
    i.k === "text" ? [...i.v] : i.k === "link" ? [LINK] : i.html ? [] : [OTHER],
  );

const space = (s: Sym | undefined): boolean =>
  s === " " || s === "\t" || s === "\n";

/** Whether `s` may sit inside a bracketed label: text other than a bracket (CommonMark's link label), or a code span or image. */
const labelled = (s: Sym | undefined): boolean =>
  s === OTHER || (typeof s === "string" && s !== "[" && s !== "]");

/** Whether `s` may be part of a reference's authors: text other than `)`, or a link. */
const authored = (s: Sym | undefined): boolean =>
  s === LINK || (typeof s === "string" && s !== ")");

/**
 * A paragraph's symbols, with where each run a reference reads ends from
 * every index: a group that breaks off is read again from each `(` after it,
 * so a run found by scanning would be scanned again for each of them.
 */
interface Scan {
  syms: Sym[];
  /** The first index from each on that is not whitespace. */
  solid: number[];
  /** The first index from each on that a label cannot hold. */
  label: number[];
  /** The first index from each on that authors cannot hold. */
  authors: number[];
}

function scanOf(syms: Sym[]): Scan {
  const n = syms.length;
  const [solid, label, authors] = [0, 1, 2].map(() =>
    new Array<number>(n + 1).fill(n),
  ) as [number[], number[], number[]];
  for (let i = n - 1; i >= 0; i--) {
    const s = syms[i];
    solid[i] = space(s) ? (solid[i + 1] ?? n) : i;
    label[i] = labelled(s) ? (label[i + 1] ?? n) : i;
    authors[i] = authored(s) ? (authors[i + 1] ?? n) : i;
  }
  return { syms, solid, label, authors };
}

const skip = (scan: Scan, i: number): number => scan.solid[i] ?? i;

/**
 * Text in brackets at `i`, maybe followed by a second pair: how a reference
 * link whose label has no definition renders, its label maybe holding code.
 * The index after it, or null.
 */
function brackets(scan: Scan, i: number): number | null {
  const pair = (j: number): number | null => {
    if (scan.syms[j] !== "[") return null;
    const k = scan.label[j + 1] ?? j + 1;
    return scan.syms[k] === "]" ? k + 1 : null;
  };
  const first = pair(i);
  return first === null ? null : (pair(first) ?? first);
}

/**
 * The authors that may close a reference after a `;` (2.4.3. Authors): text
 * or linked names up to the `)`, with no code or image in it. The index of
 * the `)`, or null.
 */
function authors(scan: Scan, i: number): number | null {
  const j = scan.authors[i] ?? i;
  return skip(scan, i) < j && scan.syms[j] === ")" ? j : null;
}

/**
 * The reference that opens with the `(` at `i`: links, or text in brackets,
 * separated by commas, then maybe `;` and its authors, then `)`. Where it
 * ends and whether it is sound: every entry a link that renders, and the
 * group well formed. A group that has read an entry and a separator is a
 * reference, so one that then breaks off is a broken reference, not
 * ordinary parentheses. Null when no reference opens there.
 */
function reference(scan: Scan, i: number): Reference | null {
  let linked = true;
  let j = skip(scan, i + 1);
  for (let listed = false; ; listed = true) {
    const end = scan.syms[j] === LINK ? j + 1 : brackets(scan, j);
    if (end === null) return brokenOff(listed, j);
    linked &&= scan.syms[j] === LINK;
    const next = afterEntry(scan, skip(scan, end), linked);
    if (typeof next !== "number") return next ?? brokenOff(listed, end);
    j = next;
  }
}

interface Reference {
  end: number;
  linked: boolean;
}

/** A group that breaks off at `at`: a broken reference once it has read a separator, else none. */
const brokenOff = (listed: boolean, at: number): Reference | null =>
  listed ? { end: at, linked: false } : null;

/**
 * What follows a reference's entry at `j`: the reference's end (at `)`, or
 * after `;` and its authors), the index of the next entry after a `,`, or
 * null where the reference breaks off.
 */
function afterEntry(
  scan: Scan,
  j: number,
  linked: boolean,
): Reference | number | null {
  const s = scan.syms[j];
  if (s === ")") return { end: j + 1, linked };
  if (s === ";") {
    const close = authors(scan, j + 1);
    return close === null
      ? { end: j + 1, linked: false }
      : { end: close + 1, linked };
  }
  return s === "," ? skip(scan, j + 1) : null;
}

/** The paragraphs of a list item, its nested lists' included: what a reference may sit in. */
function paragraphsOf(blocks: Block[]): Inline[][] {
  return blocks.flatMap((b) =>
    b.k === "paragraph"
      ? [b.inline]
      : b.k === "list"
        ? b.items.flatMap(paragraphsOf)
        : b.k === "quote"
          ? paragraphsOf(b.blocks)
          : [],
  );
}

/**
 * Whether a change holds a reference after some text of its own, and every
 * entry of every reference renders as a link: inline, an autolink, or by a
 * label the changelog defines. A link inside a code span, a code block or
 * an HTML comment is not one.
 */
function referenced(item: Block[]): boolean {
  let text = false;
  let after = false;
  let broken = false;
  for (const paragraph of paragraphsOf(item)) {
    const scan = scanOf(symbols(paragraph));
    const { syms } = scan;
    let i = 0;
    while (i < syms.length) {
      const ref = syms[i] === "(" ? reference(scan, i) : null;
      if (ref) {
        after ||= text;
        broken ||= !ref.linked;
        i = ref.end;
        continue;
      }
      if (!space(syms[i])) text = true;
      i++;
    }
  }
  return after && !broken;
}

function fileFindings(changelog: Changelog): Finding[] {
  const findings: Finding[] = [];
  if (changelog.file.split("/").at(-1) !== "CHANGELOG.md")
    findings.push(
      finding(
        COMMON_RULES.fileName,
        changelog,
        1,
        `the changelog is named ${changelog.file.split("/").at(-1)}`,
        "rename it CHANGELOG.md, and set changelog.file to the new path",
      ),
    );
  if (!opensWithTitle(changelog))
    findings.push(
      finding(
        COMMON_RULES.title,
        changelog,
        changelog.first ?? 1,
        "the file does not start with a first-level heading",
        "start it with `# Changelog`",
      ),
    );
  const [lead] = changelog.preamble;
  const stray = [
    ...(lead ? [changelog.lineOf(lead.index)] : []),
    ...changelog.titles.filter((t) => t.index !== 0).map((t) => t.line),
  ].sort((a, b) => a - b);
  for (const line of stray)
    findings.push(
      finding(
        COMMON_RULES.content,
        changelog,
        line,
        `"${changelog.lines[line - 1]?.trim()}" is neither the title nor part of a release`,
        "keep only the title and the releases in the file, say which format it follows in the readme or the contributing guide instead, and set changelog.format to common-changelog, since the file no longer names its format",
      ),
    );
  return findings;
}

/** The finding for a heading the format has no place for: Unreleased, or a `[YANKED]` release. */
function refusedHeading(
  changelog: Changelog,
  section: Section,
): Finding | null {
  if (isUnreleased(section.inline, true))
    return finding(
      COMMON_RULES.unreleased,
      changelog,
      section.line,
      "the format has no Unreleased section",
      "remove it, and list its changes in the release that ships them",
    );
  if (/\[YANKED\]\s*$/i.test(plain(section.inline)))
    return finding(
      COMMON_RULES.heading,
      changelog,
      section.line,
      `"## ${section.title}" marks a yanked release with [YANKED], which the format does not use`,
      "drop [YANKED] and give the release a notice saying it was yanked (6.4. What about yanked releases?)",
    );
  return null;
}

/** The release a `##` heading names, or the finding that it does not read as one. */
function releaseOf(changelog: Changelog, section: Section): Release | Finding {
  const refused = refusedHeading(changelog, section);
  if (refused) return refused;
  const fail = (problem: string, remedy: string) =>
    finding(COMMON_RULES.heading, changelog, section.line, problem, remedy);
  const parts = headingVersion(section.inline);
  const date = parts ? /^\s+-\s+(\S+)$/.exec(parts.rest)?.[1] : undefined;
  if (!parts || date === undefined)
    return fail(
      `"## ${section.title}" is not a release heading`,
      "write it as `## [VERSION] - YYYY-MM-DD` (or `## VERSION - YYYY-MM-DD`)",
    );
  const { version, ref } = parts;
  if (!isSemver(version))
    return fail(
      `"${version}" is not a Semantic Versioning version${/^v\d/.test(version) ? ": it carries a v prefix" : ""}`,
      "write the version as Semantic Versioning has it, without a v prefix (the tag may keep one)",
    );
  return { section, version, date, ref };
}

function dateAndOrderFindings(
  changelog: Changelog,
  releases: Release[],
): Finding[] {
  const findings: Finding[] = [];
  releases.forEach((release, i) => {
    const { line } = release.section;
    if (!isDate(release.date))
      findings.push(
        finding(
          COMMON_RULES.date,
          changelog,
          line,
          `the date "${release.date}" of ${release.version} is not a real day written YYYY-MM-DD`,
          "write the release date as YYYY-MM-DD",
        ),
      );
    // Versions that differ only in build metadata rank equal, so either may
    // come first; only the same version written twice repeats.
    const above = releases[i - 1];
    const repeats = releases
      .slice(0, i)
      .some((r) => r.version === release.version);
    if (above && (repeats || precedence(above.version, release.version) < 0))
      findings.push(
        finding(
          COMMON_RULES.order,
          changelog,
          line,
          repeats
            ? `${release.version} already has a section above this one`
            : `${release.version} is listed below ${above.version}, which it follows in Semantic Versioning`,
          "list the releases latest first by version, one section per version, even where a lower version came out later",
        ),
      );
    if (release.ref !== null)
      findings.push(
        finding(
          COMMON_RULES.versionLink,
          changelog,
          line,
          `[${release.ref}] has no link reference definition, so the heading shows its brackets and links nowhere`,
          `add \`[${release.ref}]: <url>\` at the end of the file (its release or tag page), or write the version without brackets`,
        ),
      );
  });
  return findings;
}

function leadFindings(changelog: Changelog, section: Section): Finding[] {
  const [notice, ...more] = section.lead;
  if (!notice)
    return section.groups.length
      ? []
      : [
          finding(
            COMMON_RULES.release,
            changelog,
            section.line,
            `"## ${section.title}" has no change group and no notice`,
            "list its changes under a category, or give it a one-sentence notice saying why there are none",
          ),
        ];
  const other = section.lead.find((p) => p.block.k !== "paragraph");
  if (other)
    return [
      finding(
        COMMON_RULES.release,
        changelog,
        changelog.lineOf(other.index),
        "a release holds only a notice and change groups, and this is neither",
        "put each change in a list under a `###` category, or make this the release's one-sentence notice",
      ),
    ];
  return more.map((part) =>
    finding(
      COMMON_RULES.notice,
      changelog,
      changelog.lineOf(part.index),
      "a release has one notice, a single paragraph, and this is a second",
      "keep one sentence as the notice and move the rest to an upgrade guide or a change",
    ),
  );
}

/** Whether a block is an unnumbered list. */
const unnumbered = (p: Part): boolean =>
  p.block.k === "list" && !p.block.ordered;

function listFindings(changelog: Changelog, group: Group): Finding[] {
  if (!group.body.length)
    return [
      finding(
        COMMON_RULES.list,
        changelog,
        group.line,
        `"### ${group.title}" lists no change`,
        "list its changes under it, or remove the heading",
      ),
    ];
  const at = group.body.findIndex((p) => !unnumbered(p));
  const stray = group.body[at];
  const findings: Finding[] = [];
  if (stray) {
    const line = changelog.lineOf(stray.index);
    findings.push(
      finding(
        COMMON_RULES.list,
        changelog,
        line,
        `"${changelog.lines[line - 1]?.trim()}" under "### ${group.title}" is not part of an unnumbered list`,
        "write each change as a `- ` list item, and nothing else under the heading",
      ),
    );
  }
  for (const part of group.body) {
    if (part.block.k !== "list") continue;
    part.block.items.forEach((item, i) => {
      if (!referenced(item))
        findings.push(
          finding(
            COMMON_RULES.reference,
            changelog,
            changelog.lineOf(part.index, i),
            "the change references no commit, pull request or issue",
            "end it with a reference in parentheses that is a Markdown link, such as ([#12](https://…/pull/12)) or ([`abc1234`](https://…/commit/abc1234))",
          ),
        );
    });
  }
  return findings;
}

function groupFindings(changelog: Changelog, section: Section): Finding[] {
  const findings: Finding[] = [];
  let rank = -1;
  for (const group of section.groups) {
    // 2.4: the heading is text only, so a link, code or emphasis is no category.
    const textOnly = group.inline.every((i) => i.k === "text" && !i.styled);
    const at = textOnly ? CATEGORIES.indexOf(plain(group.inline).trim()) : -1;
    if (at === -1)
      findings.push(
        finding(
          COMMON_RULES.category,
          changelog,
          group.line,
          `"### ${group.title}" is not a category${textOnly ? "" : ": a category heading is plain text"}`,
          `use one of ${CATEGORIES.join(", ")} (a deprecation goes under Changed, a security fix under Fixed)`,
        ),
      );
    else if (at <= rank)
      findings.push(
        finding(
          COMMON_RULES.categoryOrder,
          changelog,
          group.line,
          `"### ${group.title}" comes after a category it must precede, or repeats one`,
          `order the groups ${CATEGORIES.join(", ")}, each once`,
        ),
      );
    else rank = at;
    findings.push(...listFindings(changelog, group));
  }
  return findings;
}

function coverageFindings(
  changelog: Changelog,
  releases: Release[],
  coverage: Coverage,
): Finding[] {
  const wanted = [
    ...(coverage.current !== null && isStable(coverage.current)
      ? [{ version: coverage.current, from: "the version files hold" }]
      : []),
    ...coverage.tagged
      .filter(isStable)
      .map((version) => ({ version, from: "a tag names" })),
  ];
  return uncovered(
    COMMON_RULES.coverage,
    changelog,
    new Set(releases.map((r) => r.version)),
    wanted,
  );
}

/** Every finding of Common Changelog's rules in `changelog`. */
export function lintCommonChangelog(
  changelog: Changelog,
  coverage: Coverage,
): Finding[] {
  const read = changelog.sections.map((s) => releaseOf(changelog, s));
  const releases = read.filter((r): r is Release => "version" in r);
  return [
    ...fileFindings(changelog),
    ...read.filter((r): r is Finding => "rule" in r),
    ...dateAndOrderFindings(changelog, releases),
    ...releases.flatMap((r) => [
      ...leadFindings(changelog, r.section),
      ...groupFindings(changelog, r.section),
    ]),
    ...coverageFindings(changelog, releases, coverage),
  ].sort((a, b) => a.line - b.line);
}
