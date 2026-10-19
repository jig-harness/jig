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

This is the design of [plan](plan.md) item 18. The site is
built and deployed: `website/` renders every page type below in the final
design, open to every reader and to search engines. What is left
is in
[§ Build order](#build-order).

## How it works

### One source: the repository's documents

`website/` is an Astro project of its own (its own `package.json` and
lockfile). Every page is rendered at build time from the repository's files;
nothing the site states is typed twice. Those documents are therefore the
site's copy, and are written for its readers rather than for Jig's
maintainers ([AGENTS.md § Writing conventions](../AGENTS.md#writing-conventions-mandatory)).

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
| `/` | README, FACTORY.md, profiles | the evaluator's path: the plain statement and two reader paths beside the jig, a model drawn as a technical drawing that the first stretch of scrolling closes and the pointer swivels; the factory miniature; the map strip (the compact module map, starting on Team/Standard, each row opening its module's popover, with what a filled cell means); the limits; the enforcement ladder; the profiles; the live audit; the ways to use Jig, one plate each; and where to start, above the foundation plate rising from the page's foot |
| `/features/` | FEATURES.md, the plugin README's skill tables, ROADMAP.md, FACTORY.md | what a team gets: the intro beside its plate, an at-a-glance card per feature (its plate, number, title and skill chips) linking to its section, then one section per feature: its prose beside its plate, the skills that run it as actor chips, the modules that state the practice as chips, the factory stations its skills run linked into `/factory/`, and what is on the roadmap as roadmap chips beside each entry |
| `/modules/` | modules/README.md, profiles.yaml | the full map: every module at three levels, in id order, with a profile switch, scaffolding jobs and the skills that run each |
| `/modules/<Mn>/` | the module README, its criteria YAML, its mappings.md | three numbered parts (the idea, the practice by level with the audit's criteria, the mechanics folded), the CI-provider switch for the mappings, and a rail: commands, scaffolding job, target per profile, adoption order |
| `/modules/<Mn>/mappings/` | mappings.md | the whole file, for links that name it |
| `/factory/` | FACTORY.md | the overview: figure 1 (stations on the scaffolding, above the platform), figure 2 (every station, who runs it and what it hands on, inside the learning loop), figure 3 (every actor by every station), the levels, what stays with a person and what the platform supplies |
| `/factory/scaffolding/` | FACTORY.md, CONFIGURATION.md | the jobs with the modules that build each, when each verification module acts along a session, running many agents at once, and what Jig provides: the configuration layers and the tracker interface |
| `/factory/design/`, `/factory/execution/` | FACTORY.md | one level each: its stations as a row with handoffs, the stages or the pull-request loop in text, the skills that run them or the station table |
| `/factory/learning-loop/` | FACTORY.md, M8's README | the miss-to-lens flywheel step by step, its two companion cycles, and what triggers reflection |
| `/adopt/` | plugin/README.md | getting started: the prompt that hands the setup to an agent, then the stations from nothing installed to a first audit, then the guides for an existing repository and a new project |
| `/adopt/existing/`, `/adopt/greenfield/` | adoption/*.md, profiles | the guides with the plan rail: the chosen profile's modules in order, linked to their levels, and a hand-off link that keeps the profile (`?profile=`) |
| `/adopt/plugin/`, `/adopt/configuration/`, `/adopt/extending/` | plugin/README.md, CONFIGURATION.md, EXTENDING.md | the plugin README's sections getting started does not render; the configuration reference; the extending guide |
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
  silhouette for a person; a dashed cap for work on the roadmap), the actor
  chip (the same glyph before the actor's name, opening what it does on
  hover; a link to a skill, the agent or a tool in rendered Markdown opens
  the same popover and draws the glyph when its text is the bare name),
  module chips, the actor line, the station box, the cross-section figure,
  the station-by-actor matrix, the module map, the plan rail, the side
  index, the ladder, the section head, the plate, the live audit specimen.
  A page that opens with a plate beside its intro uses `.intro-row` and
  `.intro-plate` (`global.css`); the plate drops out below 1000 pixels.
  Adding `bleed` to the row makes the plate a
  [bleed](../GLOSSARY.md) hero: larger, behind the
  intro, its frame reaching past the window's right edge and feathered on
  its left, right and lower edges so the drawing eases into the page from
  beyond it (the factory overview and What you get use it). A plate that
  fills more of its own frame sets a smaller `--bleed-w` (its width) and
  `--bleed-shift` (the share of it past the window's edge) on the row, so
  its drawing still ends inside the window. The home page's hero sets its
  figure beside the text instead of bleeding it, and that figure is the
  [jig model](../GLOSSARY.md) (`JigModel.astro`, `scripts/jig-model.ts`):
  the model in `public/models/doweling-jig.glb`, drawn by three.js as paper
  faces with ink edges and silhouettes in the page's own tokens, so it
  follows the theme like a plate; the first stretch of scrolling
  (`--seq-len`, from the top of the document) scrubs its `close` clip, and
  a fine pointer swivels it a few degrees. The still `jig-still` plate, the
  model's own first frame captured by `website/scripts/jig-still.ts`,
  stands in its place until the first frame is drawn, so the model takes
  over unseen, and stays under reduced motion, without WebGL or JavaScript,
  and in a window narrower than 1000 pixels, where the script does not
  load; it loads on that page alone. The model's sources
  and how to rebuild it are in `website/models/doweling-jig/`. The page's foot is the
  mirror of the hero: the `slab` plate rising from the lower edge of the
  closing band, feathered on its upper and left edges and cut by the
  footer, so the page stands on it.
  Each closed set (levels, rungs, actors, scaffolding jobs) has one mapping
  site-wide and is never told apart by color alone.
- **Navigation**: the header stays at the top of the window. A section with
  pages of its own (the factory, adopt) lists them under its entry in
  `NAV` (`website/src/lib/site.ts`); the header opens that list under the
  entry on hover or keyboard focus, and on each of the section's pages
  holds it as a bar below itself, the current page marked, so the reader
  sees where they are among the section's pages however far they scroll.
  A page's own index of its sections or of its family's pages (the skills,
  the principles) is the side index, one design wherever it appears; a
  list taller than the window scrolls within it. Sticky rails and anchor
  jumps stop below the header through `--sticky-top` (`global.css`).
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
| `jig-still` | the home page's hero, the still in the model's place, 9:10 | not drawn by the image model: the jig model's own first frame, captured from the running site by `website/scripts/jig-still.ts` (`bun run jig-still <url>` in `website/`, after any change to the model, its camera or its engraving) and converted as a plate |
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
| `footing` | not yet drawn: the home page's foot, 3:1, in place of `slab` | a wide cross-section of the ground under a building: a concrete slab on driven piles, service pipes and conduits running the width of the drawing beneath it, and a scaffolding lattice standing on the slab at the right, cut by the drawing's upper edge |
| `numberer` | not yet placed: FEATURES.md's section on change notes and the `changelog` skill, 16:9 | an automatic numbering stamp on a stack of slips, one stamped slip on a booklet |

#### The jig's model

The hero's figure is a model rather than a plate because its motion has to
be exact: a self-centering doweling jig (two jaws on guide rods close on a
board when the T-handle turns, drill bushings drop into the guide block on
top, a bit descends through the centre bushing), built in Blender from
`website/models/doweling-jig/` (`parameters.json` holds the parts' sizes and
positions, `build.py` builds the parts and bakes the `close` clip; its README
has the commands and what stays in `build.py`) and compressed with meshopt into `public/models/doweling-jig.glb`.
The page draws it as a drawing, not a render: every part gets a
paper-coloured face, its sharp edges as ink lines, and an
[inverted hull](../GLOSSARY.md) in ink for the silhouettes the edges miss (a
slightly enlarged copy of the part with only its inside faces drawn, which
shows past the part's curving sides as an outline), all from the tokens; the GLB's own
materials are unused. The engraving's shade is drawn too, in a shader from
each part's UV map (one unit per 100 mm, U along the board and around the
cylinders): on the jaws and the guide block a face turned from one fixed
light is hatched in ink, and cross-hatched when turned away; the board
carries its grain along its length, hatched where it turns away; the round
parts (rods, screw, handle, bushings, bit) stay plain, their edges and
silhouettes being enough. Every line is about a pixel wide and fades out
where lines would pack closer than three pixels.
The screw keeps no UV map: its thread draws itself through its edges, and
its UVs would be most of the file. An image model is the wrong tool for a figure that
moves: a series of edited images drifts in style and in parts between
frames, where a model moves by a number.

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
- **Open**: every reader is served, search engines included.
  `website/worker/index.ts` answers with the built page or file, or a
  page's Markdown twin for a reader that prefers Markdown. The site sets no
  `robots.txt`, `noindex` or `X-Robots-Tag`.
- **Deploy**: `.github/workflows/website.yml` deploys every push to `main`
  (the site renders the documents, so most changes reach it). It needs the
  `CLOUDFLARE_API_TOKEN` secret of the `website` environment: a token
  limited to the account's Workers scripts and the zone's routes and
  domain-name records. To deploy from a machine instead, log in with
  `wrangler login`: `cd website && bun run deploy`.
- **CI**: the `website` change-area turns on the website steps of the
  `gate-set` job in `gates.yml` (type check, parser tests, build, link
  check) for any change to the site or to a document it renders; the
  required `gates` check waits for that job.

### Text for agents: Markdown and `llms.txt`

A coding agent that is sent to Jig's site reads HTML poorly: navigation,
scripts and layout surround the content. The site gives it the content as
Markdown, and an index to find it by.

- **A Markdown twin of every page.** The build converts the `<main>` of each
  page at a directory address to Markdown and writes it beside the page
  (`modules/M2/index.html` gets `modules/M2/index.md`,
  `scripts/markdown-twins.ts`); the not-found page is not one, and has none. Converting the built
  page, not the document it renders from, gives a page that combines several
  documents or hand-written copy a twin as well, and a twin carries what the
  page shows (the criteria beside a module's levels). What exists only for a
  reader at a screen (navigation, buttons, tabs, the language label of a code
  block, hidden elements) is left out, but a choice the page offers (an
  adoption profile) is kept with the text shown for each option. What the
  page says only through a label or an attribute is said in text: a mark
  with only a label (a criterion's rung), a link whose marks are hidden
  glyphs (a station box: who runs it), and a module-map cell's state under
  each profile. A legend that keys those marks is left out, since the twin
  says them in words, but the text it shows for each choice is kept. Code keeps every character and its language. A styled
  section label becomes a heading, with its note as a paragraph after it. A
  link to a page of the site, under any of the page's addresses, points at
  that page's twin and keeps its `#anchor`; the twin carries
  each anchor a twin links to as `<a id="...">` where that part begins, so
  the anchor lands in the twin as it does on the page. A page whose layout the
  converter reads badly is fixed by a rule in `markdown-twins.ts` or by
  using the element that says what it is.
- **Negotiation in the Worker.** A request that names `text/markdown` and
  prefers it to `text/html` (a higher quality, or listed first at equal
  quality; `*/*` does not count) gets the twin of the page it asks for
  (`worker/markdown.ts`): `Content-Type: text/markdown; charset=utf-8`,
  `Vary: Accept`, `X-Markdown-Tokens` (an estimate: characters divided by
  four) and `Content-Signal: ai-train=yes, search=yes, ai-input=yes`, the
  policy for the content once the site is open. Every page response carries
  `Vary: Accept`, so a cache keeps the two apart. A twin can also be asked
  for by its address, and gets the same headers. The Worker reads the twin
  whole whatever the request's method or conditions, so a `HEAD` gets the
  token estimate a `GET` would, and only a missing twin falls back to HTML. Cloudflare's own conversion setting is not used: the
  Worker serves the twin, which is built from the page and checked.
- **`llms.txt` at the root and in each section.** `/llms.txt` says what Jig
  is, from the README, and links to the file of each section:
  `/modules/llms.txt`, `/skills/llms.txt`, `/principles/llms.txt`,
  `/factory/llms.txt` and `/adopt/llms.txt`, plus the
  pages that belong to no section (what you get, what's new). Its first
  link, under "Start here", is getting started, where an agent asked to set
  Jig up in a repository finds the steps it follows. Each section
  file lists its pages, its overview and the skills' agent contracts
  included, each linked as its twin, with a line on it. The glossary has no
  file: it is long, and most of it is not about Jig. See
  [`llms.txt`](../GLOSSARY.md).
- **Derived where a document holds the list.** The modules, skills and
  principles come from the same parsers as their pages, so a document change
  reaches the files on the next deploy. The few fixed pages of the factory
  and adopt sections are named in `website/src/lib/llms.ts`, with the
  description their page carries, as the search index names its pages.
- **Links resolve.** `scripts/check-links.ts` parses each built `llms.txt`
  and twin as Markdown in the dialect the twins are written in
  (GitHub-flavoured: inline, reference and automatic links, bare addresses,
  images; not code), reads the HTML the file carries as it reads a page, and
  fails the build on a link to a missing page or twin, or to an anchor the
  page or twin does not have, as it does for a page.
- **Served like any page.** Any reader, agent or crawler can fetch it.

### Working on the site

```sh
cd website
bun install --frozen-lockfile   # and `bun install` at the root, for the audit renderer
bun run dev                     # http://localhost:4321
bun run build                   # what CI runs
bun run check                   # types
```

The parser tests run in CI's website steps of the `gate-set` job, and locally with
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

Done: the site, its design, CI and deployment from `main`, open to every
reader and to search engines.
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
5. **The live audit example shows Jig's own audit.** It shows a third
   party's repository today; Jig's own audit, rendered at build from a
   committed run of the audit skill on this repository, replaces it, and
   `website/scripts/audit-example.ts` and the specimen's caption follow.

## Left out

- **Pages for templates and reference code**: they link to GitHub, where
  the source is the page.
- **Comments, analytics, accounts**: nothing on the site sends anything
  anywhere; the choices it remembers (theme, CI provider) stay in the
  browser.

