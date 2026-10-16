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
design, behind a private link. What is left is in
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
  levels and stations; FEATURES.md into a feature per section with its
  skills, modules and roadmap items; the plugin README's skill tables; the glossary; the
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
| `/features/` | FEATURES.md, the plugin README's skill tables, ROADMAP.md, FACTORY.md | what a team gets: the intro beside its plate, an at-a-glance card per feature (its plate, number, title and skill chips) linking to its section, then one section per feature: its prose beside its plate, the skills that run it as actor chips, the modules that state the practice as chips, the factory stations its skills run linked into `/factory/`, and what is not built yet as roadmap chips beside each entry |
| `/modules/` | modules/README.md, profiles.yaml | the full map: every module at three levels, in id order, with a profile switch, scaffolding jobs and the skills that run each |
| `/modules/<Mn>/` | the module README, its criteria YAML, its mappings.md | three numbered parts (the idea, the practice by level with the audit's criteria, the mechanics folded), the CI-provider switch for the mappings, and a rail: commands, scaffolding job, target per profile, adoption order |
| `/modules/<Mn>/mappings/` | mappings.md | the whole file, for links that name it |
| `/factory/` | FACTORY.md | the overview: figure 1 (stations on the scaffolding, above the platform), figure 2 (every station, who runs it and what it hands on, inside the learning loop), figure 3 (every actor by every station), the levels, what stays with a person and what the platform supplies |
| `/factory/scaffolding/` | FACTORY.md, CONFIGURATION.md | the jobs with the modules that build each, when each verification module acts along a session, running many agents at once, and what Jig provides: the configuration layers and the tracker interface |
| `/factory/design/`, `/factory/execution/` | FACTORY.md | one level each: its stations as a row with handoffs, the stages or the pull-request loop in text, the skills that run them or the station table |
| `/factory/learning-loop/` | FACTORY.md, M8's README | the miss-to-lens flywheel step by step, its two companion cycles, and what triggers reflection |
| `/adopt/`, `/adopt/greenfield/` | adoption/*.md, profiles | the guides with the plan rail: the chosen profile's modules in order, linked to their levels, and a hand-off link that keeps the profile (`?profile=`) |
| `/plugin/`, `/plugin/configuration/` | plugin/README.md, CONFIGURATION.md | five stations from nothing installed to a first audit; the rest of the README folded; the configuration reference |
| `/skills/`, `/skills/<name>/`, `/skills/<name>/skill/` | plugin README tables, each skill's README or SKILL.md | what each skill runs (stations and modules), the stations no skill runs, each skill's own page, and its agent contract where the page is its README |
| `/principles/`, `/principles/<n>/` | principles/ | the index shows each principle's statement and the first paragraph of its why, with a link to where it is visible on the site; each principle's page has its statement, why and consequences; principle 4 draws the ladder |
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
  rising bars), the rung mark (half or full square), the status mark (a key
  cap holding the actor's glyph: `/` a skill, `@` an agent, `>` a tool; a
  silhouette for a person; a dashed cap for work not built yet), the actor
  chip (the same glyph before the actor's name, opening what it does on
  hover; a link to a skill, the agent or a tool in rendered Markdown opens
  the same popover and draws the glyph when its text is the bare name),
  module chips, the actor line, the station box, the cross-section figure,
  the station-by-actor matrix, the module map, the plan rail, the side
  index, the ladder, the section head, the plate, the live audit specimen.
  A page that opens with a plate beside its intro uses `.intro-row` and
  `.intro-plate` (`global.css`); the plate drops out below 1000 pixels.
  Each closed set (levels, rungs, actors, scaffolding jobs) has one mapping
  site-wide and is never told apart by color alone.
- **Marks**: the frame mark (`public/brand/jig-frame-*.svg`, inlined in the
  header so it follows the theme), and the square marks without letters for
  favicons and avatars (`public/brand/jig-mark-{light,dark,accent,adaptive}.svg`,
  with 512-pixel PNGs of the first three; the adaptive one, which follows the
  reader's theme, is the favicon, and the accent one on a square background
  is `public/apple-touch-icon.png`).
- **Plates** (`public/plates/*.webp`, drawn by `Plate.astro`): line drawings
  in the manner of a 19th-century patent engraving, one subject each, no
  text. Each file is an alpha mask, black ink on transparent, and the
  component masks it onto the ink token at a set tone, so a plate follows
  the theme like text does and needs no light and dark pair. Plates
  decorate: every fact beside one is in the text, so they are hidden from
  assistive technology. [§ Drawing a plate](#drawing-a-plate) has the recipe.
  Which plate stands beside which feature is the site's choice, kept in
  `FEATURE_PLATES` (`website/src/lib/data/features.ts`) by the feature's
  heading id; the tests check every feature has one and every plate is drawn.

### Drawing a plate

A plate is generated by an image model from a fixed style preamble and a
one-sentence subject, then converted to a mask. The preamble, verbatim:

> A monochrome technical illustration in the style of a 19th-century patent
> drawing: clean black ink lines on a pure white background, fine
> cross-hatching for shading, no color, no gradients, no shadows, no
> background scene. No text, letters, numbers, labels or captions anywhere
> in the image. Flat orthographic view, centered, with wide empty margins
> around the subject.

Set the aspect ratio in the model's options, not in the prompt, and keep the
style across plates by passing an accepted plate as the reference image. The
subjects:

| Plate | Where | Subject |
|-------|-------|---------|
| `jig` | the home page's lede, 16:9 | a woodworking jig: a hardwood guide block with two steel drill bushings and a toggle clamp holding a small workpiece, as an exploded assembly view |
| `hall` | the factory page's intro, 16:9 | a side-elevation cross-section of a small industrial hall: seven identical workbenches on a mezzanine, the mezzanine on a lattice of scaffolding, a foundation slab with pipes below |
| `map` | the Context job, 1:1 | a surveyor's map unrolled on a table, held flat by two brass weights, a compass rose on the map and a folding ruler beside it |
| `gauge` | the Verification job, 16:9 | a pair of steel vernier calipers measuring a small machined part, next to a cylindrical go/no-go plug gauge standing upright |
| `catalog` | the Knowledge job, 1:1 | a wooden card-catalog cabinet of twelve drawers in three rows of four, one drawer pulled open to show index cards with tabs, label holders empty |
| `drafting` | design and planning, 16:9 | a drafting table tilted toward the viewer with a T-square, compasses, a set square and a half-finished mechanical drawing pinned at the corners |
| `line` | execution, 3:1 | a straight conveyor line in side elevation with seven small work stations along it, each a bench with a different hand tool, and a return belt underneath running back to the first station |
| `flywheel` | the learning loop, 16:9 | a large cast-iron flywheel on a bearing stand, belt-driven, with a centrifugal ball governor beside it |
| `lever` | what stays with a person, 16:9 | a human hand gripping a tall lever on a cast-iron control stand, the lever set to one of three notched positions |
| `slab` | what Jig leaves to the platform, 16:9 | a building foundation in section: a concrete slab on driven piles, with service conduits and a drainage pipe passing through it |
| `engine` | the 404 page, 16:9 | the preamble alone, with no subject |
| `lattice` | behind sunk bands, a 1:1 tile | a seamless repeating tile of a faint isometric scaffolding lattice: thin poles, ledgers, diagonal braces and couplers in thin even lines, continuing across all four edges |
| `toolwall` | the features page's intro, 16:9 | a pegboard tool wall with tools hung above their painted outlines, two outlines empty |
| `theodolite` | feature 1, an audit of where you stand, 1:1 | a surveyor's theodolite on a tripod with a folded measuring staff |
| `crate` | feature 2, a work item carried from pickup to merge, 1:1 | a tagged wooden crate on a roller conveyor |
| `sieves` | feature 3, review in tiers with an arbiter, 1:1 | three stacked sieves over a tray, a balance scale beside them |
| `ratchet` | feature 4, a learning loop built into the process, 1:1 | a ratchet wheel with its pawl engaged |
| `ledger` | feature 5, decisions recorded, found again, turned into checks, 1:1 | an open bound ledger with a ribbon, a hand stamp and ink pad |
| `pantograph` | feature 6, design and planning grounded in the repository, 1:1 | a pantograph copying a small drawing larger on a drawing board |
| `stepladder` | feature 7, gates that ship with their tests, 1:1 | a five-rung stepladder with a plug gauge on its top step |
| `spindle` | feature 8, change notes and a changelog, 1:1 | a desk spindle holding a stack of impaled notes, one note waiting |
| `bays` | feature 9, workspaces for many agents on one machine, 1:1 | a long bench divided into four bays, each with a vise and a lamp |
| `stencils` | feature 10, one configuration file read in layers, 1:1 | three stacked stencil plates with offset openings |
| `scraper` | feature 11, documents that say what is true now, 1:1 | a drawing board with an erasing knife and its shavings |
| `wrenches` | feature 12, adopt one module at a time, 1:1 | three sizes of one wrench on a pegboard, a hand taking the middle one |
| `numberer` | not yet placed: the `changelog` skill, once FEATURES.md has a section for it ([ROADMAP.md](../ROADMAP.md) item 4), 16:9 | an automatic numbering stamp on a stack of slips, one stamped slip on a booklet |

The conversion, from the image the model returns to the mask (ImageMagick and
`cwebp`; the width is the plate's largest rendered size, 640 for a spot
plate and 1600 for a hero):

```sh
magick in.jpeg -resize 1600x -colorspace Gray -level 12%,90% \
  \( +clone -negate \) -alpha off -compose CopyOpacity -composite \
  -fill black -colorize 100 -background none png32:plate.png
cwebp -q 60 -alpha_q 70 -exact plate.png -o website/public/plates/<name>.webp
```

The lattice uses `-level 0%,85%` so its faint strokes survive, and `-q 50`.
`website/src/lib/plates.ts` lists every drawn plate with its
width-to-height ratio, and `Plate.astro` draws from it; a new plate is added
there. The lattice is a tile rather than a drawing, so it is
not in that list: `global.css` lays it behind sunk bands and
`CrossSection.astro` behind its scaffolding band, each at its own tile size.

### Interactions

Every page reads fully without JavaScript; scripts in `website/src/scripts/`
only enhance it: the theme switch, Copy buttons, term definitions beside a
term, search (an index filtered in the browser), the module page's level
tabs and CI switch, the map's profile switch, the adoption guides' profile
choice, and the audit specimen (inert until clicked, then usable, or full
screen).

### Hosting and access

- **Worker**: `website/wrangler.jsonc`, a Worker on the custom domain
  `jig-harness.dev` that serves the built files; its `workers.dev` and
  preview addresses are off, so the domain is the only way in.
- **Private link**: until the site is public, `website/worker/index.ts`
  serves a page only to a reader holding the key. The link
  `https://jig-harness.dev/?key=<key>` sets a 30-day cookie holding the
  key's SHA-256 digest and redirects to the same address without the key;
  a request with neither a valid key nor a valid cookie gets a short "this
  site is private" page. The key is the Worker's `SITE_KEY` secret
  (`wrangler secret put SITE_KEY`); with none set, nothing but `robots.txt`
  is served, and changing it ends every visit and every link sent out. Anyone who holds the link can forward it, so it is for people the
  site is shown to on purpose, not for anything secret. `robots.txt`
  (disallow everything) is served to everyone, and every page also carries
  `noindex`.
- **Deploy**: `.github/workflows/website.yml` deploys every push to `main`
  (the site renders the documents, so most changes reach it). It needs the
  `CLOUDFLARE_API_TOKEN` secret of the `website` environment: a token
  limited to the account's Workers scripts and the zone's routes and
  domain-name records. To deploy from a machine instead, log in with
  `wrangler login`: `cd website && bun run deploy`.
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

### Keeping it current

A document change reaches the site on the next deploy, but the site's
hand-written copy, a parser that finds a section by its heading, a page
that lists modules or skills by hand, and FEATURES.md, which describes the
skills and the roadmap, do not follow it. The
[`website-update`](../.claude/skills/website-update/SKILL.md) skill, run
with `/website-update`, reviews every commit to `main` after the one
recorded in `website/content-sync.yaml` (`bun scripts/website-sync.ts`
lists them by what they touched and their size), fixes what the site now
gets wrong in one draft pull request, files a follow-up for a change too
large to review in one session, and moves the record forward. A site
update is not a plugin release.

## Build order

Done: the site, its design, CI and deployment from `main` behind a private link.
Open, each its own pull request:

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
5. **Opening the site** (a person's decision, with the repository's own
   visibility): remove `noindex`, `robots.txt` and the key check in `website/worker/index.ts`;
   review the site's own copy (the home page's statements, the limits, the
   figure captions); decide whether the live audit example keeps showing a
   third party's repository or shows Jig's own audit.

## Left out

- **Pages for templates and reference code**: they link to GitHub, where
  the source is the page.
- **Comments, analytics, accounts**: nothing on the site sends anything
  anywhere; the choices it remembers (theme, CI provider) stay in the
  browser.

