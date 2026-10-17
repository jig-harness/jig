# What the site holds, and where it can go stale

The map from each document to the page that renders it is the page-types
table in [design/website.md § Page types](../../../../design/website.md#page-types).
This file says which parts of the site do **not** follow a document by
themselves, by kind, with the files to look in. It names files, not lines:
search them for the text a commit changed.

## Questions

Ask these of every `content` commit. One yes is enough to look closer.

1. **Does a page state, count, name or link something the commit changed?**
   A count ("five stations", "eleven phases", "1 agent"), a list of skills,
   modules or stations, a claim about what Jig does or never does, the
   supported agents or tracker adapters, the licences.
2. **Did it change the shape of a document a parser reads?** A heading
   renamed, reordered or removed; a table column added or moved; a
   paragraph's opening words changed where a parser looks for them.
3. **Did it add, rename or remove a kind of thing** the site lists: a
   module, skill, agent, principle, profile, scaffolding job, station,
   configuration layer, glossary group, feature in FEATURES.md?
4. **Did it renumber, finish or remove a roadmap item** (in ROADMAP.md, the
   public roadmap the site renders, or in design/plan.md, whose items the
   roadmap repeats) a page links to
   (`#rm-item-<n>`) or describes as not built yet?
5. **Did it change the audit's renderer, its report or record format, or the
   committed run** the live audit example is built from?
6. **Did it change a fact in the site's frame**: the repository address, the
   default branch, the install or first-run steps, the footer's claims?
7. **Does a rendered document now speak to Jig's maintainers rather than its
   readers?** A tool the maintainers use stated as Jig's default or as what
   it is built for, a "today" that names one implementation where the
   reader needs what is supported and planned, or a note about how Jig
   itself is developed
   ([AGENTS.md § Writing conventions](../../../../AGENTS.md#writing-conventions-mandatory)).
   This run edits no document but FEATURES.md, so list the passage in the
   report for a person, with the wording you would use instead.

## Where hand-written facts live

- **Home page** (`website/src/pages/index.astro`): the limits list (what Jig
  never does, each with its source), the hero, the ladder paragraph, the
  day-one paragraph, the profile-graduation line.
- **Factory** (`website/src/components/CrossSection.astro`,
  `website/src/components/factory/*.astro`): the figure captions, the "at
  every stage" band, which stations are for user-interface work only, where
  follow-ups enter, stage and station counts, the tracker adapters available
  today, the configuration layer count, links to roadmap items.
- **Factory data** (`website/src/lib/data/factory.ts`): the scaffolding job
  ids, which design stage each design skill runs, the stations not built yet
  with the roadmap item each waits on, the actors a station's "run by" cell
  is read as.
- **Views** (`website/src/lib/view.ts`, `skills-view.ts`, `map.ts`): notes
  per scaffolding job and per module, which skills run at every stage, the
  number words (they stop at twelve), the review-arbiter special case.
- **What you get** (`website/src/pages/features.astro`): nothing typed by
  hand; the page is FEATURES.md, and its tests fail when a feature names a
  skill, module or roadmap item that no longer exists, or when a skill the
  plugin ships is named by no feature. The document itself goes stale when a
  skill, a store or an adapter is added, or when a roadmap item it names as
  not built is finished: then the feature's text and its "Not built yet"
  field are what to edit (SKILL.md § Phase 3).
- **Principles** (`website/src/pages/principles/index.astro`): where each
  principle is said to be visible on the site, by number, with the link.
- **Adoption** (`website/src/pages/adopt/*.astro`): the kickoff phase count,
  the step count, which step carries the audit command.
- **Skills and plugin** (`website/src/pages/skills/**`,
  `website/src/pages/plugin/index.astro`): the agent count, the station notes
  for skills outside the line, the plugin page's stations, read from the
  plugin README's headings (Requirements, Install the plugin, Use a skill,
  Configure a repository) plus a hand-written last one.
- **Modules** (`website/src/pages/modules/index.astro`,
  `website/src/components/module/*.astro`): the map's explanatory
  paragraphs, the level taglines, the CI providers the mappings switch shows.
- **Frame** (`website/src/layouts/Base.astro`, `website/src/lib/site.ts`,
  `website/src/lib/routes.ts`, `website/src/pages/search.json.ts`): the
  navigation, the footer's claims and licences, the repository address and
  branch, the fixed document-to-route table, anchor renames, the search
  index's hand-written page list and keywords.
- **Markdown twins** (`website/scripts/markdown-twins.ts`): a page's twin
  follows its HTML, so most changes reach it; one that reads badly (a label
  that should be a heading, a block that repeats) needs a rule there, not an
  edit to the twin.
- **`llms.txt` files** (`website/src/lib/llms.ts`): the sections, and the
  fixed pages of each section (the modules, skills and principles overviews,
  and the factory, adopt and plugin pages) with the line on each;
  a page renamed, added or removed there is a change to those lists too. The
  lists of modules, skills and principles follow their documents.
- **Live audit example** (`website/scripts/audit-example.ts` and
  `website/src/components/AuditSpecimen.astro`): the committed run it renders
  and the caption naming its repository, commit, plugin version and date.

## What the parsers rely on

Each parser in `website/src/lib/data/` (and the glossary's, in
`website/src/lib/glossary.ts`) finds its sections by heading text. Most
match a heading by its start (`section()` in `website/src/lib/source.ts`),
so a heading that gains words at its end is still found; `modules.ts` matches
a module README's `Invariant`, `Maturity levels`, `Adoption steps` and
`Status` headings exactly, so any change to those loses the section. Tables
are read by position: `tableRows()` drops the header row without reading its
names, so a reordered or inserted column puts the wrong cell in each field
rather than failing. A heading a parser does not find usually yields empty
content, not an error, so the build passes and the page loses a section.
The parsers and what they read:

| Parser | Reads | Relies on |
|--------|-------|-----------|
| `modules.ts` | `modules/README.md`, each module README and `mappings.md` | the module table's columns; `**What problem this solves.**`, `## Invariant` with a quote, `## Maturity levels` with Lite, Standard and Strict items, `## Adoption steps`, `## Status`; mapping sections titled by CI provider |
| `criteria.ts` | `plugin/skills/audit/criteria/M*.yaml` | the criteria keys, levels and `requires` values |
| `profiles.ts` | `plugin/skills/audit/profiles.yaml`, `profiles/README.md` | `version: 1`; `## Choosing` table; a section per profile; a line starting "Graduate" |
| `principles.ts` | `principles/` | `# N — Title`, `**Why.**`, `**Consequences**`, the index table's third column; the index page also shows the README's first paragraph |
| `skills.ts` | `plugin/README.md` | the `Skill` and `Agent` tables; the paragraph on how skills reach the tracker |
| `factory.ts` | `FACTORY.md` | its section titles, the jobs, stations and levels tables and their column counts, the paragraphs it finds by their opening words |
| `readme.ts` | `README.md` | "Jig as a software factory" and "Ways to use" |
| `features.ts` | `FEATURES.md` | one `##` section per feature; a list of `**Skills:**`, `**Practice:**` and `**Not built yet:**` fields after the prose, skills by their link paths, modules by id, roadmap items as "item N"; an unknown field or a feature without prose or a practice fails the build |
| `adoption.ts` | `adoption/*.md` | the brownfield sections; the greenfield heading that names the phase count |
| `flywheel.ts` | M8's README | "The flywheel", "The two companion cycles", the "Both cycles" paragraph |
| `config.ts` | `plugin/CONFIGURATION.md` | the "Configuration layers" table |
| `whats-new.ts` | `CHANGELOG.md`, `ROADMAP.md` | `## [version] - date` headings; roadmap `### N. title` items under `##` groups |
| `../glossary.ts` | `GLOSSARY.md` | `##` groups with `- **Term** — definition` entries |

`website/src/lib/data/data.test.ts` runs every parser in `data/` against the
real files, and `website/src/lib/routes.test.ts` runs the glossary's; the
first also pins some counts (modules, criteria files, principles, kickoff phases,
pipeline stages, stations). A failing count after a commit that added
something on purpose is the test to update, along with any page that typed
the same number.
