// The rules of Common Changelog (https://common-changelog.org/), checked over
// a whole changelog. Each rule is one the specification states with "must",
// cited at the rule with its numbered section; what it only recommends
// ("should": one line per change, breaking changes first, a link on every
// version) and what a file cannot show (whether a change is breaking, whether
// the project has one contributor, so may leave authors out) is not checked.
// lint.ts runs these on a changelog whose format is Common Changelog and on no
// other.
import { heading } from "./markdown-blocks.ts";
import {
  type Changelog,
  type Coverage,
  content,
  type Finding,
  finding,
  type Group,
  isDate,
  isDefinition,
  isSemver,
  isStable,
  label,
  type Line,
  paragraphs,
  precedence,
  type Rule,
  type Section,
  uncovered,
} from "./lint-structure.ts";

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
  linked: boolean;
}

/** A list item's start: `-`, `*` or `+` at the line's start, then a space. */
const ITEM = /^[-*+][ \t]+\S/;

/** A reference: a Markdown link right after an opening parenthesis. */
const REFERENCE = /\(\s*\[[^\]]+\](?:\([^)\s]+(?:\s+"[^"]*")?\)|\[[^\]]*\])/;

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
  const first = changelog.first;
  if (!first || first.inFence || !/^#\s/.test(first.text))
    findings.push(
      finding(
        COMMON_RULES.title,
        changelog,
        first?.n ?? 1,
        "the file does not start with a first-level heading",
        "start it with `# Changelog`",
      ),
    );
  const stray = [
    ...content(changelog.preamble).slice(0, 1),
    ...changelog.titles.filter((t) => t !== first),
  ];
  for (const line of stray)
    findings.push(
      finding(
        COMMON_RULES.content,
        changelog,
        line.n,
        `"${line.text.trim()}" is neither the title nor part of a release`,
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
  if (/^\[?Unreleased\]?$/i.test(section.title))
    return finding(
      COMMON_RULES.unreleased,
      changelog,
      section.line,
      "the format has no Unreleased section",
      "remove it, and list its changes in the release that ships them",
    );
  if (/\[YANKED\]\s*$/i.test(section.title))
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
  const [, linked, plain, date] =
    /^(?:\[([^\]]+)\]|(\S+))\s+-\s+(\S+)$/.exec(section.title) ?? [];
  const version = linked ?? plain;
  if (version === undefined || date === undefined)
    return fail(
      `"## ${section.title}" is not a release heading`,
      "write it as `## [VERSION] - YYYY-MM-DD` (or `## VERSION - YYYY-MM-DD`)",
    );
  if (!isSemver(version))
    return fail(
      `"${version}" is not a Semantic Versioning version${/^v\d/.test(version) ? ": it carries a v prefix" : ""}`,
      "write the version as Semantic Versioning has it, without a v prefix (the tag may keep one)",
    );
  return { section, version, date, linked: linked !== undefined };
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
    const above = releases[i - 1];
    if (above && precedence(above.version, release.version) <= 0)
      findings.push(
        finding(
          COMMON_RULES.order,
          changelog,
          line,
          `${release.version} is listed below ${above.version}, which it ${precedence(above.version, release.version) === 0 ? "repeats" : "follows in Semantic Versioning"}`,
          "list the releases latest first by version, one section per version, even where a lower version came out later",
        ),
      );
    if (release.linked && !changelog.definitions.has(label(release.version)))
      findings.push(
        finding(
          COMMON_RULES.versionLink,
          changelog,
          line,
          `[${release.version}] has no link reference definition, so the heading shows its brackets and links nowhere`,
          `add \`[${release.version}]: <url>\` at the end of the file (its release or tag page), or write the version without brackets`,
        ),
      );
  });
  return findings;
}

/** Whether a line opens something other than a paragraph: a list, a heading, a fence, a quote. */
const opensBlock = (line: Line): boolean =>
  line.inFence ||
  ITEM.test(line.text) ||
  /^\d+[.)]\s/.test(line.text) ||
  /^\s{0,3}>/.test(line.text) ||
  heading(line.text) !== null;

function leadFindings(changelog: Changelog, section: Section): Finding[] {
  const runs = paragraphs(section.lead);
  const [notice, ...more] = runs;
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
  const start = notice[0] as Line;
  if (opensBlock(start))
    return [
      finding(
        COMMON_RULES.release,
        changelog,
        start.n,
        "a release holds only a notice and change groups, and this is neither",
        "put each change in a list under a `###` category, or make this the release's one-sentence notice",
      ),
    ];
  return more.map((run) =>
    finding(
      COMMON_RULES.notice,
      changelog,
      (run[0] as Line).n,
      "a release has one notice, a single paragraph, and this is a second",
      "keep one sentence as the notice and move the rest to an upgrade guide or a change",
    ),
  );
}

/** The top-level list items of a group, each as the text of its lines. */
function items(group: Group): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  for (const line of group.body) {
    if (isDefinition(line)) continue;
    if (ITEM.test(line.text) && !line.inFence)
      out.push({ line: line.n, text: line.text });
    else if (out.length && line.text.trim() !== "")
      (out.at(-1) as { text: string }).text += `\n${line.text}`;
  }
  return out;
}

function listFindings(changelog: Changelog, group: Group): Finding[] {
  const runs = paragraphs(group.body);
  if (!runs.length)
    return [
      finding(
        COMMON_RULES.list,
        changelog,
        group.line,
        `"### ${group.title}" lists no change`,
        "list its changes under it, or remove the heading",
      ),
    ];
  const stray = runs
    .flat()
    .find(
      (line, i, all) =>
        (i === 0 && !ITEM.test(line.text)) ||
        (!ITEM.test(line.text) &&
          !/^\s/.test(line.text) &&
          (opensBlock(line) || all[i - 1]?.n !== line.n - 1)),
    );
  const findings = stray
    ? [
        finding(
          COMMON_RULES.list,
          changelog,
          stray.n,
          `"${stray.text.trim()}" under "### ${group.title}" is not part of an unnumbered list`,
          "write each change as a `- ` list item, and nothing else under the heading",
        ),
      ]
    : [];
  for (const item of items(group))
    if (!REFERENCE.test(item.text))
      findings.push(
        finding(
          COMMON_RULES.reference,
          changelog,
          item.line,
          "the change references no commit, pull request or issue",
          "end it with a reference in parentheses that is a Markdown link, such as ([#12](https://…/pull/12)) or ([`abc1234`](https://…/commit/abc1234))",
        ),
      );
  return findings;
}

function groupFindings(changelog: Changelog, section: Section): Finding[] {
  const findings: Finding[] = [];
  let rank = -1;
  for (const group of section.groups) {
    const at = CATEGORIES.indexOf(group.title);
    if (at === -1)
      findings.push(
        finding(
          COMMON_RULES.category,
          changelog,
          group.line,
          `"### ${group.title}" is not a category`,
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
