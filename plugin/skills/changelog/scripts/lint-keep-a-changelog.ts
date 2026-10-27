// The rules of Keep a Changelog 1.1.0 (https://keepachangelog.com/en/1.1.0/),
// checked over a whole changelog. Each rule is the specification's own, cited
// at the rule with the section that states it; what the specification leaves
// open (the order of the change types, a summary above a release's groups,
// the text of an entry) is not checked. lint.ts runs these on a changelog
// whose format is Keep a Changelog and on no other.
import {
  type Changelog,
  type Coverage,
  type Finding,
  finding,
  isDate,
  label,
  type Rule,
  type Section,
  uncovered,
} from "./lint-structure.ts";

const SPEC = "https://keepachangelog.com/en/1.1.0/";

/** The rules, each with the section of the specification that states it. */
export const KEEP_RULES = {
  // The example at the top of the specification opens with `# Changelog`.
  title: {
    id: "keep-a-changelog/title",
    section: "Keep a Changelog 1.1.0, the example changelog",
    url: SPEC,
  },
  // Guiding Principles: "Mention whether you follow Semantic Versioning."
  semver: {
    id: "keep-a-changelog/semver-statement",
    section: "Keep a Changelog 1.1.0, Guiding Principles",
    url: `${SPEC}#principles`,
  },
  // "Keep an Unreleased section at the top to track upcoming changes."
  unreleased: {
    id: "keep-a-changelog/unreleased-first",
    section:
      "Keep a Changelog 1.1.0, How can I reduce the effort required to maintain a changelog?",
    url: `${SPEC}#effort`,
  },
  // Guiding Principles: "The release date of each version is displayed";
  // What about yanked releases?: `## [0.0.5] - 2014-12-13 [YANKED]`.
  heading: {
    id: "keep-a-changelog/release-heading",
    section:
      "Keep a Changelog 1.1.0, Guiding Principles and What about yanked releases?",
    url: `${SPEC}#yanked`,
  },
  // Confusing Dates: dates like `2017-07-17`, year, month and day.
  date: {
    id: "keep-a-changelog/date",
    section: "Keep a Changelog 1.1.0, Confusing Dates",
    url: `${SPEC}#confusing-dates`,
  },
  // Guiding Principles: "The latest version comes first."
  order: {
    id: "keep-a-changelog/release-order",
    section: "Keep a Changelog 1.1.0, Guiding Principles",
    url: `${SPEC}#principles`,
  },
  // Guiding Principles: "Versions and sections should be linkable."
  duplicate: {
    id: "keep-a-changelog/duplicate-release",
    section: "Keep a Changelog 1.1.0, Guiding Principles",
    url: `${SPEC}#principles`,
  },
  // Types of changes: Added, Changed, Deprecated, Removed, Fixed, Security.
  type: {
    id: "keep-a-changelog/change-type",
    section: "Keep a Changelog 1.1.0, Types of changes",
    url: `${SPEC}#types`,
  },
  // Guiding Principles: "The same types of changes should be grouped."
  grouped: {
    id: "keep-a-changelog/grouped",
    section: "Keep a Changelog 1.1.0, Guiding Principles",
    url: `${SPEC}#principles`,
  },
  // Guiding Principles: "Versions and sections should be linkable."
  versionLink: {
    id: "keep-a-changelog/version-link",
    section: "Keep a Changelog 1.1.0, Guiding Principles",
    url: `${SPEC}#principles`,
  },
  // Guiding Principles, and the example's `[unreleased]: …/compare/v1.1.1...HEAD`.
  unreleasedLink: {
    id: "keep-a-changelog/unreleased-link",
    section:
      "Keep a Changelog 1.1.0, Guiding Principles and the example changelog",
    url: `${SPEC}#principles`,
  },
  // Guiding Principles: "There should be an entry for every single version."
  coverage: {
    id: "keep-a-changelog/coverage",
    section: "Keep a Changelog 1.1.0, Guiding Principles",
    url: `${SPEC}#principles`,
  },
} as const satisfies Record<string, Rule>;

const TYPES = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
];

const UNRELEASED = /^\[Unreleased\]$/i;

/** A release heading as the format writes it: `[version] - date`, maybe `[YANKED]`. */
interface Release {
  section: Section;
  version: string;
  date: string;
}

/** The release a `##` heading names, or the finding that it does not read as one. */
function releaseOf(changelog: Changelog, section: Section): Release | Finding {
  const m = /^\[([^\]]+)\](?:\s+-\s+(\S+))?(\s+\[YANKED\])?$/.exec(
    section.title,
  );
  if (!m?.[1] || m[2] === undefined)
    return finding(
      KEEP_RULES.heading,
      changelog,
      section.line,
      `"## ${section.title}" is not a release heading`,
      "write it as `## [version] - YYYY-MM-DD`, with ` [YANKED]` after the date for a release that was pulled, or `## [Unreleased]`",
    );
  return { section, version: m[1], date: m[2] };
}

function titleFindings(changelog: Changelog): Finding[] {
  const first = changelog.first;
  if (first && /^#\s/.test(first.text) && !first.inFence) return [];
  return [
    finding(
      KEEP_RULES.title,
      changelog,
      first?.n ?? 1,
      "the file does not open with a first-level heading",
      "start it with `# Changelog`",
    ),
  ];
}

function semverFindings(changelog: Changelog): Finding[] {
  const text = changelog.preamble.map((l) => l.text).join("\n");
  if (/semantic versioning|semver/i.test(text)) return [];
  return [
    finding(
      KEEP_RULES.semver,
      changelog,
      changelog.first?.n ?? 1,
      "the text above the first release does not say whether the project follows Semantic Versioning",
      "say so in the opening paragraph, such as: this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)",
    ),
  ];
}

function unreleasedFindings(
  changelog: Changelog,
  unreleased: Section[],
): Finding[] {
  return unreleased.flatMap((section, i) => {
    if (i > 0)
      return [
        finding(
          KEEP_RULES.unreleased,
          changelog,
          section.line,
          "the changelog has a second Unreleased section",
          "merge it into the first",
        ),
      ];
    if (changelog.sections[0] === section) return [];
    return [
      finding(
        KEEP_RULES.unreleased,
        changelog,
        section.line,
        "the Unreleased section is not the first section",
        "move it above every release",
      ),
    ];
  });
}

function dateAndOrderFindings(
  changelog: Changelog,
  releases: Release[],
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, number>();
  let above: Release | null = null;
  for (const release of releases) {
    const { line } = release.section;
    const first = seen.get(release.version);
    if (first !== undefined)
      findings.push(
        finding(
          KEEP_RULES.duplicate,
          changelog,
          line,
          `${release.version} already has a section, at line ${first}`,
          "keep one section per version: merge the two",
        ),
      );
    else seen.set(release.version, line);
    if (!isDate(release.date)) {
      findings.push(
        finding(
          KEEP_RULES.date,
          changelog,
          line,
          `the date "${release.date}" of ${release.version} is not a real day written year-month-day`,
          "write the release date as YYYY-MM-DD",
        ),
      );
      continue;
    }
    if (above && release.date > above.date)
      findings.push(
        finding(
          KEEP_RULES.order,
          changelog,
          line,
          `${release.version} (${release.date}) is listed below ${above.version} (${above.date}), which is older`,
          "list the releases latest first",
        ),
      );
    above = release;
  }
  return findings;
}

function groupFindings(changelog: Changelog, section: Section): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const group of section.groups) {
    if (!TYPES.includes(group.title))
      findings.push(
        finding(
          KEEP_RULES.type,
          changelog,
          group.line,
          `"### ${group.title}" is not a type of change`,
          `use one of ${TYPES.join(", ")}`,
        ),
      );
    else if (seen.has(group.title))
      findings.push(
        finding(
          KEEP_RULES.grouped,
          changelog,
          group.line,
          `"### ${group.title}" appears twice in "## ${section.title}"`,
          "merge the two into one group",
        ),
      );
    seen.add(group.title);
  }
  return findings;
}

function versionLinkFindings(
  changelog: Changelog,
  releases: Release[],
): Finding[] {
  return releases.flatMap((r) =>
    changelog.definitions.has(label(r.version))
      ? []
      : [
          finding(
            KEEP_RULES.versionLink,
            changelog,
            r.section.line,
            `[${r.version}] has no link reference definition, so the heading shows its brackets and links nowhere`,
            `add \`[${r.version}]: <url>\` at the end of the file, comparing it with the release before (or its tag, for the first)`,
          ),
        ],
  );
}

function unreleasedLinkFindings(
  changelog: Changelog,
  unreleased: Section | undefined,
  newest: Release | undefined,
): Finding[] {
  // With no release yet there is nothing to compare: the link is owed from
  // the first release on.
  if (!unreleased || !newest) return [];
  const def = changelog.definitions.get("unreleased");
  if (def?.url.includes(newest.version) && /HEAD/.test(def.url)) return [];
  return [
    finding(
      KEEP_RULES.unreleasedLink,
      changelog,
      def?.line ?? unreleased.line,
      def
        ? `the [Unreleased] link does not compare the newest release, ${newest.version}, with HEAD`
        : "[Unreleased] has no link reference definition",
      def
        ? `point the [Unreleased] link at the comparison of ${newest.version}'s tag with HEAD`
        : `add \`[Unreleased]: <url>\` at the end of the file, comparing ${newest.version}'s tag with HEAD`,
    ),
  ];
}

function coverageFindings(
  changelog: Changelog,
  releases: Release[],
  coverage: Coverage,
): Finding[] {
  const wanted = [
    ...(coverage.current === null
      ? []
      : [{ version: coverage.current, from: "the version files hold" }]),
    ...coverage.tagged.map((version) => ({ version, from: "a tag names" })),
  ];
  return uncovered(
    KEEP_RULES.coverage,
    changelog,
    new Set(releases.map((r) => r.version)),
    wanted,
  );
}

/** Every finding of Keep a Changelog's rules in `changelog`. */
export function lintKeepAChangelog(
  changelog: Changelog,
  coverage: Coverage,
): Finding[] {
  const unreleased = changelog.sections.filter((s) => UNRELEASED.test(s.title));
  const read = changelog.sections
    .filter((s) => !UNRELEASED.test(s.title))
    .map((s) => releaseOf(changelog, s));
  const releases = read.filter((r): r is Release => "version" in r);
  return [
    ...titleFindings(changelog),
    ...semverFindings(changelog),
    ...unreleasedFindings(changelog, unreleased),
    ...read.filter((r): r is Finding => "rule" in r),
    ...dateAndOrderFindings(changelog, releases),
    ...changelog.sections.flatMap((s) => groupFindings(changelog, s)),
    ...versionLinkFindings(changelog, releases),
    ...unreleasedLinkFindings(changelog, unreleased[0], releases[0]),
    ...coverageFindings(changelog, releases, coverage),
  ].sort((a, b) => a.line - b.line);
}
