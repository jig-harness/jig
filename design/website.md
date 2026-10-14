# The jig-harness.dev website: design

**What problem this solves.** Jig's practices, skills and adoption paths live
in a few hundred Markdown files. A reader evaluating Jig for a team, or a
maintainer adopting it in a repository, has to find their way through the
repository to learn what Jig is, how far to take it and what to do first.
The site gives both readers a way in: a short path for the evaluator (what
Jig is, what it never does, how far a team should go) and dense, linkable
reference pages for the maintainer (every module, skill, principle and
term), all rendered from the repository's own documents so they cannot
disagree with them.

This is the design of [ROADMAP.md](../ROADMAP.md) item 18. The site is
built and deployed: `website/` renders every page type below in the final
design, behind Cloudflare Access. What is left is in
[§ Build order](#build-order).

## How it works

### One source: the repository's documents

`website/` is an Astro project of its own (its own `package.json` and
lockfile). Every page is rendered at build time from the repository's files;
nothing the site states is typed twice.

- **Parsers** in `website/src/lib/data/` read each kind of document into the
  parts its page lays out: a module README into its problem, invariant,
  three levels, adoption steps, status and mechanics sections; the criteria
  YAML; `profiles.yaml` with the profiles README; FACTORY.md into its jobs,
  levels and stations; the plugin README's skill tables; the glossary; the
  changelog and roadmap; M8's flywheel. `website/src/lib/data/index.ts`
  loads each once per build. The parsers are pure functions over text, and
  `data.test.ts` runs them against the real files, so a document whose
  structure a page relies on cannot change shape unnoticed.
- **Rendering**: whole documents go through Astro's content collection
  (`src/content.config.ts`); fragments (an invariant, a table cell) through
  `src/lib/markdown.ts`, with the same plugins:
  - `remark-repo-links.ts` resolves every link from the document's own
    path (`routes.ts`): a file the site has a page for links to that page, a
    glossary link to the term its text names (as a term whose definition
    opens in place), anything else to the file on GitHub. An anchor alone
    links to the heading on its own document's page, under the id that page
    gives it. A link whose text is a bare file name reads as the page's name.
  - `rehype-blocks.ts` gives code blocks a language label and a Copy button,
    and makes tables scroll on a narrow screen.
- **Build**: `bun run build` renders the live audit example
  (`scripts/audit-example.ts`, with the audit skill's own renderer and a
  committed run), builds the site, and runs `scripts/check-links.ts`, which
  reads each page's links and ids with an HTML parser, resolves every link
  against its page, and fails on any site link to a missing page or anchor,
  and on a built file that sets its own base URL, whose links it does not
  resolve.

### Page types

| Route | Source | What the page adds |
|-------|--------|--------------------|
| `/` | README, FACTORY.md, profiles | the evaluator's path: the plain statement, two reader paths, the compact module map, the factory miniature, the limits, the enforcement ladder, the profiles, the live audit, the ways to use Jig and the principles |
| `/modules/` | modules/README.md, profiles.yaml | the full map: every module at three levels, in adoption order, with a profile switch, scaffolding jobs and the skills that run each |
| `/modules/<Mn>/` | the module README, its criteria YAML, its mappings.md | three numbered parts (the idea, the practice by level with the audit's criteria, the mechanics folded), the CI-provider switch for the mappings, and a rail: commands, scaffolding job, target per profile, adoption order |
| `/modules/<Mn>/mappings/` | mappings.md | the whole file, for links that name it |
| `/factory/` | FACTORY.md, M8's README, CONFIGURATION.md | figure 1 (stations on the scaffolding, above the platform), the jobs table, what Jig provides with the configuration layers and the tracker interface, figure 2 (every station and who runs it), the levels, both pipelines, the flywheel |
| `/adopt/`, `/adopt/greenfield/` | adoption/*.md, profiles | the guides with the plan rail: the chosen profile's modules in order, linked to their levels, and a hand-off link that keeps the profile (`?profile=`) |
| `/plugin/`, `/plugin/configuration/` | plugin/README.md, CONFIGURATION.md | five stations from nothing installed to a first audit; the rest of the README folded; the configuration reference |
| `/skills/`, `/skills/<name>/`, `/skills/<name>/skill/` | plugin README tables, each skill's README or SKILL.md | what each skill runs (stations and modules), the stations no skill runs, each skill's own page, and its agent contract where the page is its README |
| `/principles/`, `/principles/<n>/` | principles/ | each principle's statement, why and consequences; principle 4 draws the ladder |
| `/glossary/` | GLOSSARY.md | every term in its group, an anchor per term, a find filter |
| `/whats-new/` | CHANGELOG.md, ROADMAP.md | every release beside the roadmap, each item foldable and anchored (`#rm-item-<n>`) |
| `/glossary.json`, `/search.json` | the same data | term definitions for the popovers, and the search index |

### The design system

- **Palette**: the tokens at the top of `website/src/styles/global.css`,
  light and dark; the site follows the reader's system setting and a switch
  in the header overrides it. Every color on the site is a token, and every
  text pair meets the [WCAG](../GLOSSARY.md) 2.2 AA contrast minimum in both
  themes.
- **Type**: the system serif for headings and the system sans for text, no
  web font; the mono stack for commands, ids and paths.
- **Shared components** (`website/src/components/`): the level glyph (three
  rising bars), the rung mark (half or full square), the status mark (ring
  for a skill, disc for a person, dashed ring for work not built yet),
  module chips, the actor line, the station box, the cross-section figure,
  the module map, the plan rail, the side index, the ladder, the section
  head, the live audit specimen. Each closed set (levels, rungs, station
  status, scaffolding jobs) has one mapping site-wide and is never told
  apart by color alone.
- **Marks**: the frame mark (`public/brand/jig-frame-*.svg`, inlined in the
  header so it follows the theme), and the square marks without letters for
  favicons and avatars (`public/brand/jig-mark-{light,dark,accent,adaptive}.svg`,
  with 512-pixel PNGs of the first three; the adaptive one, which follows the
  reader's theme, is the favicon, and the accent one on a square background
  is `public/apple-touch-icon.png`).

### Interactions

Every page reads fully without JavaScript; scripts in `website/src/scripts/`
only enhance it: the theme switch, Copy buttons, term definitions beside a
term, search (an index filtered in the browser), the module page's level
tabs and CI switch, the map's profile switch, the adoption guides' profile
choice, and the audit specimen (inert until clicked, then usable, or full
screen).

### Hosting and access

- **Worker**: `website/wrangler.jsonc`, a Worker that only serves the built
  files, on the custom domain `jig-harness.dev`; its `workers.dev` and
  preview addresses are off, so the domain is the only way in.
- **Access**: a Cloudflare Access application covers `jig-harness.dev` and
  `*.jig-harness.dev` with the organization's reusable staff policy (its
  email domain, a 24-hour session). Until the site is public, every page
  also carries `noindex` and `robots.txt` disallows everything.
- **Deploy**: `.github/workflows/website.yml` deploys every push to `main`
  (the site renders the documents, so most changes reach it). It needs the
  `CLOUDFLARE_API_TOKEN` repository secret: a token limited to the account's
  Workers scripts and the zone's routes and domain-name records. Without it, deploy from a
  machine logged in with `wrangler login`: `cd website && bun run deploy`.
- **CI**: the `website` change-area selects the `website` job in
  `gates.yml` (type check, build, link check) for any change to the site or
  to a document it renders; the required `gates` check waits for it.

### Working on the site

```sh
cd website
bun install --frozen-lockfile   # and `bun install` at the root, for the audit renderer
bun run dev                     # http://localhost:4321
bun run build                   # what CI runs
bun run check                   # types
```

The parser tests run in CI's `website` job, and locally with
`bun run test ./website/` from the repository root once `website/` has its
dependencies.
Building writes Astro's generated types into `website/.astro/` and the site
into `website/dist/`; delete both before `bun run gates`, whose formatter and
linter would otherwise report them.

## Build order

Done: the site, its design, CI and deployment behind Access. Open, each its
own pull request:

1. **Contrast gate.** A check, run in CI after the build, that every text
   pair and every hover and focus state on every page meets the contrast
   minimums in both themes.
2. **Search on a phone.** The header search shows only at desktop widths;
   the design opens it as a full-width field under the header on a phone.
3. **The plugin page's agent switch.** One choice (Claude Code or Codex),
   remembered on the device, showing only that agent's install and use
   steps; the README's sections need a split by agent first.
4. **Skill page summary cards.** "It never" and "Runs on" for each skill,
   once the skills' READMEs state their limits and platforms in a form a
   page can read.
5. **The deploy token** as the repository secret, so `main` deploys without
   anyone's machine.
6. **Opening the site** (a person's decision, with the repository's own
   visibility): remove `noindex`, `robots.txt` and the Access application;
   review the site's own copy (the home page's statements, the limits, the
   figure captions); decide whether the live audit example keeps showing a
   third party's repository or shows Jig's own audit.

## Left out

- **Pages for templates and reference code**: they link to GitHub, where
  the source is the page.
- **Comments, analytics, accounts**: nothing on the site sends anything
  anywhere; the choices it remembers (theme, CI provider) stay in the
  browser.

