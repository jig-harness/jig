# Changelog

Notable changes to Jig (called Groundwork up to 0.11.0). The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A version number is the version of the `jig` [plugin](plugin/README.md)
(`version` in `plugin/.claude-plugin/plugin.json` and
`plugin/.codex-plugin/plugin.json`), and each release is tagged `v<version>`.
Machines receive a change to the plugin only through a new version.

This file is written by the release step, not by hand. A pull request adds a
[change note](changes/README.md) under `changes/` instead; after the merge,
`scripts/release.ts` writes every note here and deletes it. A note that asks
for a release (every pull request that changes `plugin/` has one) becomes the
next version's section, and the step moves both manifests to that version
and tags it. Changes outside the plugin that a team using Jig would notice
(modules, templates, the documents it reads to adopt Jig) are listed under
**Unreleased**; Jig's website, CI and maintainer tooling are not listed
([which changes get a note](changes/README.md#when-a-pull-request-needs-one)). Why it works this way:
[ADR-0004](docs/adr/ADR-0004-change-notes-released-after-the-merge.md).

Before 1.0.0, a minor version can change behaviour that consumers rely on; such
changes are marked **Breaking** and say what a consumer changes.

## [Unreleased]

### Added

- `/followup`, Jig's own post-merge pass (`.claude/skills/followup/`): after
  a pull request merges, it reports what the merge still owes, with the
  evidence for each, and carries out what it may on its own. It covers the
  tracker item and its deferred findings, the release tags, on every merge
  (`scripts/release-tags.ts` lists every released version without an
  annotated tag on origin, at the commit that set it), the website (whether it deployed, and `scripts/site-diff.ts`, which
  builds the site before and after the merge and lists every page whose
  content changed, plus the hand-written text the merge should have changed
  and did not), the status pages and the documents that cite them, consumer
  repositories, and cleanup. Before the merge it lists what the merge will
  owe. The website's tests now fail when the factory page draws a roadmap
  item as not built after it has left the roadmap. Jig's own skills
  (`.claude/`) are now a high review-risk area, like the other agent
  instructions.

- `website/`: the jig-harness.dev site, an Astro build that renders this
  repository's documents as designed pages: the module map and a page per
  module (its levels with the audit's criteria, its mappings by CI
  provider), the software factory with its two figures, the adoption guides
  with a plan per profile and a hand-off link, the plugin, every skill,
  principle and glossary term, and what's new beside the roadmap, in light
  and dark, with search and term definitions in place (a module's pill
  opens its name and the problem it solves; an "i" beside a term of art such
  as *station* opens its glossary entry). Parsers read each
  kind of document and are tested against the real files; links land on the
  matching page or term, and the build fails on a broken one. The live audit
  example is rendered at build from a committed run. CI builds the site
  whenever the documents or the site change, and `main` deploys it as a
  Cloudflare Worker that serves it only to readers who opened a private
  link, so it can be shown to reviewers outside the team. Jig's mark now comes
  without letters too, square in light, dark and accent, for favicons and
  avatars. [design/website.md](design/website.md) has how it works and what
  is left.
- `/website-update`, one of Jig's own maintenance skills
  (`.claude/skills/`, not shipped in the plugin): it reviews every commit to
  `main` since the site was last checked (`website/content-sync.yaml`),
  fixes the site's hand-written copy, parsers and counts that a change left
  behind, in one draft pull request, files follow-ups for what is too large
  to review well, moves the record forward and reports.
  `bun scripts/website-sync.ts` lists the commits with their size and how
  each bears on the site, read from the change-area catalog; it marks those
  over 5,000 counted lines (`--max-lines`) for that call, reviewed when the
  parts the site renders are small enough. The context budget gate now also
  measures `.claude/skills`, in one session listing with the plugin's skills
  (M0's discovery check gains `--bare-skills` for that), and
  [CONTRIBUTING.md](CONTRIBUTING.md#jigs-own-skills) says where such skills
  live and how Codex finds them.
- Jig as a software factory: [FACTORY.md](FACTORY.md), which replaces
  `PLAYBOOK.md`, starts from what a factory of AI agents runs on, the
  repository's scaffolding for context, verification and kept knowledge, and
  which modules build each part, and how Jig fits an organization's own
  tools and values (modules, configuration layers, the tracker interface
  with Linear as its first adapter). It then maps the stations at the
  design-and-planning level (a feature or an epic) and the execution level
  (one work item), with what runs each station, what stays with a person,
  what is not built yet and what Jig leaves to the platform underneath. The
  README introduces the idea, and the glossary defines *software factory* and
  *PR (pull request)*.
- `tools/launcher/`: the issue tracker's "open in coding agent" button, as a
  machine-level tool. It assigns the issue to whoever opened it, saves the
  issue to a context file that `/jig:do-item` reads, picks the repository
  from the issue's label, and opens the workspace provider with the prompt
  (Conductor first, where a routed issue's agent starts once you click
  **Create**). Linear is the first tracker, behind a tracker interface.
  `install.ts` wires it into Linear's desktop app; its configuration is
  `~/.linear/launcher.yaml`.
- [design/reflection.md](design/reflection.md) describes the Notion store
  for reflections ([ROADMAP.md](ROADMAP.md) item 7) and a future Jira store.
  [design/](design/README.md) holds the designs of roadmap items until they
  are built.
- Every pull request re-evaluates the audit skill against its change
  ([CONTRIBUTING.md](CONTRIBUTING.md#keeping-the-auditor-current)).
  `bun run gates` fails until Jig's own audit record scores every current
  criterion and Jig's configuration exists, fits the audit's schema and has
  no unknown key in a Jig section (`scripts/check-audit-fit.ts`); the review policy flags a pull request that
  does not say what it changed in the audit.
- The parallel-workspace rules are written down, each with its reason: reuse
  a branch before creating one, never move work with `git stash`, install
  only with `bun install`.
- Jig's own pull-request lifecycle is written down: read the whole diff and
  run the gates before opening, open as a draft, mark it Ready after the first
  review round, merge only once a round after Ready has settled with the
  required checks green, and a person merges. `.config/jig.yaml` declares
  `drive.reviews_drafts: true`, the fact the draft-first order rests on.
- The factory on the site, redrawn and split into pages. Every actor is a
  chip that says what it is (`/` a skill, `@` the agent, `>` a tool, a
  silhouette for a person, a dashed chip for work not built yet) and opens
  what it does on hover, in the figures, the tables and the rendered
  documents alike. Figure 2 names what each station hands on, draws the
  follow-up return and the learning loop as the orbit around both levels; a
  third figure crosses every actor with every station; the scaffolding
  section places each verification module on the time axis of a session.
  The overview keeps the figures and the boundary; the scaffolding, each
  level and the learning loop have a page each, and every link into the old
  page lands on the section's new one.
- The site's plates (`website/public/plates/`): line drawings in the manner
  of a patent engraving, drawn in the ink token so they follow the theme
  (`Plate.astro` masks each file onto the text color). The factory page opens
  on a cross-section of a hall whose stations stand on scaffolding, each
  scaffolding job has its own plate, and the two levels, the learning loop,
  what stays with a person and what the platform supplies each have theirs;
  the home page's lede shows the jig itself; a faint scaffolding lattice
  lies behind sunk bands. [design/website.md](design/website.md) keeps the
  prompts and the conversion, so a plate can be drawn again.
- A "What you get" page on the site (`/features/`), rendered from the new
  [FEATURES.md](FEATURES.md): what a team can run, install or copy from
  Jig today, one section per feature with the skills that run it, the
  modules that state the practice and what is still open on the roadmap. The
  page is in the navigation, the footer, the home page's evaluator path and
  the search index.
- The website highlights the code in fenced blocks (such as the examples on
  the skill pages) in the site's own colors, in both the light and the dark
  theme.
- The roadmap's later work gains an evaluation of Bun's own linter and
  formatter (`bun lint`, `bun fmt`) as a replacement for Biome once they ship
  in a stable Bun release, with what the move would cost: the custom rules,
  the ratchet's counting, the rule settings and the module mappings.
- The website serves every page as Markdown for coding agents (each page at a directory address; the not-found page has no twin): a request that asks for `text/markdown` gets the page's Markdown twin (also at the page's address with `index.md` added), and the site has an `llms.txt` at the root and one in each of the modules, skills, principles, factory, adopt and plugin sections, linking to those twins, the section overviews and the skills' agent contracts among them. The build converts each page, keeping the anchors twins link to, checks every link in the twins and the `llms.txt` files, and fails on a missing page, twin or anchor ([design/website.md](design/website.md#text-for-agents-markdown-and-llmstxt)); the glossary defines the term.
- The roadmap gains item 22, merge conflicts measured: a report of where a
  repository's merges conflict, from its git history and from each
  resolution `resolve-conflicts` makes, with the cause of each conflict and
  the change that removes it. [design/merge-conflicts.md](design/merge-conflicts.md)
  has how it will work, starting from a replay of Jig's own history. The
  glossary gains *conflict hotspot*.
- [M16](modules/M16-releases-versions/mappings.md)'s mappings cover a released package's path to its registry: checks of what the package holds before it publishes (publint, Are the Types Wrong?, `twine check`, check-wheel-contents, `cargo publish --dry-run`), publishing without a stored token through npm's, PyPI's and crates.io's trusted publishing, and preview packages a consumer can install from a pull request before it merges. The glossary defines trusted publishing, provenance and preview package.
- [M16](modules/M16-releases-versions/mappings.md#listing-what-the-release-contains)'s mappings cover listing what a release contains: generating a software bill of materials from the tag's commit for npm, Python, Rust and container images, including bundled artifacts and builds with their own target or features; exporting a GitHub repository's dependency graph as an inventory of the repository, not a release; and attesting the bill of materials to a file or a container image with `actions/attest`, and verifying it. The module lists a bill of materials for each release as future work, and the glossary defines it.
- [GLOSSARY.md](GLOSSARY.md) defines a *seed lens*: a review lens Jig ships, the review form of one rule a Jig module states, for the part of the rule no gate can check. Seed lenses are planned for the `review` skill ([ROADMAP.md](ROADMAP.md), item 23).
- [GLOSSARY.md](GLOSSARY.md) defines *collection kind*, *lifecycle
  predicate* and *collection receipt*, the terms of the designed garbage
  collection of a developer machine's leftover worktrees, scratch, containers,
  branches, tool state and processes.
- The Orca workspace tool passes `--model`, `--effort` and `--surface` to
  the agent it starts, and with `--no-agent` runs the create hook in a
  background `setup` tab, still once per worktree
  ([tools/orca](tools/orca/README.md)).
- The glossary defines a **route**: the agent, model tier and reasoning
  effort chosen for one piece of work, derived by rules a repository
  declares, with the reason recorded on the pull request
  ([GLOSSARY.md](GLOSSARY.md)). The design that derives it is
  [design/agent-routing.md](design/agent-routing.md), decided in
  [ADR-0009](docs/adr/ADR-0009-routes-are-derived-by-rules-as-data.md).
- [GLOSSARY.md](GLOSSARY.md) defines the terms of the planned dispatcher,
  which starts the execution line's stages with nobody at the keyboard:
  dispatcher, tick, session runtime and factory identity, and the terms
  of its control function: outcome log, stage drift and nudge.
- [M12](modules/M12-parallel-agent-ergonomics/mappings.md#worktree-managers--agent-runners--where-the-hooks-wire)'s mappings say where Worktrunk runs a repository's worktree create and remove hooks: its blocking `pre-start` and `pre-remove` hooks in `.config/wt.toml`, each inside the worktree, so a failed remove hook keeps the worktree and its unsent reflection findings. Worktrunk skips project hooks when their approval is declined, so the hook must be approved before a removal for that guarantee to hold.

### Changed

- Jig's own CI runs on Linux only for pull requests and pushes to `main`.
  macOS and Windows move to a new nightly workflow
  (`.github/workflows/nightly.yml`) that runs the gate set on both and the
  drive-pr suite on macOS against `main` once a day, or on demand for any
  branch. The Linux gate job is now `gate-set`; the required `gates` check is
  unchanged.
- Jig's own CI runs every job on Blacksmith runners instead of GitHub-hosted
  ones: Linux on `ubuntu-2404` (`gates.yml`), and in the nightly run macOS on
  `macos-latest` (Apple Silicon) and Windows on `windows-2025`. The gate jobs
  are named `gates (linux|macos|windows)`; the required `gates` check is
  unchanged. `.github/actionlint.yaml` declares the runner labels.
- M1's pull-request workflow template selects work in one resolver job
  instead of a change-detection step copied into each job. Its single required
  check is now an aggregator job that runs on `!cancelled()` (not `always()`),
  fails when a selected job failed or was cancelled, and names the jobs that
  did. Every job has a timeout, and event values reach scripts through `env:`.
  The template says why a required workflow is never path-filtered at trigger
  level: a skipped required job counts as passing.
- Jig's own `gates` workflow: the `gates` check runs on `!cancelled()` and
  names the jobs that failed, and every job has a timeout.
- M10's CI architecture and pipeline templates run a suite per change only
  when a merge or the `verified` pointer waits for it; slow suites nothing
  waits for, such as a full end-to-end run or coverage, run on a schedule or
  on demand with a cheap proxy per change. A new table says where each kind
  of suite runs.
- M9's issue templates put a gate-firing flag on the item that ships the
  change, never on its epic, and define an epic by its role rather than by
  how many children it has.
- M9's memory tiers keep all work state on the tracker, give the in-session
  tier its worktree scratch, warn that scratch is invisible to other
  worktrees, and define a handoff: Done, Remaining, Decisions, Uncertain, then
  a `Resume:` line. Work state has one authoritative store; a second one
  beside it is ruled out.
- M0 records which instruction files each agent runtime was observed to load.
  An import is not a pointer, and a nested instruction file extends its
  parent rather than relying on any runtime's precedence. Tool-specific files
  import the universal file where the runtime can.
- ROADMAP gains new modules (M13 pipeline economy, M14 testing strategy,
  M15 contracts and error handling) and the corrected designs for the existing
  modules.
- Website: the navigation item that opens the plugin guide reads "Install"
  instead of "Plugin", matching the page it opens; the factory page's
  learning loop and the skills page name `reflect` and `review-reflections`
  as the skills that run the reflection cycle, and the module index lists
  both under M8, so their skill pages carry its chip; the adoption guide's
  search entry finds its grandfathering section. The module map lists
  modules in id order, as the home page does, instead of the default
  adoption order with a rank beside each id; the adoption guide and each
  module's page keep the order.
- The principles page shows each principle's statement and the first
  paragraph of its why, with a link to where it is visible on the site,
  instead of the title and one-liner alone.
- The website's What you get page (`/features/`) now matches the factory
  pages: its intro sits beside a plate, an at-a-glance card for each feature
  links to its section, and each section shows its own plate, its skills as
  chips that open what each one does, the factory stations those skills run,
  and each piece of work not built yet beside a chip for its roadmap item.
  The factory overview links to it.
- The website shows a skill the same way wherever it appears. On the module map and in a module page's "Run it with" panel, skills are now the factory pages' chips (`/` for a skill, `@` for the agent), and hovering one opens what it does.
- A module named in a page's text (`M7`) now opens the problem it solves when hovered, as the module chips on the factory pages already did, and its bare id is set as an id.
- Website: the top bar keeps to one row on every desktop width. Its links run
  from what Jig is (Features, Factory) through putting it to use (Adopt,
  Install) to the reference behind it (Modules, Skills, Principles, Glossary);
  the footer follows the same order. The theme switch is an icon, a sun or a
  moon for the theme in effect: it follows the system's setting until the
  reader picks light or dark, then keeps that pick.
- Website: the factory overview opens with its hall drawing as a hero: larger,
  behind the intro, fading into the page on its left, right and lower
  edges. Other pages can use the same pattern by adding `bleed` to an
  intro row. The overview's closing blocks (the learning loop, what stays
  with a person, what Jig leaves to the platform) now stand one above the
  other in the same layout, each with a larger drawing beside its text.
- Website: What you get opens with its tool-wall drawing as a hero, the same
  way the factory overview does: larger, behind the intro, fading into the
  page on its left, right and lower edges. A page using the pattern can now
  set the drawing's width and how far it reaches past the window's edge.
- The roadmap and the plan no longer list the M11 heartbeat as open work; it shipped with the cadence registry and the staleness classifier.
- FACTORY.md's supply-chain bullet names what M1 covers beside pinned
  automation: the release cooldown, the install-script allowlist and layered
  secret scanning.
- `design/plan.md` item 15 drops the skip check, stale-test triage, behaviour
  pins and runtime canary, which M14 now carries; the exceptions that prune
  themselves stay listed.
- The website and [FEATURES.md](FEATURES.md) call the parts a feature or
  factory station still lacks **On the roadmap** instead of "Not built yet",
  so the label reads as a planned addition with its roadmap item rather than
  as a feature that does not exist. The feature field, the dashed chips, their
  popovers, the factory legends and [FACTORY.md](FACTORY.md) use the one
  wording.
- The website's home page is laid out around its drawings: the jig stands
  beside the opening statement as a bleed and is assembled and closed by the
  first stretch of scrolling (a [plate sequence](GLOSSARY.md), CSS alone,
  a still plate without scroll-driven animations, under reduced motion or
  in a window narrower than 1000 pixels); the module map
  has a strip of its own under the factory, with what a filled cell means;
  the ways to use Jig each stand beside a plate; the page closes with
  where to start, above the foundation plate rising from its foot; the list
  of principles leaves the home page, which links to them from its close,
  as the module map's page now does. The frames are provisional, cut from
  the jig plate; [design/website.md](design/website.md) has the series
  to draw in their place.
- On the website, the left-hand index of a page of in-page sections (the features page, the plugin guide, the "On this page" lists) now quietly marks the section being read as you scroll.
- The website's home page draws its jig from a model: a self-centering
  doweling jig, built in Blender from the sources in
  `website/models/doweling-jig/`, drawn in the browser as a technical
  drawing in the page's own colors (paper faces, ink edges and silhouettes),
  closed by the first stretch of scrolling, turned a little as the page
  scrolls, and swivelled a few degrees by the pointer. Its shade is engraved:
  the jaws and the guide block are hatched where they turn from the light,
  the board carries its grain, and the round parts stay plain, all drawn
  from the model's UV maps in the page's own colors. The still plate stands in for it under reduced motion, without
  WebGL or without JavaScript. The provisional frame series it replaces is
  removed.
- The README's opening line, which the site's `llms.txt` also uses as its
  summary, now says who Jig is for and names all it provides: "A jig for AI
  coding agents: modular delivery practices, shared skills and gates, and an
  auditor that scores your repository."
- The website's Factory and Adopt sections show their pages in the header:
  a menu under each entry lists them (Escape closes it), and on each of the
  section's pages a bar under the header holds them, with the current page
  marked, as the reader scrolls. It replaces the page switch each page carried in its body.
- A skill's page lists the other skills in the same side index the
  principles and the adopt pages use; a list taller than the window scrolls
  within it.
- Jig's own CI holds between review rounds: `.config/jig.yaml` sets `ci.hold_label: ci:hold` and `ci.required_checks: [gates]`, and `.github/workflows/gates.yml` honours the label in the shape [M13's hold](modules/M13-pipeline-economy/README.md#7-hold) states. While a pull request carries it, every job but `gates` skips and `gates` fails, naming the label; `/jig:drive-pr` adds it before a round's intermediate push and removes it at convergence, which runs everything on the head the merge waits for. The gate set and the drive-pr suite are declared heavy for M13's workflow-convention lint, which checks the hold's trigger, guards and held-head step.
- The website's type check, parser tests and build run as steps of the gate-set job instead of a job of their own, selected by the `website` area. That area now follows what the site reads, listed in a new `site-sources` area (the documents the site renders and the audit skill with the code its renderer imports), rather than every document, plugin file and skill: a change to a change note, a design document, or a skill's scripts and tests no longer runs the site's build. A test derives what the build imports, collects and reads, and fails when a file of it does not select the website.
- The drive-pr suite runs in 3 shards instead of 4, and the `gates` job that collects the other jobs' results runs on GitHub's smallest hosted runner: a job bills whole minutes, so the shards fill them and the job that only reads results takes no Blacksmith minute.
- The roadmap and the plan lay out Windows support for `drive-pr` and
  `do-item` in steps: a Windows test harness, a pass's processes without `ps`
  and POSIX signals, state and locks hardened for Windows, the skills under
  Git for Windows' Bash, then PowerShell for Codex.
- The module map on the website starts on Team/Standard instead of Solo/Lite, so it opens with more of the modules filled and a clearer picture of what a team takes and leaves. The profile switch still offers every profile.
- Hovering or focusing a row of the home page's map opens that module's popover, the same one the module chips show, with a link to the module.
- The [queue-watchdog](modules/M13-pipeline-economy/templates/queue-watchdog.yml)
  and [runtime-canary](modules/M14-testing-strategy/templates/runtime-canary.yml)
  workflow templates check out Jig without a token of their own: Jig's
  repository is public, so the checkout needs no credential. A workflow
  copied from an earlier template can drop the Jig checkout's `token` line
  and the secret it names.
- **Breaking** for a workspace launcher that relied on its Orca provider
  starting `claude`: without an `agent` setting the launcher now starts no
  agent. The worktree opens in Orca, the repository's create hook runs in its
  `setup` tab without holding the launch, and the first prompt goes onto the
  clipboard and into the worktree's Orca comment, for the person to start the
  agent, model and effort they choose. Set `agent` (with optional `model`,
  `effort` and `surface`) to keep the agent started
  ([tools/launcher](tools/launcher/README.md)).
- [ADR-0005](docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md)
  is amended: Herdr stays the first workspace runtime for Jig's tooling,
  except the planned dispatcher, which targets Orca first.

### Fixed

- M6's changed-docs recipes (GitHub Actions and GitLab) read the changed
  documents the way M4's do: `git diff -z` into a file, with the
  `'docs/*.md'` pathspec. Documents directly under `docs/` are no longer
  skipped, names git would quote (non-ASCII characters, quotes, newlines)
  reach the checkers intact, and a failing `git diff` fails the step instead
  of reading as no changed documents. The GitLab recipe picks the sections
  manifest by stage directory, as the GitHub one does, so a document outside
  the stage directories no longer fails for want of a manifest. It also runs
  only in merge-request pipelines, fails under a shell other than bash, and
  extracts the base tree's gate scripts, with the `lib/` they import, into a
  fresh directory outside the merge request's checkout.
- M4's frontmatter-check test writes every temporary document and schema to
  a scratch directory outside the repository, so a suite that reads every
  Markdown file in the repository at the same time no longer fails on a file
  deleted mid-read.
- Renovate no longer reads the pinned, drifted and malformed versions inside `fixtures/` folders as Jig's own dependencies, so the Dependency Dashboard stops offering updates that would break the gates' test inputs and no longer reports a failed lookup for a fixture workflow.
- A link to a section of the getting-started, plugin, features or
  principles page no longer stops well below the header: it lands just
  under it.

## [0.115.0] - 2026-11-01

### Added

- `jig dispatch` follows up a merge: with the `followup` stage enabled in the
  machine file, each pull request merged since the stage started gets one
  session running the repository's `dispatch.followup_command` on it, in its
  workspace. A hidden-marker comment on the merged pull request claims the
  follow-up before the session starts, and an earlier marker makes a later
  run stand down. A follow-up whose session failed, or whose marker names a
  launch record the machine no longer has, is notified once and never started
  again; deleting its marker makes it wanted again. The session is an
  interactive one, so with Orca, which cannot yet bind one to a chosen
  account, each follow-up is reported and nothing is posted or started, as a
  pickup is.
- `jig dispatch marker claim|check|done <PR>`: how a follow-up command a
  person runs by hand claims the merge with a marker of its own, checks before
  each act outside the pull request that no earlier marker appeared (exit
  `3` when one did), and marks its marker done once it succeeded.
- `jig dispatch` reaches a person: with the `notify` stage enabled, each stop
  only a person settles is notified once per cause, through the session
  runtime: a drive parked with a decision unanswered (carrying the drive's
  framed decision and how to answer it, `answer <key>: …` on the pull
  request, which the next tick re-arms on), a drive stopped on an exit only a
  person settles or with no exit, a failed follow-up, a stalled pickup, a
  double claim and a session waiting past `dispatch.blocked_after`. With Orca
  the message becomes the workspace's comment and the workspace is marked
  unread, which Orca's phone app shows; a target with no workspace that can
  take it goes to the repository's notices workspace
  (`jig-dispatch-notices`). A message counts as sent only once the comment,
  read back, carries it, and is appended rather than written over while the
  workspace is still unread.
- `drives.ts --report`, the morning report, lists what the dispatcher
  launched, refused and notified on the machine since the last report, beside
  the drives.

### Changed

- A drive's notification is planned whatever session runs in its pull
  request's workspace: telling a person never competes with a session.

## [0.114.0] - 2026-11-01

### Added

- `do-item` claims the issue it picks up: `tracker.ts claim <key>` assigns
  it to the identity the tracker's credential acts as and moves it to
  `in_progress`, refuses an issue already in progress or assigned to anyone
  else (exit `3`, nothing written), and stands down when reading it back
  shows another claim landed first (exit `4`). `do-item` and `work-batch`
  stop on either instead of starting beside another session. The tracker
  interface gains `viewer`, `assignees` and `assign` on GitHub Issues,
  Linear and Jira.
- `jig dispatch` plans pickups with the stage's whole guard: an item a
  launch record or a running session holds is reported as running, one
  whose last session ended without claiming it waits until it leaves the
  dispatch states and comes back, an item more than one running session
  joins to is reported as a double claim, a claimed item idle past
  `dispatch.stalled_after` is reported as a stalled pickup and never
  relaunched, and a session it started that waits past
  `dispatch.blocked_after` is reported (both `30m` by default; see
  [CONFIGURATION.md](plugin/CONFIGURATION.md#dispatch)).
- The machine file's `pickup` stage starts a `do-item` session per pickup,
  once, where the session runtime binds the session to the account it
  bills: the fresh read just before the launch, admission and the identity
  check, a workspace on the item's own branch with its issue linked, the
  route's model and effort, and a launch record holding its slot while the
  agent works or waits. The session records how it ended with
  `jig dispatch result <record> <token> done|failed`. Orca cannot bind an
  agent launch to a chosen account yet, so with Orca each pickup is
  reported with that reason and nothing is started
  ([the dispatcher](plugin/README.md#the-dispatcher)).

### Changed

- **Breaking:** `dispatch.states` no longer accepts `in_progress`, the state
  `do-item`'s claim moves an item to, so a claimed item is never a pickup. A
  repository whose `dispatch` section lists it must remove it first: the
  section is refused with an error, and the tick plans nothing for that
  repository, re-arms included.
- A tick's launches stop at the deadline the installed launcher gives the
  whole tick (planning included, less the time its receipt needs), not at the
  smaller budget of its launches.
- A dispatch tick opens at most two workspaces, the opens its timer's
  deadline covers; a launch that needs another waits for the next tick.
  Which repository, stage and target comes first rotates by one each
  applying tick, counted in the state directory rather than read off the
  clock, so a target whose open fails every time cannot keep the others
  waiting whatever interval the timer was installed with.
- An agent Orca reports as `blocked` (on a permission prompt) now holds its
  stage, as a working or waiting one does.

## [0.113.0] - 2026-11-01

A repository can let a drive decide more during the hours nobody is there to ask, and a person reads one report in the morning. Both are built behind the opt-in and documented as not yet validated.

### Added

- `autonomy.off_hours`: `level`, the level a drive's pass decides at inside one of the windows of `schedule` (in the machine's local time zone, such as `Mon-Fri 20:00-07:00` and `Sat-Sun`; a window may cross midnight. Once the level is set the default schedule is `Mon-Fri 20:00-07:00`, `Sat-Sun` and `Mon 00:00-07:00`, so Sunday night is covered), capped by `max_level`. Unset, off-hours is off. The round header and `bun <plugin>/shared/autonomy.ts [--at <instant>]` print `wide (off_hours)` inside a window and the base level outside. See [`autonomy`](plugin/CONFIGURATION.md#autonomy).
- The `wide` level, which until now acted as `unattended`: a review thread the arbiter rules `escalate` with the class `escalated` and no recorded human decision behind it gets a **provisional** reply outcome (`rejected`, `wont-fix` or `deferred`, never a fix) through drive-pr's `provisional-reply.ts`, which checks the level and the recorded ruling, posts, resolves and records it in one call; `decide`'s last-row escalation, with no sensitivity flag, stakeholder category, persisted-data or published-contract consequence, is decided and recorded as `decide-provisional`. A re-arm after `HITL_PARKED` with items unanswered hands the `escalated` ones to the first round to decide provisionally, and refuses when one is any other class. `wide` and `off_hours` are documented as available only once a working repository has run them for a month with fewer than one in ten provisional decisions reversed before the merge.
- A provisional reply carries `**provisional**` after its outcome token and a hidden marker only `provisional-reply.ts` may post. `reconcile-replied-threads.ts` and `triage-thread.ts` skip a thread that stands on one, and the round gate does not count it as work even when a person unresolved it. A comment from an owner, member or collaborator on the thread (or `answer <key>: …` on the pull request for a `decide` ruling) reverses it: at the next round boundary the drive records the reversal and parks the item under `human-thread`. An unresolve alone reverses nothing. `human-thread` is kept among the park classes whatever `autonomy.park_classes` lists, beside `escalated` and `human-decision`.
- `drives.ts --report [--since <time>] [--json]`, the morning report: for every pull request this clone's state has news of and every open one the signed-in account authored or drove (through the drive ledger, which falls back for `loop-metrics.ts` too when this clone holds no state), since the last report (remembered in the state directory) or `--since`: the terminal state and what it means, provisional decisions first and whether a person reversed them, takeovers and re-arms, parked decisions framed in full, issues filed and deferred entries not yet filed.
- The drive state records the driver's exit, and the self-restarts and re-arms, as events the ledger carries, so the morning report reads how a drive ended from this clone's state or from the ledger.
- `loop-metrics.ts` counts, per pull request, the self-restarts by cause, the re-arms by cause and the takeovers (from this clone's drive state, which now records them), the provisional decisions and how many a person reversed before the merge, with that share, and the review bots' transparent chat acknowledgements.
- The drive ledger's `## Decisions taken unattended` lists provisional decisions first, with their key, outcome and reversal, and the ledger carries the drive's self-restarts and re-arms.

## [0.112.0] - 2026-11-01

### Added

- `jig --help`, `jig help <command>` and `--help` after any command (`jig gc --help`, `jig dispatch install --help`) print help generated from the command line's own definitions, with a plain description of every option; `jig completion bash`, `zsh`, `fish`, `pwsh` or `nu` prints a shell completion script for the `jig` command. The command line is parsed with [Optique](https://optique.dev), vendored in the plugin (`shared/vendor/optique.mjs`, MIT License). Every existing form of `jig gc` and `jig dispatch`, and the jobs `install` wrote, keeps its meaning and exit code: there is nothing a consumer must change.

### Changed

- A refused `jig gc` or `jig dispatch` command line prints Optique's error with the command's usage on standard error, still with exit 2. A repeated value option (`--interval`, `--followup-since`) still takes the last one given. A switch given twice (`jig dispatch --json --json`) is now refused there as it already was for `jig gc`, and `jig --help` exits 0 with the help instead of 2.

## [0.111.0] - 2026-11-01

The skills can work on a Jira Cloud project as their issue tracker, beside
GitHub Issues and Linear.

### Added

- A Jira Cloud tracker adapter, chosen with `issue_tracker.adapter: jira`:
  `do-item`, `drive-pr`, `file-issue`, `work-batch`, `reflect`, the
  dispatcher and the audit's reachability check work on the issues of one
  Jira project. `issue_tracker.team` names the project key (`ENG` for
  `ENG-123`). How states, priorities, issue types, fix versions, labels,
  parents and issue links map onto Jig's tracker interface is in
  [plugin/EXTENDING.md](plugin/EXTENDING.md#issue-tracker).
- Its credentials, `JIRA_EMAIL` and `JIRA_API_TOKEN` in the environment: an
  Atlassian account's email address and an API token made for it.
- The `issue_tracker.jira` configuration section, whose unknown fields are
  refused: `site`, the Jira Cloud site's `https://` address (required; an
  `*.atlassian.net` host, or one `JIRA_ALLOWED_HOSTS` in the environment
  names, so a repository's configuration cannot send the credential
  elsewhere);
  `issue_type` (default `Task`) and `subtask_type` (default the project's
  one sub-task type), the types new issues get; and `priorities`,
  `resolutions` and `link_types`, which name the Jira priorities,
  resolutions and issue link types Jig's priorities, closed states and
  relations map to
  ([CONFIGURATION.md](plugin/CONFIGURATION.md#issue_tracker)).
- On Jira, `issue_tracker.states` names are matched to status names ignoring
  case, a status no name matches is read by its status category, and
  `done`, `canceled` and `duplicate` may share one status when their
  resolutions differ.
- `dispatch.identity` on Jira: an Atlassian account id, or an email address
  or display name that matches exactly one user. An assignment starts a
  pickup only when a person's Atlassian account made it, not a guest, that
  can be assigned issues in the project.

## [0.110.0] - 2026-10-31

### Added

- `jig dispatch --apply` restarts stopped drives without a person: each
  re-arm of a drive stopped on a usage limit or an answered park, and each
  takeover of a wedged driver the machine started, runs in a terminal tab
  of the pull request's Orca workspace (opened from the pull request when
  none holds it), billed to an account the new machine file
  (`~/.jig/dispatch.yaml`) lists, within that account's cap and outside
  any usage-limit wall it recorded. A launch record written before each
  launch keeps a lost answer from starting a second pass, and a refusal
  `drive.ts` gives is not fought. See the plugin README's "The dispatcher"
  and CONFIGURATION.md's "The machine's dispatch file".
- `jig dispatch install [--interval 5m] [--yes] [--uninstall]` previews and
  writes the timer that runs `jig dispatch --apply`, on the same scheduler
  code as `jig gc install`.

## [0.109.0] - 2026-10-31

### Added

- `drive.pass_args`, a list of words, gives a drive's Claude Code pass
  command extra arguments, written before `-p` in the command `arm-drive.ts`
  builds for `/jig:drive-pr` and `/jig:do-item`; `--pass-args "<words>"`
  on `arm-drive.ts` and `drive.ts` overrides it for one drive. Set it to
  `[--permission-mode, bypassPermissions]` to let unattended passes write
  under protected paths such as `.claude/skills/**`, which a pass without a
  terminal is otherwise denied in a prompting mode, at the cost of skipping
  its permission prompts;
  the default is empty
  ([configuration](plugin/CONFIGURATION.md#drive)). The driver log and
  `drives.ts` name the permission mode each pass runs in, re-arm and
  takeover commands carry the arguments, a pass command that is not Claude
  Code's ignores the field and says so, and a value that is not a list of
  words stops the drive.

## [0.108.0] - 2026-10-31

### Changed

- The default `workspace_name.template` now ends with the pull request: `{id} {status} {title} {pr}` (for example `<item-id> [D] Rename workspaces #<number>`). The suffix appears once the work has a pull request, so the name at pickup is unchanged. [`workspace_name.template`](plugin/CONFIGURATION.md#workspace_name) sets another name, and `""` turns the renaming off.

## [0.107.0] - 2026-10-31

### Added

- `drive-pr` checks, before it announces merge-readiness, that the Orca
  workspace it drove the pull request in is linked to that pull request, and
  corrects the link when it is missing or names another one
  (`scripts/workspace-pr-link.ts`). Outside Orca it does nothing.

## [0.106.0] - 2026-10-31

### Changed

- `do-item` and `drive-pr` now rename the Orca workspace they run in by default, to `{id} {status} {title}` (for example `#12 [D] Rename workspaces`). [`workspace_name.template`](plugin/CONFIGURATION.md#workspace_name) changes the name, and setting it to `""` turns the renaming off.

## [0.105.0] - 2026-10-31

### Added

- `jig dispatch`, the dispatcher's tick as a report: for each repository it
  reads the items assigned to the repository's factory identity, each open
  pull request's drive ledger and the sessions Orca runs, and prints every
  pickup, re-arm, follow-up and notification it would start, each with the
  record that wants it and the evidence, starting nothing. A stage a running
  session holds is listed as running, and a record it cannot read is
  reported, never planned. Each run writes a receipt that
  `jig dispatch receipts` lists; `--apply` is refused in this version. See
  [the dispatcher](plugin/README.md#the-dispatcher) and the
  [`dispatch` section](plugin/CONFIGURATION.md#dispatch) of
  `.config/jig.yaml` (`identity`, `states`, `followup_command`), which is
  read from the default branch only.
- The tracker interface reads the issues assigned to one user in given
  states (`assignedIssues`) and who made an issue's current assignment
  (`assignedBy`), on GitHub Issues and Linear.

## [0.104.1] - 2026-10-31

### Changed

- `drive-pr`: the stops for a usage limit (exit `16`, and exit `6` when the
  limit is met on the last round) and for a pass that found the pull request
  no longer open (exit `5`) now list what the pass left in the tree, as a
  failed pass's stop does: the uncommitted paths and the commits on top of the
  head branch's remote ref, or that there are none, instead of advice to run
  `git status` and `git log` yourself.

## [0.104.0] - 2026-10-31

### Added

- `do-item` and `drive-pr` can rename the workspace they run in after the work and its stage, in Orca, when the repository sets [`workspace_name.template`](plugin/CONFIGURATION.md#workspace_name). The name can use `{id}`, `{status}`, `{title}` and `{pr}`; the status text is `[I]`, `[D]`, `[R]` and `✅` by default, and `workspace_name.statuses` overrides each. Nothing is renamed without the template.

## [0.103.0] - 2026-10-31

A drive stops for a person only on a decision the repository's human-in-the-loop registry reserves, and hands it over framed; every other decision it takes is recorded where a person can reverse it, and a repository can let it decide more while nobody is there.

### Added

- A configuration section, `autonomy`: `level` (`attended`, the default and today's behaviour, or `unattended`), the repository's ceiling `max_level`, which a person's user file or the environment may choose a level up to and never above, and `park_classes`, the decision classes a drive may park on (by default the registry template's rows plus `escalated` and `human-decision`); only the repository's file sets `max_level` and `park_classes`. A session a person runs reads `attended` unless that person chose a level. `wide` is accepted and acts as `unattended` until its column is built. `bun <plugin>/shared/autonomy.ts` prints the effective level and where it came from, and the drive prints the same line at the start of every round. See [`autonomy`](plugin/CONFIGURATION.md#autonomy).
- Under `unattended`, `file-issue` files an issue another skill needs without asking, and its body says which skill filed it, from which pull request and why (`scripts/confirm-step.ts` decides and prints that line); `decide` gathers the evidence an underdetermined call lacks within the round's budget, then applies its ladder, escalating a call it still cannot settle.
- Deferral without a tracker: where the deferral batch step cannot file (the repository's adapter is not Linear, or no Linear credential is set), `resolve-review-comments`' `defer-in-pr.ts` records the finding in a `## Deferred` section of the pull request body, by read-modify-write against the body's update time so a person's edits survive, and the thread resolves with `**deferred**` linking the section. `file-deferred.ts <PR>` files each entry through the configured tracker adapter, reusing an issue the tracker already holds for that entry (its source and fingerprint) unless the entry was corrected after that issue was filed, and replaces it with its issue; it names any `**deferred**` answer from an owner, member or collaborator, linking this pull request's own section, whose entry the body lost (a resolved thread's reply, or a summary finding's answer by its fingerprint), and exits `4`, and it fails rather than passing a thread whose comments run past one page; run it from a post-merge step or on a pull request closed without merging. See [the deferral protocol](plugin/skills/resolve-review-comments/references/deferral-protocol.md#deferral-without-a-tracker).
- `drive-state.ts record-decision` records a decision the agent took without a person, with the autonomy level (in force when it runs, or the optional `level` the caller captured), its class, its record's link and how to reverse it; the handoff file and the drive ledger list them under `## Decisions taken unattended`, and count one with no record as a defect.
- The review arbiter's `escalate` ruling carries a `class:` field (`human-decision` for a value the pull request records as a person's decision, else the registry row, else `escalated`) and a `human-decision:` answer. `drive-state.ts rule` records the arbiter's ruling with the thread's state: an `escalate` ruling needs its class, and one that touches a person's decision is always `human-decision`. A park of that thread then takes the recorded class and no other, and a thread ruled any other way is not parked.
- `review.bots` entries may be a login or `{login, confirmation_marker, chat_marker}`. A comment after a held reply is transparent, resolving with the hold and never triaged or answered, when it carries no outcome token and either its author's confirmation marker (the measured marker of a built-in reviewer applies whether or not it is listed) or, for a bot `review.bots` lists, its chat marker and no severity line. A bot the list leaves out, or one without a severity format known to be its own (declared in `review.severity_formats`, or built in; Jig's format, assumed for the configured reviewer, does not count), gets no transparent chat follow-ups. A built-in reviewer's chat marker is built in; turning its chat replies off in that reviewer's own configuration removes them at the source.
- M7's HITL registry template gives each row its class name and gains a row reserving parking to the registry's classes; the audit's `hitl-registry-published` criterion looks for that row. [ADR-0010](docs/adr/ADR-0010-parking-is-reserved-for-registry-classes.md) records the decision.

### Changed

- **Breaking:** `drive-state.ts park` requires `--class <one of autonomy.park_classes>` and a decision record on stdin (`## Question`, `## Options`, `## Recommended`, `## Class`, `## Steps for a person`, `## Already done`), and no longer takes `--reason`. A park without a class is refused with "decide and record it". A consumer whose own procedures or scripts call `park` must pass the class and the record ([drive-pr § 4](plugin/skills/drive-pr/SKILL.md#4-park-what-needs-a-human)).
- `HITL_PARKED` prints each parked decision in full, and the handoff file and the ledger carry them; `drives.ts --doctor`'s `NEEDS_HUMAN` row names the parked questions instead of their count.

## [0.102.0] - 2026-10-30

### Added

- `/jig:do-item` and `/jig:drive-pr` arm a drive in a terminal tab of the
  pull request's workspace, titled `drive #<PR>`, when the session runs in
  an Orca workspace. The drive then outlives the session and shows its
  passes there, and the session that implemented the item ends without a
  drive running beside it. Elsewhere the drive starts in the session's
  background as before. Both skills arm through drive-pr's new
  `arm-drive.ts`, which prints the command, what to do next, the pass model
  and the commands that list and stop the drive. It opens no tab while a
  drive already holds the pull request, and confirms that `drives.ts` lists
  the drive it started. The tab is a fresh login shell of the user's, so
  `bun`, `claude` and the Claude account come from it; the session's
  configuration reaches it as the `JIG__` overrides and the layer
  selectors `JIG_HOME`, `JIG_OVERLAY` and `JIG_USER_LAYER`, a blank selector
  kept blank; a selector the session leaves unset, and any `JIG__` field the
  shell's profile exports, are unset in the tab. A Windows host opens
  no tab: Orca's tab there can run `cmd.exe` or PowerShell, and the command
  is quoted for a POSIX shell.
- `do_item.arm_drive` says how a drive is armed: `auto` (the default: a tab
  where the session can open one, else the background, falling back to the
  background when Orca refuses the tab or the tab's drive is not listed in
  time), `tab`, `background` or `print` (the command only). Both skills read it
  ([configuration](plugin/CONFIGURATION.md#do_item)).
- `drive.pass_model` names the model each pass runs on: a model id, a
  Claude Code alias, or a routing tier resolved through `routing.models`.
  The default is `sonnet`, Claude Code's alias for the latest Sonnet.
  `drive.ts --pass-model` overrides it for one run, as does `arm-drive.ts
  --pass-model` for one arm
  ([configuration](plugin/CONFIGURATION.md#drive)).

### Changed

- Each pass of a drive whose pass command is `claude` now runs
  `claude --model <model>`: `drive.ts` adds the configured model when the
  pass command names none, so a drive with no setting runs on `sonnet`
  instead of Claude Code's default model. The driver log's `pass model:`
  line and the `drives.ts` listing name the model, and the re-arm and
  takeover commands the driver prints carry it. A pass command that is not
  `claude` chooses its own model as before.
- `/jig:work-batch` arms its drive through the same script.

## [0.101.1] - 2026-10-30

### Fixed

- `drive-pr`: work nobody pushed no longer stalls a drive in a `HEAD_LAG`
  wait that cannot end, or ends it over a dirty tree. When a pass ended its
  turn after committing without pushing and still exited `0`, or a drive
  was armed over local commits, the next status check read local HEAD ahead
  of the pull request's head as GitHub lagging behind a push and polled for
  its whole timeout (30 minutes by default) before stopping; meanwhile
  replies promised fixes that were not on the pull request and CI stayed on
  the old head. A pass that ended after editing without committing could let
  the drive converge and then stop with exit `12`. The driver now measures
  the tree afresh before every round's status check, the commits local HEAD
  has on top of the head branch's remote ref and the edits the last pass left
  uncommitted, compared by content (a symbolic link by its target), inside
  submodules and untracked nested repositories too (a commit in one
  included), however large an untracked file, and without a stalled
  filesystem holding up the driver (a tree dirty at arm still stops at
  convergence), hands
  the round out over that head as it already did after a pass killed at its
  deadline, and tells the round's pass to push them (a notice opening
  `UNPUSHED COMMITS`, or `UNCOMMITTED EDITS` for edits alone). Commits that
  do not build on that ref, which no round could push, stop the drive at once
  with exit `1`, naming them; the attach's refusal of a diverged tree at arm
  time names them too. A head that was pushed and that GitHub has not caught
  up with is still waited for. A failed pass still stops the drive, to be
  re-armed; its stop now lists the paths it
  left uncommitted, untracked files and modified submodules included, and the
  commits it left unpushed.
- `drive-pr`: the drive's filesystem probes (the tree measurement above, the
  check for an unfinished merge or rebase, and the status check's comparison
  of the driven tree with the tree it measures) run under the plugin's own
  empty Bun configuration and without `.env` files, so a consumer
  repository's own Bun configuration (a `bunfig.toml` preload, say), or one
  in the temporary directory, can no longer fail them or write into their
  output.

## [0.101.0] - 2026-10-30

### Added

- `/jig:changelog lint` (`lint.ts` in the `changelog` skill) checks the whole
  changelog against the rules of its own format and of no other, Keep a
  Changelog 1.1.0 or Common Changelog, as `changelog.format` names it or the
  file says: the title and the text above the releases, release headings and
  their order, dates written year-month-day, change types and their order
  where the format sets one, link references, and a section for every version
  the version files or the tags name. Each finding gives the file, the line,
  the rule and what to change, with the section of the format's specification
  that states the rule; what a format allows, such as a yanked release or an
  Unreleased section without a date, is never a finding. The check reads the
  file through Bun's CommonMark parser, so it judges what the file renders
  as: a link is one that renders, and text in a comment or a code block is
  not read as structure. The skill's GitHub
  Action runs it as `command: lint`, after a checkout with `fetch-depth: 0`:
  in a shallow clone the tags are not the whole history, so coverage is not
  checked and the command exits 2. The rules per format are in the
  [skill's README](plugin/skills/changelog/README.md#checking-the-whole-changelog).

### Changed

- The Common Changelog template is now the title alone, since the format
  allows nothing but releases after it, and setup writes `changelog.format:
  common-changelog` for that format, which a file holding only its title and
  releases cannot name. A Common Changelog file whose opening paragraph names
  its format keeps working; `lint` reports the paragraph, and once it is
  removed the repository sets `changelog.format`.

## [0.100.0] - 2026-10-30

### Added

- `do-item` shows, after it fetches an item, the requirements, acceptance
  criteria and tasks the item carries: its `## Spec`, `## Requirements` and
  `## Acceptance criteria` sections, with the ids the text gives them
  (`FR-001`, `AC-1`, a numbered checkbox) or, for an item with none, an id
  derived from its text, and each reference it did not read with the reason.
  The resolver behind it (`plugin/shared/spec/resolve.ts`) reads only inside
  the repository: an absolute path, a `..` that leaves the root, a symbolic
  link out of it, a file Git ignores, such as `.env`, and a pipe or device
  are refused before anything reads them, each file in a referenced folder
  is checked on its own and reported when refused, and no web link is
  fetched. A reader that does not answer within 30 seconds is given up on.
  Nothing else in the pickup changes. New fields, `specs.adapters` and
  `specs.body_section`, set which readers run and the spec section's heading
  ([configuration](plugin/CONFIGURATION.md#specs)).

## [0.99.0] - 2026-10-29

A pull request's drive resumes from the pull request itself: a drive started in another clone or on another machine picks up where the last one stopped, and a stuck driver in another clone can be taken over.

### Added

- `drive-pr` mirrors the resumable part of its state into one comment on the pull request, the drive ledger (`<!-- drive-pr-ledger -->`): its version and generation, the round, attempt and deadline-restart budgets and the phase, the last counted and verified heads, the Ready mark, every parked item with its decision, every held item with its outcome, answer and pushed commit, the takeovers, the driver's working tree and heartbeat, and the last twenty lines of the handoff narrative. No account hash is posted, and email-shaped text and account identifiers in the narrative, the parked decisions and the held answers are replaced with `<redacted>`. The driver writes it at every round boundary, park and takeover, through a usage-limit sleep or a mailbox pause (as the wait starts, then every quarter of the shortest lease window any clone applies; a write that does not land is retried within minutes, and a newer takeover claim from another clone ends the wait with `TAKEN_OVER`), and when it stops. `drives.ts --stop` marks it stopped once the driver and its pass are witnessed gone, and `--stop` or `--doctor` against the driver record a driver marks released as it releases its locks does the same after a signal stop, each only while the ledger still names that driver. A driver that kept its locks, or was killed outright, may have left its pass running, so its ledger stays running. A ledger too long for one comment loses the held items' outcomes first and the narrative second, never a parked decision. Only a ledger written by the drive's own login or by an owner, member or collaborator is trusted; any other comment carrying the marker is ignored and reported. See [where its state lives](plugin/skills/drive-pr/README.md#where-its-state-lives).
- A drive that starts with no state for the pull request, or with state older than the ledger's generation, seeds its state and its handoff narrative from the ledger; a ledger version it does not read, comments it cannot read, or a handoff file it cannot write the narrative into stop it with exit `1`, seeding nothing. `DRIVE_PR_LEDGER=off` drives without the ledger.
- `drive.ts --take-over` reaches a driver in another clone: it is admitted once that driver's ledger heartbeat is older than the lease window (the doctor's stall threshold), and claimed with a takeover claim on the pull request (`<!-- drive-pr-takeover-claim -->`). Any drive that does not continue its own clone's ledger claims the same way, so two clones arming at once do not both drive. Of two clones claiming at once the earlier comment wins; a claimant that cannot read the claims back does not take over; a claim whose clone never got the drive going lapses after the lease window. See [picking up a stopped drive](plugin/skills/drive-pr/README.md#picking-up-a-stopped-drive).
- A new terminal state, `TAKEN_OVER` (exit `20`): a driver that finds another clone's takeover claim newer than its own at a round boundary, or just before it spawns a review or repair pass, stops without another pass, and a claimant whose claim lost to an earlier one stands down. A driver resuming its own clone's ledger measures claims against the position that ledger records, so a claim another clone posted while it was away is arbitrated rather than adopted. A driver that exits with its locks retained, over a pass whose end could not be witnessed, leaves the ledger naming it running. The arbitration holds once every driver of a pull request runs a version that reads the ledger.

### Changed

- Arming a drive while the ledger names a running driver in another clone is refused with exit `13`, naming that driver's heartbeat and, once it is past the lease window, printing the `--take-over` command. Before, a second clone could drive the same pull request beside the first.

## [0.98.0] - 2026-10-29

A drive recovers by itself from the stops that need no decision, and a stopped or stuck drive can be picked up from another session of the clone.

### Added

- `drive-pr` restarts from a pass killed at its deadline: it reports what the pass left uncommitted and unpushed, leaves both in the tree, tells every pass what it inherits until one completes and starts the next round, which the drive does not converge without, uncommitted edits alone included, up to `drive.pass_deadline_retries` times per drive, counted in the drive state so a re-arm or a takeover does not reset it, and cleared when the drive converges or the PR closes, or else ending the drive with exit `1` and the command that clears it (default 2, [configuration](plugin/CONFIGURATION.md#drive)); past that it stops with exit `15` and says the budget is spent. See [a stopped drive restarts itself](plugin/skills/drive-pr/README.md#a-stopped-drive-restarts-itself).
- A stalled drive runs one more round with the stall's diagnostics in the pass's notice before it stops with exit `14`, and the stop prints what the passes recorded deciding at the end of the handoff narrative.
- A quota park records the billing account the wall belongs to (hashed), as the pass that met it was spawned, and the exit names it and prints the re-arm command. While the wall is in effect, a re-arm is admitted from a pass that bills a different account and refused with exit `16` on the same account or an unknown one, which includes one known only by a token or API-key fingerprint; `--window-reopened` lets a person re-arm once a window whose reset was never known has reopened. See [picking up a stopped drive](plugin/skills/drive-pr/README.md#picking-up-a-stopped-drive).
- A park records when it was made, and a re-arm of a drive stopped `HITL_PARKED` unparks every item once each has an answer from an owner, member or collaborator later than the park (on its thread, or in a pull-request comment with a line `answer <key>: …` outside any code block), in one state change that unparks all or none, and hands the answers to its passes as human verdicts, kept in the drive's state directory until a pass completes so a drive that stops first hands them on at its next re-arm; a kept file that cannot be read stops the re-arm and stays in place. A park replaced under the same key, or added, while the answers are read keeps every item parked, and the re-arm is decided on the drive state read again once the drive's locks are held. A pass notice too long for one environment variable is written to a file the variable names, and a notice that cannot be written whole stops the drive before the pass.
- `drive.ts <PR> --take-over` replaces a driver that holds the drive's locks when `drives.ts --doctor` calls it `WEDGED`, stopping it with the identity check `--stop` makes and only the acquisition its verdict was read from (`drives.ts --stop <PR> --expect-started <ISO>`, which exits `3` for any other holder), or when its process is confirmed gone and its tree holds nothing unpushed; the checks that need no lock, and this tree's own lock, run before the holder is stopped, and a refusal that can only come after the stop (attaching the tree, the PR lock) says the holder was stopped and prints the re-arm command; it records the takeover in the drive state, reconciles replied threads before the first triage, resumes at the same round, and reopens a held thread whose promised fix is not verified as pushed by holding it again as unconfirmed on its reply, so it is not resolved until a pass confirms the fix or replies afresh; a hold it could not reopen is recorded and reported apart. Against any other holder it refuses with exit `11`.

### Changed

- An exit-`11` refusal names the holder's `--doctor` verdict and, when the holder is `WEDGED`, prints the `--take-over` command. The rule for a live driver is now "do not stop a driver that is making progress; take over one that is wedged or dead", in `drive-pr` and `do-item` alike.
- Every re-arm command a stop or refusal prints carries the drive's own pass command after `--`, so a drive whose passes run another agent tool is re-armed with that tool; the Claude Code pass is printed only when the pass command is not known, as for a holder driving another pull request.

### Fixed

- Attaching a pull request no longer refuses a working tree with uncommitted changes that it leaves where it is: a tree detached at or past the head under the pull request's record while another tree holds the branch, or with commits of its own past the head. Re-arming a detached drive after exit `15` or `16` keeps what the killed pass left for the drive to handle, as it already did for a tree on the head branch.

## [0.97.2] - 2026-10-29

### Fixed

- **audit:** `gc.worktree_roots` and `gc.scratch_prefixes` name places that
  exist on some machines only, so a root that is missing where the audit runs
  is no longer reported as a finding.
- **gc:** `jig gc install` run from a linked worktree registers the clone's
  primary checkout, and resolves the declaration's relative roots from it,
  rather than registering the linked worktree. An entry an earlier version
  registered for a linked worktree is replaced on the next install, and
  removed by uninstall; `jig gc --collect --repo` from a linked worktree
  collects under the primary checkout's entry, while a report from it still
  reads that worktree's own declaration. A checkout Git fails to read there
  fails the collection's inventory (exit 1) rather than reading as a
  repository with no entry. A directory inside a checkout is none of the
  clone's checkouts: collection from it finds no entry, and install and
  uninstall refuse it. Paths compare with symbolic links
  resolved, so an entry naming the clone through another path is the same
  clone's.

## [0.97.1] - 2026-10-29

### Fixed

- `drive-pr` with `DRIVE_PR_ATTACH=off`: the advice for counting unpushed
  commits after a review quota stop or a pass deadline no longer names
  `@{u}..HEAD` where the tree has no upstream. It reads the same sources the
  leftovers check reads: the upstream when it exists, else the attach
  record's remote ref, else it says no range can be named and gives
  `git log HEAD --branches --not --remotes` to check by hand.

## [0.97.0] - 2026-10-29

### Added

- `/jig:red-team` reviews a requirements document (a PRD) or an architecture
  document adversarially, by persona: a critical chief technology officer, a
  security auditor, a performance engineer and a cost optimizer read both
  kinds, and a requirements document is also read by a reader who knows no
  engineering terms, a scope cutter, an acceptance tester and a
  day-in-the-life walker. Each persona reads in fresh context (a subagent,
  else a fresh run of the agent command, else this session, which the report
  then says), and one report gives each persona's verdict and every finding
  with the quoted passage, the risk and the question the author must answer.
  It never edits the document, and the report ends with the line the
  accepted document's stage-review record cites it with. It is the runnable form of
  [M6](modules/M6-feature-delivery-pipeline/README.md)'s per-stage
  adversarial review for the requirements and architecture stages, and the
  [greenfield guide](adoption/greenfield.md)'s critical-analysis phase
  points at it ([the skill](plugin/skills/red-team/README.md)).

## [0.96.0] - 2026-10-29

A pull request can be driven from any working tree of its clone, from the clone's primary checkout, or from a session in another repository.

### Added

- `drive-pr` attaches the pull request to the working tree once it holds both the tree's lock and the pull request's (`plugin/skills/drive-pr/scripts/attach-pr.ts`, also runnable alone): it checks that the drive's remote (`repository.remote`, else `origin`) is the pull request's repository, fetches the head branch from it and checks it out when no other working tree of the clone holds it, or checks out the head commit detached when one does, and never creates a second branch with a suffixed name. It refuses, naming what is in the way, a tree it would move that has uncommitted changes or an unfinished git operation (a tree already on the head branch, at or past the head, is not moved), a tree holding the branch that is dirty or has commits the head lacks, a detached head with commits no branch or remote holds, the clone's primary checkout on another branch, and a pull request from a fork, and it moves no tree a live driver or an interactive session holds; run alone, it holds both driver locks while it moves the tree. `DRIVE_PR_ATTACH=off` drives the tree as it stands, and placement then attaches nothing. See [which working tree drives it](plugin/skills/drive-pr/README.md#which-working-tree-drives-it).
- A detached tree records its pull request, head branch and attached commit in its own git directory, read while its head descends from that commit and the branch is on the remote; on a detached head every script that reads the branch name, counts unpushed commits or resolves the pull request from the current branch reads that record, so base sync, the intent-chain pin, the handoff's issue key, the round's base, `drives.ts --doctor`'s leftover check, `resolve-conflicts`' side labels, `resolve-review-comments`' thread and annotation listings and `fix-ci`'s log parser work in a detached tree. The drive state keeps a copy as `drivenBranch` for the handoff file.
- `/jig:drive-pr <PR>` from the clone's primary checkout arms the drive in the tree that holds the pull request, or creates one with git's `worktree add --detach` under the first root `gc.worktree_roots` names (read as the new tree is driven, without this session's `JIG_OVERLAY` or `JIG_CONSUMER_ROOT`), after checking that that clone's remote is the pull request's repository, and records it at once, so an attach there that fails is retried in the same tree; resource collection's `worktrees` kind reads a detached tree's record to report it once its pull request merges or closes.
- `/jig:drive-pr owner/name#N` or a pull request URL arms the drive of a pull request in another repository, in the clone the new user-file field `clones` maps it to, checking its human checkpoint against that repository's tracker, or prints the command to run in a checkout of that repository when none is mapped ([`clones`](plugin/CONFIGURATION.md#clones-user-file-only)). The placed tree's configuration is read, and its attach, checkpoint and driver run, without the variables that would select this session's repository, configuration, tree or drive state; `attach-pr.ts --place` names them in its output.

### Changed

- `do-item` never creates a branch or a second pull request for an item whose pull request is already open: it stops before delegating and hands the item to `/jig:drive-pr <PR>`, which places the drive in a working tree on the pull request's head.
- `drive.ts` refuses a pull request number written with leading zeros (`042`), which GitHub reads as the number without them, so its locks, state and log are always keyed by the number GitHub uses.
- Resource collection's `worktrees` kind reads a worktree's pull requests and its integration branch through `repository.remote` instead of always `origin`, and a detached tree's pull request through the remote the tree's record names; `jig gc install` proposes that remote, its URL and its integration branch for confirmation. A detached tree whose head another remote branch holds (a stacked pull request's work) is not reported by the pull request its record names.
- The recovery advice after a stopped pass counts unpushed commits against `refs/remotes/<remote>/<head-branch>` instead of `@{u}`, which a detached tree does not have.

## [0.95.0] - 2026-10-29

### Added

- The [`docs` skill](plugin/skills/docs/README.md) (`/jig:docs`), the runnable form of [M4](modules/M4-docs-governance/README.md): one pass over a repository's docs tree that runs the frontmatter check, the index freshness check, the `last_updated` check over the branch, the scar lint and the deferral check, prints the findings by file (or as JSON), warns of drafts not updated for longer than `docs.stale_after_days` (180 days by default), and lists the documents the project's type calls for and the tree lacks: an index, the wiki schema, an activity log and decision records for every project, runbooks for a service, a reference for a library. It detects the docs tree, the schema and the project type; the new `docs.root`, `docs.schema` and `docs.stale_after_days` fields correct it ([configuration](plugin/CONFIGURATION.md#procedure-skills)).

### Changed

- **Breaking** for a repository that runs one of M4's reference gates from a Jig checkout: the gates moved from `modules/M4-docs-governance/reference/` into the skill, at `plugin/skills/docs/scripts/` (`frontmatter-check/`, `index/`, `stale-last-updated/`, `stamp/`, `scar-lint/`, `deferral-references/`, and the shared reader at `lib/docs.ts`). Each keeps its command line, variables and exit codes, so a hook or CI job changes only the path; the scar lint's self-test is now `plugin/skills/docs/__tests__/check-descarring-scars.test.ts`. The frontmatter check reads its schema with the plugin's vendored js-yaml, so a vendored copy keeps the plugin's layout (`skills/docs/` beside `shared/`) instead of Jig's `lib/`. M4's [mappings](modules/M4-docs-governance/mappings.md) and the `deferral-liveness.yml` template name the new paths.
- The audit's configuration-fit check runs the `docs` skill's own validation of the `docs` section, so it reports what `/jig:docs` refuses: a root or schema outside the repository, including through a symbolic link, and a `stale_after_days` that is not a whole number of days.
- `descar` runs the `docs` skill's scar lint when the repository has none of its own, instead of reading every page by hand.

## [0.94.2] - 2026-10-29

### Changed

- The [`resolve-conflicts`](plugin/skills/resolve-conflicts/SKILL.md) test that proves the history replay runs no configured filter no longer deletes its marker file before the replay, since no filter is configured until after the merge is recorded, and it says why the merge comes first. The skill itself is unchanged.

## [0.94.1] - 2026-10-29

### Changed

- The values a repository already implies for its configuration (the gate
  command, review bots, the repository the forge names, stacked pull
  requests, the issue-tracker team, the change-area catalog, the integration
  branch and the package manager) are read by one detector the skills share,
  `plugin/shared/detect.ts`, which returns each value with the evidence it
  was read from and drafts the starter configuration. The audit's
  configuration fit and `fix-ci`'s package-manager detection call it; what
  they report is unchanged.

## [0.94.0] - 2026-10-29

### Added

- `repository.remote` names the git remote the delivery skills push to and fetch from, `origin` by default ([CONFIGURATION.md](plugin/CONFIGURATION.md#repository)). `drive-pr` fetches the pull request's base from it, diffs against `<remote>/<base>`, derives the integration branch from its `HEAD`, pushes through it, and refuses when its addresses do not name the pull request's repository; `do-item`'s `pr-plan.ts open` measures against it and prints it (`remote:`); `fix-ci`'s `probe-base.ts` uses it when `--remote` is not given; `resolve-conflicts` and `work-batch` fetch and merge through it; the GitHub Issues adapter derives its repository from it. A clone whose remote is called `upstream`, or a fork setup where `origin` is the fork, sets it once, in the repository's file or a person's user file. The name may hold ASCII letters, digits, `.`, `_`, `-` and `/` and must make a valid ref prefix; any other value, `null` included, is an error naming where it was set, and so is a `repository` section that is `null` or not a mapping. The audit's configuration-fit check reports both `null`s as errors.

### Changed

- The review-triage file's `severity_mapping.<severity>.linear_priority` is now `priority`, the tracker interface's name; `linear_priority` is accepted as an alias, and a row may not set both.
- `fractal-metrics.ts --skip-linear` is now `--skip-tracker`; `--skip-linear` is accepted as an alias.

## [0.93.0] - 2026-10-29

### Added

- `/jig:code-stats` reads the repository's test-runner configuration, so a
  repository whose tests only its test runner names counts them as tests
  with no `code_stats` section: jest's `testMatch`, `testRegex` and `roots`,
  vitest's `test.include` and `test.exclude`, pytest's `testpaths` and
  `python_files`, Gradle's `test` source set folders and Maven's
  `testSourceDirectory`. The files are read as text and never run; a
  configuration that exists only when it runs is reported as
  `unreadable: <path> (<why>)` and nothing is claimed from it. The layer
  sits between built-in detection and the `code_stats` configuration,
  `--explain` names the reader, file and key behind a test it found, and
  `--json` lists the configurations read and those that could not be under
  `testRunners`
  ([README](plugin/skills/code-stats/README.md#test-runner-configuration)).

## [0.92.0] - 2026-10-28

### Added

- `do-item` now says which [route](GLOSSARY.md) the agent that
  implements an item would run on: the agent, the model tier (Execution or
  Strategic), the effort and the runtime's model, each with the rule behind
  it, in the status message, such as
  `Route: execution, high, sonnet (type bug: medium; flag has-migration raised medium)`,
  for the item and again for each sub-issue it moves on to. The
  base comes from the item's work type; a flag label, an area with a
  mandatory review, a size too large to batch and the human-in-the-loop
  label each move the effort up one step, never past `max`; an item whose
  type is `unknown` takes the strictest row. The new `determine_route.ts`
  script derives it. Nothing is forwarded to the implementer in this
  version, so no repository's model changes. See
  [do-item's README](plugin/skills/do-item/README.md#the-implementers-route).
- A `routing` section in `.config/jig.yaml` holds the rules as data: each
  work type's base tier and effort, which flags and sizes raise the effort,
  whether a mandatory review does, and each runtime's family alias per tier
  and spelling per effort (by default Claude Code's `sonnet` for Execution
  and `opus` for Strategic). Without the section the route is still derived
  and reported; `routing: {}` opts in with every default. A section the
  loading rules refuse stops the pickup before the item or sub-issue is
  started or assigned, naming the field at fault, and the audit's
  configuration check reports it, along with a raise list naming a label the
  label taxonomy does not declare, judged as the pickup judges it, or a label
  taxonomy it cannot read. See the
  [configuration reference](plugin/CONFIGURATION.md#routing).

### Changed

- `do-item` stops the pickup when the work-type settings
  (`issue_tracker.types`, `do_item.work_types`) are refused, where it used
  to report the refusal and go on: the route reads the same settings, so
  going on would start and assign the item before the route refused it.

## [0.91.3] - 2026-10-28

### Fixed

- The replied-thread sweep and `triage-thread.ts` keep declined code-scanning findings open until their alerts are confirmed dismissed, and a `moot` open until its alert is fixed, closed or dismissed; `triage-thread.ts` exits `4` while one is not. A code-scanning `moot` is never held for a push, so a retry after its alert settles resolves it, and a thread GitHub's code scanning account opened whose alert cannot be identified stays open. A retry or `--cleanup-only` on a resolved code-scanning thread whose `moot` superseded an `accepted` reply releases that stale hold. `finish-round.ts` no longer refuses the push for such a thread, answered and waiting on its alert, so a `moot` resting on the round's own fix can be pushed, including when a trusted bot's automated confirmation follows the reply. A code-scanning `moot` held before this release no longer resolves when the round drains it: `resolve-held-thread.ts` reads its alert and, unless it is fixed, closed or dismissed, drops the hold and leaves the thread open for the sweep, and `finish-round.ts` reports that item `left-open` rather than `resolved`. The alert is read before the drain's last comment and head checks, so a comment or push landing during the alert reads still stops the resolve.

## [0.91.2] - 2026-10-28

### Added

- [M14](modules/M14-testing-strategy/README.md) ships a fixed-delay gate,
  [`reference/fixed-delay/`](modules/M14-testing-strategy/reference/fixed-delay/README.md):
  it fails a fixed delay (by default `Bun.sleep(`, `setTimeout(`, `sleep(`
  and `time.sleep(`; `--pattern` names others) without a
  `fixed-delay: <reason>` token on its line or the line above, a token
  without a reason, and a token with no delay on its line or the line below.
  It has no imports beyond Bun's and Node's built-ins, so it can be copied as
  it is.
- The audit's M14 criteria gain `test-exemptions-prune-themselves` and
  `fixed-delay-tokens-prune-themselves`: a check that passes an exemption
  matching no file, or a suppression token with no reason or no delay
  beside it, scores convention at most on them. `tests-come-with-changes`
  and `fixed-sleeps-banned` keep their bars, so a re-audit reports the two
  as added by Jig rather than as a regression.

### Changed

- M14's tests-with-changes gate fails an exemption whose glob matches no file
  in the tree it reads (`HEAD` with `--base`, the `--root` tree with
  `--changed`), with exit 1 and the line to delete, whatever the change
  touched. A repository whose exemptions file still holds a line for deleted
  code sees that line fail on its next change; an exemption whose only file a
  change deletes fails in that change.

## [0.91.1] - 2026-10-28

### Changed

- A CI hold's held-head check, when it sits in the required job itself, may
  cancel its own run instead of failing it
  ([M13 § Hold](modules/M13-pipeline-economy/README.md#7-hold)). A
  cancelled required check blocks the merge as a failed one does, but once
  the release passes, the head the merge waits for lists the held run as
  cancelled rather than as a red failed check. The shape, with the
  `actions: write` permission it needs and the failure it falls back to, is
  in [M13's mappings](modules/M13-pipeline-economy/mappings.md#hold);
  drive-pr's CI-hold setup, the audit's `ci-hold-fails-held-heads` probe and
  the workflow-convention lint accept it.

## [0.91.0] - 2026-10-28

### Added

- Conflict hotspots enter the learning loop. `reflect.ts hotspots <report.json>` in the [`reflect` skill](plugin/skills/reflect/README.md) reads the merge-conflict history report (`history.ts --json` of [`resolve-conflicts`](plugin/skills/resolve-conflicts/SKILL.md#hotspots-into-the-learning-loop)) and notes one reflection finding per hotspot: the path as its target, its most frequent cause (`append`, `tally`, `overlap`, …) as its class, and the report's remedy as its fix, with what the measurement could not see (skipped merges, the cause's hand-checked accuracy, the report's limits). It refuses a report whose values the history report could not have written, one whose totals, paths, hotspots or limits are not the ones its own merges give, or whose times carry no offset, and notes nothing from it. A cause that recurs across files therefore escalates to one tracker issue through `reflect`'s existing plan and `/jig:review-reflections`, with no second escalation path. Measuring again revises a finding the journal still holds rather than adding one, and adds nothing for a hotspot the store already records until its fix is implemented and a later range measures it again. With reflection off it says so and writes nothing.
- [M12](modules/M12-parallel-agent-ergonomics/README.md)'s merge-conflict practice says how measured hotspots reach the learning loop, and its audit criterion counts a hotspot's reflection finding as planned work once escalated or approved, and as a keep decision only once dismissed with a reason that keeps the cause on purpose and names when to revisit it.

## [0.90.0] - 2026-10-28

### Added

- The evidence record, `shared/evidence.ts` in the plugin: `run -- <command>` runs a check under a deadline and keeps one record of it on the machine, tied to the hash of the exact tree it ran against (tracked files with their staged and unstaged changes, and untracked files Git does not ignore), with its exit, the test counts per suite from the JUnit report it wrote in this run, and the first and last lines of its output. A tree that changed during the run, a report left by an earlier run, a report that is a symbolic link, a report that failed a case, a suite that ran no case and a run that hit its deadline are each recorded as what they are, never as a pass. `--expect-fail` records a test seen to fail, and a command ended by a signal is not one. `list` finds the newest record of each command that vouches for a tree. The records are readable by their owner alone, and the short block it prints names the command without its arguments and gives the report's counts without its suite or case names. Its settings are the new `verify` section ([CONFIGURATION.md](plugin/CONFIGURATION.md#verify)): `store`, `output_lines`, `timeout_minutes` and `retention_days`.

## [0.89.0] - 2026-10-28

### Added

- `do-item` now says what kind of work an item is when it picks it up: its
  [work type](GLOSSARY.md) (`bug`, `feature`, `improvement`, `task` or
  `spike`) and how it knows, in the status message, such as
  `Type: bug (label type:bug)`. The new `determine_type.ts` script derives it
  from the first of a type label, the tracker's own issue type (GitHub's
  issue types) and a Conventional Commits title prefix such as `fix:` where
  the repository's titles follow that convention; an item none of these
  identifies is `unknown`. Nothing else about the pickup changes in this
  version. See [do-item's README](plugin/skills/do-item/README.md#the-items-work-type).
- `issue_tracker.types` names a repository's work types and the labels that
  mark each (by default `bug` from `issue_tracker.labels.bug`, and
  `<type>` or `type:<type>` for the others), and `do_item.work_types`
  overrides single fields of the depth table: how much each delivery station
  does for each type, with `unknown` always taking the strictest value of
  every field. A type outside the default list needs a complete row. A
  label listed under two types is refused, and so is a label the GitHub
  adapter uses for a workflow state or a priority. Both fields are in the
  [configuration reference](plugin/CONFIGURATION.md#the-depth-table), and
  the audit's configuration check refuses what `do-item` refuses and reports
  a type's labels that the label taxonomy does not define.
- `get_issue.ts` prints the tracker's own issue type as `nativeType`: the
  GitHub issue type's name, or `null` when the issue has none and always on
  Linear, which has no issue types.

## [0.88.0] - 2026-10-28

### Changed

- `resolve-review-comments` runs with only `gates.command` configured.
  `review.bots` and `review.deferral_team` are optional: without
  `review.bots` every reviewer's threads are worked, as they already were
  whatever the list named, and without `review.deferral_team` a deferral
  names its team with `--team`. A repository with no `review` section no
  longer stops at the configuration step.

## [0.87.2] - 2026-10-27

### Fixed

- drive-pr and resolve-review-comments now read the severity in CodeRabbit's
  newer comment layout (`**<icon> Major** · **Category** · **Effort**`), which
  was reported as `unknown`. The new `icon-fields` shape is also available in
  `review.severity_formats`.

## [0.87.1] - 2026-10-27

### Changed

- `/jig:do-item` tells an agent in an Orca worktree not to run Orca's own
  Linear completion flow beside it, which would post a second comment and
  move the ticket twice.

## [0.87.0] - 2026-10-26

### Added

- `resolve-review-comments` and `drive-pr` now see the findings a static-analysis app reports as check-run annotations rather than review threads, as SonarQube Cloud's pull request decoration does. `list-scanner-annotations.ts` lists the warnings and failures on the head commit, and the round triages each as a finding. The apps read are `review.scanner_apps`, default `sonarqubecloud`. Annotations with the same text in one file, from any of the app's runs, are one finding that lists every place it is reported, and its fingerprint stays the same when an edit moves or removes one of those places, so a deferred finding keeps one backlog entry, which names it by file, title and message rather than by line.

## [0.86.0] - 2026-10-26

### Added

- The workspace launcher's configuration takes `defaults`: the settings every
  repository label starts from, `{label}` read as the label, so a machine
  that opens every repository the same way (one Orca server, say) needs an
  entry only for a label that differs from its repository
  ([tools/launcher](tools/launcher/README.md#configuration)).
- The Orca workspace tool clones a repository Orca does not have yet, adds
  it to Orca and opens it, once however many launches reach it at the same
  time, when given `--clone-url` and `--clone-root`; the launcher's Orca
  setting `clone: {url, root}` passes them
  ([tools/orca](tools/orca/README.md#a-repository-orca-does-not-have)).
- `do-item` shows its work on [Orca](https://www.onorca.dev)'s workspace
  board when it runs in an Orca worktree: the card moves to In progress at
  pickup, and to In review with the pull request linked once the pull
  request opens. Outside Orca nothing changes and no Orca call is made
  ([plugin/skills/do-item/scripts/orca-board.ts](plugin/skills/do-item/scripts/orca-board.ts)).

## [0.85.3] - 2026-10-26

### Fixed

- The tests of the plugin's conditional GitHub reads, of drive-pr's
  single-instance lock and of
  [M10](modules/M10-environments-deploy/README.md)'s external
  preconditions deadline no longer fail on a slow or loaded machine. The
  deadline tests give a request a budget no stall can use up and wait for
  the deadline to pass when it must; the lock tests wait for a drive's pass to
  start for as long as native Windows needs, and keep the pass running until
  the test has finished what it does while the pass is active; and the
  conditional-read tests start a throwaway child process first, because Bun's
  test runner can lose the events of the first child process a test file
  starts.

## [0.85.2] - 2026-10-26

### Added

- **Orca as a workspace runtime.** The [workspace launcher](tools/launcher/README.md)
  gains an `orca` provider: a tracker issue opens as an
  [Orca](https://www.onorca.dev) worktree, in Orca on this machine or on a
  paired Orca server, with the issue's branch named as the repository names
  it, the repository's create hook run once, and the agent started with its
  first prompt once per issue. The [Orca workspace tool](tools/orca/README.md)
  behind it also opens and removes such worktrees by hand, and says how to run
  Orca's headless server on a host.
- `reflect` records Orca as the session's wrapper when Orca started the
  harness (`ORCA_…` in the environment), as it does Herdr and Conductor.

## [0.85.1] - 2026-10-25

### Fixed

- On Windows, `jig gc` no longer fails every run with `EPERM` when it writes a
  collection receipt. Windows refuses to flush a directory, so there a
  receipt's directory entry is not flushed: a power loss just after a receipt
  is written or updated can lose that write.
- On Windows, a configured shell command (`code_stats.classify_command`,
  `resolve_conflicts` obligation commands, the changelog's `after_version`)
  reaches `cmd.exe` as written, so a quoted program path such as
  `"C:\Program Files\tool.exe" args` runs instead of failing as an unknown
  command.
- On Windows, a repository reached through an 8.3 short path (such as
  `C:\Users\RUNNER~1\…`) is recognized as the repository git reports: the
  migration-immutability and interface-surface gates, the deferral check's
  `--config` and `--states`, `/jig:reflect`'s journal check, `/jig:decide`'s
  other-repository clones and `resolve-conflicts`' `record.ts` no longer
  call a path inside it outside.
- `resolve-conflicts` treats a staged link to an absolute Windows path
  (`C:/…`) as leaving the repository, as it treats one to `/…`.
- On Windows, the audit's configuration fit reads a gate script's executable
  bit from the git index, so a shell script the index does not mark
  executable is suggested as `bash <path>`, as on other platforms, rather
  than as `./<path>`.
- The audit's label-taxonomy finding names the configured file with forward
  slashes on every platform, and the audit reads the taxonomy the way
  `/jig:file-issue` does, so a Windows network share path
  (`\\server\share\…`) is checked rather than reported unreadable.
- The audit's configuration fit reads a file a configured command names the
  way the platform resolves it: on POSIX it follows a link before a `..`,
  on Windows it collapses `..` first. It warns that a fresh clone lacks the
  file unless both the file it reaches and every link on the way, including
  a link inside another link's target, are tracked. On a case-insensitive
  file system, a command that spells a tracked file in another case
  (`scripts/CHECK.ts` for `scripts/check.ts`) counts as tracked, and a hard
  link of another name never stands in for the entry the command reaches.
  The tracked name is the one the file system itself reports for the entry
  its lookup reached, so any spelling it treats as the same name (final
  sigma `ς` for `σ`, for one) counts, and the audit never compares names by
  hand. A symbolic link with several names in one directory (hard links of
  the link itself) cannot be asked which name the lookup reached: it counts
  as tracked when every name is, and when only some are, the audit warns
  that it cannot tell whether a fresh clone holds the one reached.
- A relative `JIG_TRACE_FILE` now records the spans of the process that set
  it on Windows too.
- The design-brief renderer waits for Chromium's debugging endpoint while
  Windows still holds the file open, instead of failing with `EBUSY`.

## [0.85.0] - 2026-10-23

### Changed

- **Breaking.** `resolve-review-comments`' deferral batches are now looked up
  by a marker in the issue **description** — `<!-- defer-batch-key: repo=…
  pr=… type=… -->`, written as the description's first line — instead of by
  the issue title. The title becomes display-only, so a batch can be retitled
  to say what it actually contains; previously the title *was* the key, matched
  by exact equality with create-on-miss, so renaming a batch whose pull request
  could still run a round minted a duplicate. The key now carries the
  repository as well, so another consumer's pull request of the same number and
  Type no longer collides: the `repoVerdict` Repo-label triage that used to
  disambiguate them is gone, and the Repo label is reconciled like Type and
  Size instead — absent is repaired, a label contradicting the marker is
  refused rather than restamped.

  **What a consumer changes:** any batch issue that is still *live* — its pull
  request still open, so a later round will look it up — needs the marker added
  as the first line of its description, or that round files a second issue beside it.
  Batches on merged pull requests need nothing: no round will look them up
  again. Only the first line counts: a marker anywhere else in a description
  is ignored, so an issue that merely quotes one is never appended to. The marker is exactly
  `<!-- defer-batch-key: repo=<your repo label> pr=<number> type=<type> -->`,
  with the repository label and Type as they appear in
  `review.taxonomy.repos` / `.types`. Once added, stop editing that line:
  rewriting or deleting it makes the batch unfindable, and so does blanking the
  description.

  Repo and Type labels used in the key must now match
  `letters, digits, . _ : @ + / -` with no whitespace — a label that cannot be
  embedded in an HTML comment on one line is refused before anything is
  written, rather than producing a malformed key. Rename any such label in
  `review.taxonomy`. The audit's configuration check flags such a label in
  `review.repo_label`, `review.taxonomy.repos` or `review.taxonomy.types`.

## [0.84.0] - 2026-10-23

GitHub Issues is now the tracker the skills use when a repository does not choose one; Linear stays one setting away.

### Changed

- **Breaking:** `issue_tracker.adapter` defaults to `github` instead of `linear`. A repository that uses Linear and leaves the adapter out must add `adapter: linear` under `issue_tracker` in `.config/jig.yaml`; until then the skills refuse its configuration, naming the field, rather than reading `issue_tracker.team` and ignoring it. A repository on GitHub Issues needs no `issue_tracker` section at all: the tracker is the `origin` remote's repository, and the skills use the signed-in `gh` client.
- The audit's starter configuration offers `issue_tracker.adapter: linear` along with the team it finds in a repository's history (an empty `adapter:` counts as unset, and the draft says to replace that line rather than add a second), and its tracker-unreachable finding names GitHub when no adapter is set. The audit probes the tracker the skills select in every configured repository, the default one included (the repository's file merged with the machine's user file and `JIG__*` environment, as the skills read it, so configuration layers the skills refuse, an adapter included, are an error rather than an unchecked tracker, and the audit's user-file and environment facts say the tracker check reads them), by asking whether its team or repository answers rather than reading an issue, and derives a GitHub repository from the audited repository's `origin` remote rather than the working directory's; every other skill derives it from the repository it reads its configuration from (`JIG_CONSUMER_ROOT` when set).
- The review skill's deferral step still files through Linear only ([EXTENDING.md](plugin/EXTENDING.md#issue-tracker) lists what still assumes Linear), so deferring a review finding on the default tracker waits for the roadmap's item 10.

## [0.83.2] - 2026-10-23

### Added

- A toolchain-pin exception can name the `toml:`, `json:` or `yaml:` path
  of one pin site, and then excuses only the pin read through it, so a
  file's other pins holding the same value stay checked.

### Changed

- Jig tests with Bun 1.4.4, and the `changelog` skill's GitHub Action
  installs it. Bun 1.4.4's glob matcher reads `?(…)`, `*(…)`, `+(…)`,
  `@(…)` and `!(…)` as pattern groups and expands `{1..3}` as a range, so a
  glob in a repository's own configuration that `code-stats` or `changelog`
  reads (a module's or tool's paths, the changelog's files) and that holds a
  literal `(` or `{1..3}` in those forms now matches differently: escape the
  parenthesis as `[(]` and the range as `\{1..3\}` to keep matching them
  literally. Parentheses without one of those prefixes stay literal.

## [0.83.1] - 2026-10-23

### Fixed

- The scheduled `jig gc` job no longer stores the path of the plugin release that installed it, which a plugin update leaves behind. The job runs a small launcher that `jig gc install` keeps under `~/.local/state/jig/gc/launcher/`; at each run it asks `claude plugin list --json` (or `codex plugin list --json`) for the installed plugin and runs that copy, so an update reaches the job without reinstalling. Run `jig gc install --repo <repository> --yes` once to replace a job written by an earlier release.
- `jig gc install --uninstall` for one repository, while others remain, now changes only the machine entry and leaves the scheduled job as it is.
- A scheduled `jig gc` run that stalls is now stopped: the launcher ends the collector after the heavy-run lock's wait (`LOCK_TIMEOUT`, which install now carries into the job) and two hours more, and when the scheduler stops the launcher; a stopped run reports failure. An agent tool that does not answer the launcher's plugin lookup within 30 seconds, or prints more than 4 MiB, is killed with its process group and that lookup fails; the run fails only when no other recorded agent tool names an installed copy. An agent tool still answering when the scheduler stops the launcher is killed the same way, and the run fails. A descendant that starts its own session leaves the process group and is not stopped.

## [0.83.0] - 2026-10-22

### Added

- A resource collection command, `jig gc`, with report-first runs, durable receipts, confirmed repository bounds, daily scheduler installation and drive-pr state reports across configured clones. Tool-state collection awaits coordinated creator admission. Scratch scopes record captured owner identities and remain report-only until fixture registration is available; worktree reports retain a collection veto until the session opener coordinates with the collector.
- An M12 audit criterion for repositories to declare the machine-local resource kinds their tools create and their ownership boundaries.

## [0.82.0] - 2026-10-22

GitHub Issues is a supported issue tracker beside Linear: picking up, filing,
planning and reporting work on the issues of a repository, and keeping
session reflections there.

### Added

- A GitHub Issues tracker adapter: set `issue_tracker.adapter: github`, and
  `do-item`, `file-issue`, `work-batch`, `reflect`'s escalation and the
  fleet metrics work on the issues of the repository the `origin` remote
  points to (or `issue_tracker.github.repository`), through the signed-in
  `gh` command line. Issue keys are `#123`; a bare number or the issue's web
  address is read as the same key. An open issue's workflow state is a label
  per state, or with `issue_tracker.github.states_from: project` the option
  of a Projects board's Status field; a closed one is the reason it was
  closed. Priority is a label per level, a project is a milestone, children
  are sub-issues, and `blocks` and `duplicate` use GitHub's own dependency
  and duplicate links
  ([configuration](plugin/CONFIGURATION.md#issue_tracker),
  [how it maps](plugin/EXTENDING.md#issue-tracker)).
- A `github` reflection store: with `reflection.store: github` and
  `reflection.github.repository: owner/name`, session reflections are kept
  as issues of that repository, one per change, each finding a record in a
  comment; only comments by people who can write to the repository count
  ([the GitHub store](plugin/skills/reflect/README.md#github-store)).
- An [issue key](GLOSSARY.md) now has the shape its tracker gives it
  wherever the skills read or write one: in branch names (`123-fix-login`
  under the default `{key_lower}-{slug}`), commit and pull-request trailers
  (`Closes #123`), file names (`issue-123`), decision and explainer sheets,
  and the fleet metrics. The skills' procedures quote every key on a command
  line, since an unquoted `#` starts a shell comment.

### Changed

- The issue a branch names is read under the configured
  `pull_requests.branch_name` pattern, with one leading `<word>/` segment
  allowed before a team key, by both the drive's intent-chain handoff and
  `reflect`, including a pattern that puts the key after the slug
  (`{slug}-{key}`); the handoff previously recognised only
  `feature/<KEY>-…` branches, and `reflect` a team key anywhere in the name.
- `pull_requests.branch_name` refuses a pattern whose placeholders touch
  (`{slug}{key}`), that puts a digit beside the key (`{slug}1{key}`) or that
  uses `{slug}` twice: no branch rendered from it tells where the key begins
  and ends. A branch rendered from a title with no Latin letters or digits
  (an empty slug) is read back too.

## [0.81.2] - 2026-10-22

### Fixed

- Reduce process startup in the drive-pr test fixtures while preserving the
  fixture queries and responses used to check the driver on Windows.
- Keep exact state-directory identities in the triage fixture so Windows
  inode values cannot lose precision before the posting fence checks them.
- Name the remaining Windows fixture throughput limits for multi-round,
  long-CI drive and large post-retirement census tests; their
  existing deadlines remain in place while native optimization is pending.

## [0.81.1] - 2026-10-22

### Fixed

- The reaper's entry-count regression fixture creates and backdates files with
  bounded concurrency, reducing setup time on macOS while preserving coverage
  of the real warning threshold and the count after cleanup.

## [0.81.0] - 2026-10-22

### Added

- Shell-independent commands for pickup, pull request drives and their
  sibling skills, including PowerShell. File arguments replace shell pipes
  and redirections, and the review skill computes its file set and trusted
  policy snapshot in Bun.

### Changed

- **Breaking:** `fix-ci` setup commands run through Bun's native shell on
  every platform. Before upgrading, replace shell-specific setup syntax with
  a Bun script or commands that Bun's shell supports.

### Fixed

- Recovery commands preserve paths containing shell punctuation without
  requiring a Bash shell. A repository gate checks skill instructions for
  shell-dependent commands.
- File-output commands can explicitly save complete diagnostic reports from
  a finding exit status while preserving existing reports on runner failures,
  reported signal termination or truncated output. Explicit trace environment
  edits survive child execution.

## [0.80.0] - 2026-10-22

### Added

- [M11](modules/M11-process-observability/README.md) defines scheduled-failure
  triage with one issue per stable cause, recovery-based closure, and an
  announced per-cause flood breaker. GitHub Issues, Linear and Jira mappings
  explain adoption; new audit criteria check the lifecycle and breaker. The
  reusable reconciler remains future work.

## [0.79.1] - 2026-10-22

### Fixed

- Drive listings identify each drive's repository in human output and JSON rows, so identical pull request numbers across clones can be distinguished.

## [0.79.0] - 2026-10-22

### Added

- The [Herdr workspace tool](tools/herdr/README.md) opens a branch as a
  Herdr worktree workspace, on the machine or on a remote host over SSH, with
  its agent started and its first prompt sent once per piece of work.
  Opening the same work again reattaches instead of creating a second
  worktree, and does not prompt an agent that already has the work. `remove`
  runs the repository's remove hook and parks the worktree's reflection
  findings before removing it.
- The launcher's `herdr` provider opens a tracker issue through that tool;
  set `provider: herdr` and `repos.<label>.herdr` in the launcher
  configuration ([launcher](tools/launcher/README.md#providers)).
- [M12](modules/M12-parallel-agent-ergonomics/mappings.md)'s worktree
  lifecycle runs in Herdr: a repository's `.config/worktree-hooks/create` runs
  in each new worktree, through a Herdr plugin, before an agent starts there,
  and `.config/worktree-hooks/remove` runs before a worktree is removed.

### Changed

- The launcher takes the branch the tracker suggests, read with the issue,
  when the launch itself names none; the prompt's branch hint and the
  provider both use it.

### Fixed

- `/jig:reflect`'s journal gives each git call a minute and fails when one
  takes longer, instead of waiting on a stalled repository for ever or reading
  a stalled call as "no answer".

## [0.78.0] - 2026-10-22

### Added

- [M0](modules/M0-instruction-architecture/README.md#invariant) states new invariants. Instructions are portable: one that relies on a capability only some runtimes have (a slash command, a built-in tool, a tool the host injects, a permission rule) names its fallback, and a host-injected tool is never a dependency. Rules declare their scope: each standard names the artifact classes it governs, and standing review stances point to their one source instead of restating it.
- M0's [mappings](modules/M0-instruction-architecture/mappings.md#runtime-specific-capabilities-and-their-fallbacks) list each runtime-specific capability with its fallback per runtime: how to run a skill without its slash command, the order for asking the user, the deny-list formats of Claude Code and Codex with the command forms each cannot match, and tools the host injects.
- A [skill-invocation fallback lint](modules/M0-instruction-architecture/reference/skill-invocation-fallback/README.md), an M0 reference gate that fails a `/<skill>` with no fallback for that skill beside it.
- The AGENTS.md skeleton gains *Standards scope by artifact class* and *Standing review stances* sections.
- M0 audit criteria at Standard: `runtime-capabilities-name-fallbacks`, `deny-lists-per-runtime`, `standards-declare-scope` and `review-stances-are-pointers`; at Strict: `skill-invocation-fallback-gated`. A re-audit reports them as added by Jig.

### Changed

- `do-item`, `file-issue` and `work-batch` ask in plain text wherever `AskUserQuestion` cannot be used, a Claude Code permission mode that denies it included, and say what to do when nobody is there to answer a question: stop and state it. `do-item` names a fallback for delegating where the harness has no Task tool, and `fix-ci` for tracking errors where it has no task list.

## [0.77.0] - 2026-10-21

### Added

- [M11](modules/M11-process-observability/README.md) registers conflict
  events and merged-pull-request conflict share. The `drive-pr` scoreboard
  combines replay and clone-local resolutions, states its coverage and
  withholds a verdict when unknown pull requests could change it.
- [M12](modules/M12-parallel-agent-ergonomics/README.md) asks repositories
  to measure conflict hotspots and remove their causes or record a decision
  to keep them. The audit runs the replay as read-only evidence and scores
  whether the repository follows the practice.

## [0.76.0] - 2026-10-21

Documents that defer work to the tracker can no longer rot silently: M4 gains a static gate for deferrals that name no item and a scheduled check for deferrals whose items have closed.

### Added

- [M4](modules/M4-docs-governance/README.md) states a new practice, deferrals name live items: a document that defers work to the tracker ("tracked to closure", "a follow-up will be filed") names the item that carries it, and the item stays open. [`reference/deferral-references/`](plugin/skills/docs/scripts/deferral-references/README.md) is the gate. Its static half is offline and judges the lines a change adds (`--staged` for a hook, `--range` for a pull request), or every document with `--all`. A block of prose with a configured marker phrase and no item reference is a finding, a waiver needs a stated reason, and a configuration or range it cannot read is exit 2. Its live half (`--all --list-keys`, then `--all --states <file>`) takes the tracker's answers as a file, so the check never holds a credential: a deferral fails when none of the items it names is open, and an item with no recorded state fails the run instead of passing.
- [`templates/deferral-references.yaml`](modules/M4-docs-governance/templates/deferral-references.yaml) (item patterns, marker phrases, scope) and [`templates/deferral-liveness.yml`](modules/M4-docs-governance/templates/deferral-liveness.yml), a scheduled workflow that holds the tracker credential in one step, on the default branch only. The [mappings](modules/M4-docs-governance/mappings.md#deferral-references) give the hook, CI and per-tracker provider recipes.
- `tracker.ts issue-states` in the `do-item` skill reads item keys on standard input and prints each one's state as `open`, `closed` or `not_found` through the tracker interface; it is the provider the liveness check uses for Linear. A lookup that fails, or an issue the tracker reports without a state category or with one that is neither open nor closed, fails the command.
- The audit scores new M4 criteria: `deferrals-name-items` (Standard, mechanical) and `deferral-liveness-scheduled` (Strict, mechanical). Each is `expected-absent` for a repository whose documents defer no work to a tracker. A re-audit reports them as added since the prior audit, not as regressions.

## [0.75.0] - 2026-10-21

### Added

- Skill-authoring rules in [M0 § Skills](modules/M0-instruction-architecture/README.md#skills): a description leads with the trigger that sets the skill apart and carries its negative triggers, `SKILL.md` names every reference, a reference over 100 lines opens with a table of contents, instruction bodies carry no incident history or time-sensitive phrasing, and discovery controls do what they are for. [What each runtime offers](modules/M0-instruction-architecture/mappings.md#skill-discovery-controls) is in M0's mappings.
- M0's [skill-authoring check](modules/M0-instruction-architecture/reference/skill-authoring/README.md) counts the rules a script can see, per rule and per skill file, and prints them as a counter for the ratchet.
- The [ratchet gate](modules/M1-gates-enforcement-ladder/reference/ratchet/README.md) reads any counting command's JSON (`format: "json"`). With `per: "file"`, each file's count is its own ceiling. It runs the command with `RATCHET_HISTORICAL=1` when it measures the merge base, so a repository can add a counter and the files it counts in one change.
- Two M0 criteria for the audit: `skill-authoring-rules` (Standard) and `skill-authoring-ratcheted` (Strict). Both are expected-absent in a repository with no skills.

## [0.74.0] - 2026-10-21

### Fixed

- **Breaking:** `drive-pr` now preserves clone isolation under `DRIVE_PR_STATE_DIR`: the override names a root with one `<clone-key>/` subdirectory per clone. Same-numbered PRs in different repositories no longer share state, logs, leases or driver locks. Stop all participants before upgrading an existing flat override, establish each artifact's owner and explicitly relocate complete state into the appropriate clone directory as described in the skill's README. Unscoped legacy artifacts cause a refusal and remain untouched. Run state-using commands, including the reaper, in the owning Git clone; an override alone outside Git no longer identifies state.
- Directory identity checks tolerate device-number changes only with matching inode, nonzero directory birth time, canonical target path and a freshly confirmed macOS volume UUID. Snapshot and non-writable views supply no drift proof. Without volume proof, device comparison stays strict. Replaced directories and redirected targets still refuse. Older inherited identity tokens remain strict; re-arm an older driver to establish the stronger baseline.

## [0.73.0] - 2026-10-21

The delivery loop can now be published as one stage map, with a gate that
keeps every owner it names real.

### Added

- **A lifecycle map template** in M6, `templates/LIFECYCLE.md`: one table of
  the delivery loop's named stages (steer, spec, file, plan the epic, pick up,
  implement, pre-PR gates, draft and drive, review rounds, merge, post-merge,
  ops drain, epic close), each with the skill, command or document that owns
  it and the artifact it hands on. M0's `AGENTS.md` skeleton links it, so the
  stage that comes next is one hop from the instructions every session loads.
- **A lifecycle map gate** in M6, `reference/lifecycle-map/`, with a
  self-test: it fails a map whose owner is a skill, script, file or link that
  does not exist, a numbered, unowned or placeholder stage, an instruction file
  that does not link the map, and, with `--cover`, a skill that owns no stage
  and is not in the map's table of skills outside the loop. With
  `--scan` it fails any document that names a plugin skill that does not exist.
- **Audit criteria** for M6 (`lifecycle-map-published`,
  `lifecycle-owners-resolve-gated`, `lifecycle-skills-on-the-map`), scored
  in Jig's record and the calibration record.
- The skills table in the plugin README points to the lifecycle map for the
  order in which the skills are used.

## [0.72.0] - 2026-10-21

`resolve-conflicts` now keeps a record of the conflicts it resolves.

### Added

- `events.ts` in `resolve-conflicts` appends one `merge_conflict` event for
  each conflicted path to `$(git rev-parse --git-common-dir)/jig/conflict-events.jsonl`
  when a merge, rebase, cherry-pick or revert concludes: the path, why it
  conflicted, the decision and reason, how long the resolution took, and
  whether a `drive-pr` conflict-resolve round started it. It covers the
  rebases, cherry-picks and reverts that the merge-history report cannot
  replay, and the file is shared by every worktree of the clone and never
  committed. The skill's conclude step runs it, and mapping the next stop of a
  rebase records the earlier stop first; when that record cannot be written,
  the earlier stop's snapshot is kept and the next `events.ts` records it.
- The `Conflicts resolved:` section of a commit message names each path's
  cause (`[cause: append]`) after its decision.

## [0.71.0] - 2026-10-21

### Added

- M10 external-precondition registry, pluggable reference checks bounded by a deadline and a branch-protection checker with expiring waivers and bot-write checks. M11 defines one current issue per registry with automatic closure after recovery; the audit includes criteria for live checks and reconciliation.
- `resolve-review-comments` works the review threads GitHub opens for code
  scanning alerts, from CodeQL, SonarQube Cloud or any other tool that reports
  to GitHub code scanning. The thread listing attaches each thread's alert,
  whose severity and security category feed the decline ladder, and the new
  `dismiss-alert.ts` dismisses the alert when the finding is rejected,
  declined or deferred, so a resolved thread no longer leaves an open alert
  failing the tool's check
  ([code scanning alerts](plugin/skills/resolve-review-comments/README.md#code-scanning-alerts)).

### Fixed

- The changelog skill's release-access check no longer counts a `pull_request`-mode bypass of a `non_fast_forward` or `deletion` rule as freeing the release App: such a bypass admits merges only, so force pushes and deletion stay blocked for it.

## [0.70.2] - 2026-10-21

### Changed

- Consolidate shared command-line and GitHub helpers and fleet-health reporting internals; plugin commands keep their existing paths and behavior.

## [0.70.1] - 2026-10-20

### Added

- M1's reference ratchet can count source and test lines above a configured
  file-size limit, preventing total excess from growing while existing files
  are split. A scope that matches no file in the working tree is a
  configuration error rather than a pass; a merge base with no matching file
  yet counts zero excess.

### Changed

- The review driver's implementation and large test suites are split by
  responsibility, preserving the commands skills invoke from the plugin cache.

## [0.70.0] - 2026-10-20

### Added

- `design-brief-builder` owns returned design bundles: it stages a three-way merge against the recorded raw export, reports lost repository fixes, and checks every scenario before landing. Configure `design_brief.handback` with viewport widths, a Chrome or Chromium executable, rubric and scorecard paths, and any forbidden terms; each bundle supplies its scenario manifest, with a ready selector per scenario, the scorecard names the export base it reviewed, and delivered screenshots are non-interlaced PNG files. Brief data-facts tables are generated from source commands with their command and timestamp recorded.

## [0.69.0] - 2026-10-20

A decision sheet or an explainer sheet can now cite a fact of another
repository, and the freshness guard checks it against that repository.

### Added

- **Qualified citations.** `beta:ADR-0002` and `beta:apps/api/auth.ts#check`
  name a file or an ADR of the repository `beta`. Each is checked against a
  clone of `beta` at the commit recorded for it in the new
  `verifiedAt.repositories` of the sheet source (`{ "beta": "<commit>" }`). To
  use the form, a consumer configures the clone in `.config/jig.yaml` (or
  the user file, for a name the repository file leaves out) as
  `sheets.repositories: { beta: ../beta }`, a map from the name to the
  clone's folder.

  A qualified citation whose name has no recorded commit, or a malformed
  qualifier, makes the source invalid (`validate` and `render` exit `1`). One
  whose clone is not configured, not a git clone's top, or lacks the
  recorded commit fails `validate` (exit `1`) and `render --require-fresh`
  (exit `3`). Each names the missing piece instead of being skipped.

### Fixed

- A citation of another repository's ADR was only expressible as a bare
  `ADR-NNNN`, which the guard resolved in this repository: when both number
  their ADRs from `ADR-0001`, it checked the wrong file and reported the
  citation as checked. A bare `ADR-NNNN` still means this repository; cite
  the other one with its name.

## [0.68.0] - 2026-10-20

### Added

- Git Bash requirements and Windows validation limits for do-item and drive-pr, with explicit Bun script commands and native process-control guidance. PowerShell support and the complete Windows pickup, pull request, round and stop smoke remain pending.

### Fixed

- Windows process runners resolve executable extensions and launch batch shims with arguments preserved, allowing npm-installed agent commands to start. A bare command name is searched in the working directory before the executable search path, as native Windows spawning does, unless `NoDefaultCurrentDirectoryInExePath` is set; empty search-path entries never add the working directory back. Only executable and batch extensions are tried. Batch arguments containing line breaks or null bytes, and batch launches longer than cmd.exe's 8,191-character command line, measured after an npm wrapper expands its own variables, are refused; pass such content through a file or standard input.
- fix-ci runs setup commands under sh on Windows so POSIX shell syntax works with Git for Windows.

## [0.67.0] - 2026-10-20

### Added

- The `file-issue` skill (`/jig:file-issue`) files a tracker issue from the discussion, or plans an existing one (re-labels it, splits it into sub-issues, records its relations). It writes a durable issue body, derives the labels from the change-area catalog's tracker labels of the areas a diff touches directly (else from the description), searches for a duplicate, checks every label set against the repository's label taxonomy and asks before it writes, all through the tracker scripts ([README](plugin/skills/file-issue/README.md)).
- `validate-labels.ts` in the `file-issue` skill checks one issue's labels against the label taxonomy: an unknown label, no type or two, two labels of one group or none of a required group, and a facet without the label it requires are refused; `--check-tracker` also refuses a label the tracker lacks or has more than one of, matching names exactly as the tracker adapter does. A label is checked as it will be written: an empty one or one with whitespace around its name is refused, not trimmed.
- The label taxonomy schema gains optional `groups` (single-select families such as a size or a repository, optionally required) and `categories` (prefixed multi-select families, optionally open to any slug matching a pattern, with `max`, `recommended` and `requires`), and a flag may declare `requires_category`. [M9's template](modules/M9-tasks-memory/templates/label-taxonomy.yaml) shows one of each.
- The [tracker interface](GLOSSARY.md) gains creating, updating and searching issues, listing the labels an issue can carry, and reading and recording relations; the Linear adapter implements them, and `do-item`'s `tracker.ts` exposes them as `create`, `update`, `search`, `available-labels`, `relations` and `relate` ([EXTENDING.md](plugin/EXTENDING.md#issue-tracker)).
- `issue_tracker.taxonomy` names the label taxonomy (default `label-taxonomy.yaml`); the audit's configuration check reads the file it names, counts group and category labels as defined, and checks `issue_tracker.labels.batch_sizes` against the group labels alone.

### Changed

- **Breaking:** `resolve-conflicts` requires Git 2.41 or newer, up from 2.40: it reads attributes with `git --attr-source`. Upgrade Git before updating the plugin; with an older Git, `conflict-map.ts` and `check-resolution.ts` stop with an error naming the version.
- **Breaking** for a repository that runs M9's label-taxonomy lint from a Jig checkout: it moved from `modules/M9-tasks-memory/reference/label-taxonomy-lint/` to `plugin/skills/file-issue/scripts/check-label-taxonomy.ts` and no longer needs `lib/`; point the CI step at the new path ([mappings](modules/M9-tasks-memory/mappings.md)).
- **Breaking** for a label taxonomy whose entries carry a key the schema does not list (anything but `notes` beside the documented fields): the lint now refuses it, so a misspelt rule is never read as absent. Remove or rename the key. The lint also refuses a type, flag or group label that begins with a category's prefix.

### Fixed

- `resolve-conflicts` classifies the conflicted paths from what the commit will carry, not from the working tree: `conflict-map.ts` and `check-resolution.ts` read `.config/jig.yaml` (or the file `JIG_OVERLAY` names inside the repository) and the change-area catalog from the git index (following the symbolic links the index holds, with `/` the only path separator; a link whose target leaves the repository is refused, never read from disk) and every attribute (classification and the reconstruction of git's automatic merge) from the index's regular `.gitattributes` files alone (`git --attr-source`): `$GIT_DIR/info/attributes`, the file `core.attributesFile` names and the system's attributes file decide nothing either, and the automatic merge is reconstructed under no configuration but the repository's rename-detection settings, its renormalization (`merge.renormalize`, `core.autocrlf`) and `core.useReplaceRefs`, so a merge driver configured for the repository, the user, the system or the environment does not run, while everything else in the repository's git directory (its references, replace refs among them, `HEAD`, the index, `shallow`, `info/grafts` and its submodules' repositories) is still read, in a linked worktree too, so a submodule git fast-forwarded is not reported as a conflict, whether or not `.gitmodules` is in the working tree. The conflict-marker scan of staged changes reads every added line whatever an attribute says the file is, skipping only content git would call binary (a zero byte in its first 8000 bytes, counted as bytes). A path's marker size is taken from the markers git wrote into it when it is first mapped, so it holds after the attribute that set it is gone, and markers are also looked for at the size the index declares. An index link with an empty target cannot be read through. A filename that holds a literal backslash, a link retargeted only on disk, an untracked or ignored `.gitattributes` file, and a staged link named `.gitattributes` no longer let a resolution pass that the committed catalog or attributes would reject. A change to the configuration or the catalog takes effect once it is staged. `check-resolution.ts` no longer reports a declaration whose working tree differs from the index, since the working tree decides nothing. A relative `JIG_OVERLAY` is taken from the working directory, as every other configuration reader takes it, and a configured path that names a directory, or ends in `/` after a file, cannot be read. While `.config/jig.yaml` itself is unmerged, `conflict-map.ts` still records the conflicts and marks the map incomplete, so `check-resolution.ts` refuses until the file is staged and the conflicts are mapped again.

## [0.66.1] - 2026-10-19

### Fixed

- `drive-pr` and `do-item` retry Windows sharing violations during atomic state writes and lock moves, preserve directory lock fences on Windows, and identify worktrees by their canonical filesystem paths. Pickup records retain their no-symlink protection when Windows lacks Unix open flags, and unsupported state volumes report how to relocate `$DRIVE_PR_STATE_DIR`.
- Existing drives must finish held work and stop before the worktree identity upgrade. The `drive-pr` README documents clearing old leases with the old plugin before upgrading participants together.

## [0.66.0] - 2026-10-19

### Added

- `resolve-conflicts` reports where a repository's merges conflicted, and
  why: `bun <skill-dir>/scripts/history.ts` replays every merge commit of the
  last 30 days (`--days`, `--since`/`--until` or `--all` for another range)
  with `git merge-tree`, which changes nothing in the repository, and lists
  the conflicted paths most often first, each with a cause (a lockfile, a
  release version, a count, a list every change adds to, two changes to the
  same lines, …) and the change that removes it. It also names the
  [conflict hotspots](GLOSSARY.md), shows each week's conflicted merges by
  cause so the effect of a fix shows, reads the decisions earlier
  resolutions recorded in their `Conflicts resolved:` sections, and says how
  often each cause was right when a sample was checked by hand. `--json`
  prints it as a versioned `merge-conflicts/v1` object. It reads git only, never fetches, and keeps today's attributes out of the past
  merges, running none of the repository's merge drivers or filters; it needs git 2.43 or later (2.45 in a
  partial clone), and in a shallow clone it skips the merges whose history
  the clone cuts and says the report is partial. See the skill's
  [history report section](plugin/skills/resolve-conflicts/SKILL.md#where-past-merges-conflicted-the-history-report).
- `resolve_conflicts.hotspot_min_merges` in `.config/jig.yaml`: how many
  merges in the report's range a path must conflict in to count as a
  hotspot (3 by default).

## [0.65.1] - 2026-10-19

### Changed

- The Windows support table in EXTENDING.md no longer lists finding and stopping a pass's processes as missing: `drive-pr` does that on Windows now, and state, locks and the skills' instructions under Git Bash remain.

## [0.65.0] - 2026-10-19

### Added

- `decide`: a document decision sheet lets the reader write a note on each
  pick in the My picks tray. The note belongs to that option, shows under its
  pick line in the copy text, and is kept in the browser with the pick.

## [0.64.0] - 2026-10-19

### Added

- `resolve-conflicts` reads the `generated:` entries of the change-area catalog (`drive.change_areas_catalog`): a conflicted path listed in an entry's `outputs` is mapped as a generated file and regenerated with that entry's `command`, so a generator declared in the catalog is not copied into `resolve_conflicts.generated`. A path is classified by `resolve_conflicts.generated` first, then the catalog, then the built-in lockfile table. Catalog `outputs` are literal file paths, matched exactly. A catalog entry with no `command`, one whose `outputs` are not literal file paths, and a catalog that cannot be read are reported as warnings by `conflict-map.ts` instead of being skipped; in the last two cases `check-resolution.ts` refuses until the map runs again and reads every entry. Running `conflict-map.ts` again classifies every mapped path afresh, a staged one included, and clears a recorded decision whose path's class or regeneration command has changed. `check-resolution.ts` classifies every mapped path again from the configuration and catalog as they stand when it runs, and refuses a path whose class or regeneration command differs from the map's until the map runs again. It also refuses while the configuration, the catalog (or any symbolic link, file or directory, that reading either passes through, or the file it finally reads) or a `.gitattributes` file differs between the working tree and the index, whatever its assume-unchanged or skip-worktree flag and whether or not it is ignored, since the commit carries what is staged; after obligation commands run, it reads the catalog again. A path keeps the conflict-marker size it was first mapped with for the whole operation, and the check also looks for markers of the size its attribute gives at check time. The snapshot's `regenerate.source` can now be `catalog`, and the snapshot records `catalogIncomplete`.

### Fixed

- Drive cancellation, foreground command deadlines, and process diagnostics use native Windows process snapshots. `drives.ts --stop` requests an orderly shutdown on Windows, and claims distinguish operating systems sharing a worktree.
- Foreground waits report failure when the process tree cannot be confirmed stopped, preserving the command's exit status and preventing a new launch from discarding unresolved work.
- Foreground supervisors establish ownership before executing commands, and cooperative stops preserve generation-bound completion proof through registry cleanup.
- A foreground wait no longer reports a finished launch as still running, and a new launch is no longer refused, when Windows has reused one of the finished launch's process numbers.

## [0.63.0] - 2026-10-19

### Added

- **Release channels for the plugin.** Machines now install `jig` from a
  channel: `stable`, which receives a version once it has spent 72 hours on
  `latest` with its gates green and no open regression, or `latest`, which
  receives every version once it is tagged. Install with
  `claude plugin install jig --marketplace https://github.com/jig-harness/jig.git#stable`
  or `codex plugin marketplace add https://github.com/jig-harness/jig.git --ref stable`;
  `bun tools/plugin/setup.ts` follows `stable` on a fresh machine and takes
  `--channel latest|stable`. A channel holds the plugin without its tests
  and development notes, so the install is smaller. A machine added without
  a ref, or at `#main`, still follows `main`, which receives each version before its gates
  pass; to move it to a channel, remove the marketplace and add it again at
  the channel, as
  [Release channels](plugin/README.md#release-channels) shows. The plugin's
  id stays `jig@jig`, so repositories need no change.

## [0.62.0] - 2026-10-19

### Added

- Conflict resolution accepts repository obligations over the whole resolved
  diff, including automatically merged files and hunks, with optional
  validation commands. Each command runs only while every tracked file on
  disk matches the staged tree, including submodules and files Git is told
  not to compare, and a command that changes either stops the commands after
  it and invalidates the run.

### Changed

- **Breaking:** Conflict resolution requires Git 2.40 or newer to reconstruct
  the automatic merge result. Upgrade Git before using the skill. Picking or
  reverting a merge commit with `-m` requires manual resolution and validation
  because Git does not reliably retain the selected parent.

### Fixed

- Conflict resolution rejects staged paths outside the operation and manual
  changes without recorded decisions, so unrelated staged work cannot ride
  into its commit.

## [0.61.1] - 2026-10-18

### Changed

- The `drive-pr` and `do-item` test suites now run on Windows in the nightly
  workflow, the `drive-pr` suite as its own sharded job and `do-item` inside
  the gate set. The tests that need work the skills do not have yet (finding
  and stopping a pass's processes without `ps` and POSIX signals, state and
  locks for Windows file systems, the skills under Git Bash) skip on Windows
  and name the piece of work that lifts each skip. Neither skill's behaviour
  changes.

## [0.61.0] - 2026-10-18

### Added

- Any code reviewer's finding severities can be read now, not only the ones
  Jig knows. `review.severity_formats` in `.config/jig.yaml` describes a
  reviewer by login: the shape of its severity field (`bold-token`, `badge`,
  `html-badge` or `pipe-fields`) and how its words map to Jig's `blocker`, `high`,
  `medium` and `low`. The decline ladder of `resolve-review-comments` then
  works on that reviewer's findings. CodeRabbit, the Codex connector and
  Jig's own finding format are still built in, and Greptile's `P0`–`P2`
  badges now are too
  ([severity formats](plugin/EXTENDING.md#severity-formats)). The
  bullets of a reviewer's summary comment are read with the formats of the
  login that posted it, Jig's own format among them.
- The audit's configuration check reports a `review.severity_formats` entry
  the review skills would refuse: an unknown shape, a word mapped to
  something other than Jig's severities, an empty or duplicated word list.

### Changed

- A severity is read only from comments posted by the login its format
  belongs to. Before, a bold severity word (`**high**`) or a `P0`–`P3` badge
  was read from any author. **Breaking** for a repository whose reviewer
  writes a bold severity word but is not its configured reviewer
  (`review.reviewer_app`, else `review.bots`), or writes badges under a
  login other than the Codex connector's: that reviewer's findings now read
  `unknown`, which leaves the ladder inert for them where `severity` is
  listed under `fail_open.inert_when_unknown`. Add an entry for the
  reviewer to `review.severity_formats`. The loop-metrics warning for a
  reviewer whose findings all read `unknown` now says so and names that
  field.

## [0.60.0] - 2026-10-18

Jig prepares to publish: the documents a public project needs, the
address of the `jig-harness` organization the repository moves to, and CI
on the runners a public repository gets.

### Added

- [GOVERNANCE.md](GOVERNANCE.md): one maintainer decides, what stays with
  a person, how a contribution gets in, and that the licence will not
  change. [SECURITY.md](SECURITY.md): how to report a vulnerability
  privately, and what the skills run with your credentials.
  [TRADEMARK.md](TRADEMARK.md): what anyone may do with the name and the
  logo. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Issue and pull request
  templates.
- [ADR-0006](docs/adr/ADR-0006-home-copyright-and-brand-held-apart.md):
  the repository's home, the copyright holder, the holder of the name, and
  what happens to each if its holder can no longer carry it.
- [CONTRIBUTING.md § Outside contributions](CONTRIBUTING.md#outside-contributions)
  says which contributions are welcome as a pull request, which need an
  issue first, which are not taken, and how a fork's pull request is run
  and reviewed.

### Changed

- The project's full name is Jig Harness; the documents say Jig for short.
  The plugin's name and id do not change.
- **Breaking:** every address in the documents, the manifests and the
  install commands is `https://github.com/jig-harness/jig`. Once the
  repository is there, re-add the marketplace at the new address
  ([plugin/README.md § Install](plugin/README.md#install-the-plugin));
  the plugin's name and id (`jig@jig`) do not change, and installing no
  longer needs a GitHub login.
- NOTICE names the licensor, and the origin-reference gate reads the
  licensor's name from NOTICE and allows it only where the pattern file
  says.
- CI runs on GitHub-hosted runners, which a public repository gets without
  charge; the nightly macOS and Windows runs use the standard images.
- [ADR-0003](docs/adr/ADR-0003-a-person-merges.md) is amended: a person
  merging is also the supply-chain control of a public `main`.

## [0.59.0] - 2026-10-18

### Added

- [M16 Releases & versions](modules/M16-releases-versions/README.md), a
  module for software released in versions for others to install, embed or
  consume, as [M10](modules/M10-environments-deploy/README.md) is for a
  deployed service. Each released artifact gets one changelog, written for the
  people who use it, so changes only the maintainers notice (CI, the
  repository's own tooling, its website) stay out of it. A repository that
  releases several artifacts keeps a changelog and a version for each. The
  version is chosen once, after the merge, by one release run at a time. A
  version is tagged only on its releasing commit once that commit's checks
  pass, and the release identity gets only the access it needs. The module's
  [mappings](modules/M16-releases-versions/mappings.md) cover Changesets,
  release-please, semantic-release, towncrier, scriv, changie, Nx Release and
  release-plz, with tools for several artifacts in one repository.
- M16's audit criteria. Every one is expected-absent for a repository
  that releases no versioned artifact. Team/Standard targets M16 Lite and
  Regulated/Strict targets M16 Standard, each only where the team says the
  repository releases versioned software.
- Glossary terms *released artifact* and *semantic versioning*.

### Changed

- `/jig:changelog` tells the agent more plainly when a change needs a note:
  only when someone who uses the released artifact would notice it. A
  refactor, a CI tweak, the repository's own scripts and instructions,
  internal design documents and a project website get none, unless the
  branch check asks for one or the repository's own written rule says
  otherwise.
- The changelog skill's branch check lets a branch correct or remove an entry
  already under Unreleased, such as a link the branch's own change broke, and
  names the lines it changes, removes or adds for the reviewer. Adding a
  line or a section there is still refused, whatever the line is: a list
  item, a paragraph, a quote or a line of code. A corrected line stays where
  it was, under the same heading and with the same indentation and marker, so
  an entry moved to another section, a continuation line turned into an entry
  or a line rewrapped onto two is refused. A heading added again, or moved to
  another depth, counts as a new section.
- M10's note on libraries now points at M16. M12 keeps the part of change
  notes that is about parallel work, and its change-note tool table moved to
  M16.

## [0.58.1] - 2026-10-18

### Changed

- The [`resolve-review-comments`](plugin/skills/resolve-review-comments/README.md#outcomes) page now has a table of the review outcomes: when each applies, whether code changes, when the thread resolves, what it leaves behind and what it says about the reviewer, and how the outcomes feed planning, reviewer scoring and the learning loop. [FACTORY.md](FACTORY.md), [M7](modules/M7-pr-lifecycle-review/README.md) and [M8](modules/M8-learning-loop/README.md) name every outcome and link the table.

## [0.58.0] - 2026-10-18

### Added

- The `changelog` skill runs in CI: a GitHub Action
  (`plugin/skills/changelog`, with `command: check`, `release` or `tag`) and
  a workflow template, `templates/github/changelog.yml`, that checks every
  pull request, releases on every push to the integration branch and tags
  each version. The release either pushes straight onto the integration
  branch as a GitHub App the branch's rules let past (`changelog.release.push:
  direct`) or opens a release pull request a person merges (`pull-request`).
  The release step and `after_version` run in a job that holds no key; the
  job that pushes runs nothing from the repository. The action starts Bun
  outside the checkout, so a repository's `bunfig.toml`, `.env` or
  `tsconfig.json` cannot change what it runs.
- Versions are tagged only once the commit that released them has passed its
  required checks. `tag.ts` prints which versions can be tagged now, re-runs a
  cancelled check once with `--rerun`, and leaves a commit whose checks failed
  untagged. Only versions newer than the newest release tag on `origin` are
  owed a tag (with none, only the newest), so an untagged history is never
  tagged on adoption; `status.ts` now lists the versions still waiting for their tag and
  exits 1 for a failed one.
- `release-access.ts` checks that the release App can reach the integration
  branch in the configured mode while force pushes and deletion stay blocked
  for it, reading every ruleset and the classic branch protection together.
- `/jig:changelog setup` walks a person through turning the skill on, one
  checked step at a time: the configuration and the changelog (from a new
  Keep a Changelog or Common Changelog template), the GitHub App from a
  prefilled App manifest, its environment, the branch rules, the workflow and
  the conversion of open pull requests. It changes no setting itself.
- The branch check passes a release pull request when re-running the release
  step on its merge base gives exactly its change; `check.ts --head-ref`
  names its branch where the checkout does not.

### Changed

- `ci.required_checks` also sets the checks a releasing commit must pass
  before its tag, read from the integration branch's own `.config/jig.yaml`.
  Name only checks that run on the integration branch.
- `status.ts` reads the last release run of the workflow named `release` or
  `changelog` (the template's name), and counts only its push and manual runs,
  so a tag or branch-check run of the same workflow cannot hide a failed
  release.
- `release.ts --json` also prints the changelog's path and the
  `changelog.release` settings.
- Jig's own releases run on the skill's action, and a release is tagged once
  `gates` passes on its release commit rather than in the push that made it.

## [0.57.0] - 2026-10-18

Several small issues from one area of the code can now be closed in one pull request, from the plugin.

### Added

- `/jig:work-batch` ([plugin/skills/work-batch/](plugin/skills/work-batch/README.md)) groups several small, independent issues from one area of the code into one pull request, one commit per issue, and drives it once. Its proposal takes an area, a path, an epic or one issue as the anchor, reads the open issues through the tracker interface, holds back every issue that may not join (solo-only flags, an area the catalog flags, an urgent priority, truncated labels, missing size, type, repository or context labels, a state it cannot read, ownership), ranks the rest and fills a point budget and an item limit. It claims the batch, trims it when it outgrows its budget, opens the pull request under `do-item`'s pull-request policy and arms `drive-pr`. After the merge it closes out every issue the batch closed, moves each parent epic forward and records the batch's close/open ratio.
- The solo-only flags are derived from the repository's configuration: `issue_tracker.labels.hitl` and its facets, `issue_tracker.labels.manual_ops`, and every flag in the change-area catalog. `work_batch.solo_flags` adds to them; no setting removes one.
- `candidates.ts --eligibility` reads issues on standard input, reads no tracker, and prints one versioned JSON document: the effective policy and each issue's verdict, decided by the same rules the proposal uses. A dashboard or a planning view asks it instead of keeping its own copy of the rules; the format is in the skill's SKILL.md.
- A `work_batch` section in `.config/jig.yaml` (`point_budget`, `size_points`, `max_items`, `solo_flags`, `sizes`, `ranking`), documented in [CONFIGURATION.md](plugin/CONFIGURATION.md#work_batch). A repository whose `issue_tracker.labels.batch_sizes` differ from `xs`, `small`, `medium` sets `work_batch.size_points` for its own sizes; `work_batch.sizes` (every size label) turns on the report of issues with no size label.
- `do-item`'s `intent-chain.ts --clear-session` removes the current session's intent-chain copy, so Refocus stops putting work in front of an agent that gave it up.
- The audit's configuration check knows the `work_batch` section and reports `work_batch.size_points` that do not price exactly `issue_tracker.labels.batch_sizes`.

### Changed

- `do-item`'s batch check runs `/jig:work-batch`'s proposal for a small issue and suggests the batch it finds, instead of asking for a batching skill of the repository's own. It still never batches silently.

## [0.56.1] - 2026-10-18

### Added

- The plugin guide opens with [Set up from an agent session](plugin/README.md#set-up-from-an-agent-session):
  a prompt to paste into Claude Code or Codex in the repository you want
  to adopt Jig in. The agent checks whether the plugin is installed and runs
  the first audit if it is; otherwise it checks the requirements, gives you
  the install command to run, and stops.
- Website: a getting-started page at `/adopt/` hands the setup to your agent,
  or walks you from nothing installed to a first audit, then to the guide
  for your repository. The home page links to it, and the root `llms.txt`
  lists it first, under "Start here".

### Changed

- Website: everything about adopting Jig is one section under **Adopt**,
  with a switch between its pages. The existing-repository guide moved to
  `/adopt/existing/`, and the plugin's pages moved from `/plugin/` to
  `/adopt/plugin/`, `/adopt/configuration/` and `/adopt/extending/`. The
  "Install" navigation item is gone, and `/plugin/llms.txt` is merged into
  `/adopt/llms.txt`.

## [0.56.0] - 2026-10-18

### Added

- A finding's `kind` can be `unhelpful-content`: instruction text that cost
  context without helping. `/jig:reflect` accepts it and the stores keep it
  like the other kinds. **Breaking**: a machine on an earlier plugin version
  cannot read a shared store once it holds such a finding, so update every
  machine that shares a store first.
- The reflection store conformance suite checks that `list` is exhaustive: it
  appends a bulk of events (250 by default, `--bulk` to change it) under a
  change each and as many again under one change, with every kind of finding,
  and requires every event the store holds back, with and without a `since`,
  once and byte for byte. A store whose listing is capped or paged below the
  bulk now fails the suite.

### Changed

- `/jig:reflect` tells the agent that the classes it names a finding from are
  the store's complete list after a successful read, so a class missing from
  it does not exist.
- The [reflection stores design](design/reflection.md) states what every
  store holds to: an exhaustive `list` and the kinds of finding.

## [0.55.0] - 2026-10-18

The audit records the profile a team chose, keeps a first narrowed re-audit
readable, and reads more of a repository's deploy and gate setup.

### Added

- `score.ts --draft --profile <id> --declare` records the profile, with
  `--conditions` and `--heading-to`, as the team's declared choice, so a
  profile the person already chose is no longer set by hand in the record.
- Report source drift entries take `status: "applied"` and `applied_in`, as
  recommendations do: drift fixed in the same run shows on the
  [audit sheet](plugin/skills/audit/references/report-sheet.md) as fixed.
- Configuration fit names an alternative profile in two more cases: the
  suggested profile when the record declares another, and Regulated/Strict
  when compliance documents sit beside Team/Standard.
- Deploy signals come from tracked files as well as CI: systemd service and
  timer units, a top-level deploy or infrastructure directory, a Procfile, a
  hosting platform's configuration, and workflows that run on a release or a
  pushed tag. Tests and their data, templates and vendored copies are left
  out, and a unit, Procfile or platform configuration that cannot be read is
  named as unchecked.
- `gates.command` suggestions find a gate script (`scripts/gates.sh` and
  similar names), preferring one that a CI command runs. When every CI run
  of it is one command a configuration can repeat, interpreter and
  arguments included, that is the suggestion; otherwise the suggestion names
  how CI runs it for a person to settle. An environment the workflow, job or
  step sets leaves the command to settle, and a `run` block with a
  here-document or a `cd`, or one that only mentions either, shows no run
  at all.
- The comparison of `gates.command` with CI names, as unchecked, the jobs
  whose `run` steps it does not read (a compound command, a here-document,
  a change of folder, another folder or shell), instead of passing over them.

### Changed

- With a profile, the sheet's headline counts the criteria within the
  target; criteria scored beyond it are counted on their own line, and
  criteria within it that the record left unexamined are counted as not
  judged.
- `record.ts compare` against a prior record that examined every criterion
  counts the criteria a narrower profile leaves unexamined in one line
  instead of listing each; the draft keeps their prior scores as comments.
- `do-item`'s `pr-plan.ts` leaves `.config/jig-audit.yaml` out of a pull
  request's size and says so.
- `M2/hand-editing-forbidden` accepts an inventory entry saying a file is
  not edited by hand where its format cannot carry a header. A practice
  that covers part of its scope scores its weakest part, as the
  [criteria README](plugin/skills/audit/criteria/README.md) now shows with
  an example.
- The audit skill saves the prior record before step 6 overwrites it,
  leaves paths a repository's CODEOWNERS or protected-path inventory guards
  to a person in unattended runs, makes worktrees under the real path, and
  reads the prior record and the history before it at the audited commit. The snapshot `--at` makes is
  under its real path.

### Fixed

- `record.ts check` no longer reports as missing paths code identifiers,
  the audit's own scratch files, files the evidence proposes or says are
  missing, slash-joined alternatives, and the plugin's own scripts where
  every citation calls them the plugin's or Jig's. File names in capitals
  (`README.MD`) are still checked, and `add` or `create` passes over only
  the paths it proposes, a list joined by commas, `and` or `or` included.
- The sheet's alternative-profile line tells modules short on examined
  criteria from those it cannot judge because their criteria were not
  examined.
- An unprotected branch is reported as unprotected, apart from a protected
  one that requires no checks.
- The unnamed-reviewer warning says whether the default reviewer check
  pattern matches the check it saw;
  [CONFIGURATION.md](plugin/CONFIGURATION.md) says the pattern matches
  without regard to case.
- Counts on the sheet agree in number ("1 quick win").

## [0.54.0] - 2026-10-18

### Added

- `/jig:changelog` can convert a branch that edited the changelog or the version itself into one with a change note. `convert.ts` moves the branch's entries into a note, puts back the integration branch's open sections and version, sets a version placeholder the branch filled back to its text, and leaves the result uncommitted for review. A branch stacked on another converts against that branch with `--base`.
- `do-item` writes the change note before it opens the pull request and runs the branch check with the other gates; `drive-pr` and `resolve-review-comments` update the note in the round whose accepted fix changes what it says; `resolve-conflicts` converts a branch's changelog edits into a note before merging, so they cannot conflict. Each asks the changelog skill first, reading the configuration the integration branch holds rather than the branch's own, so a repository that did not set `changelog.file` is never asked for a note and a branch that predates its adoption still is.

### Changed

- A change note's file name keeps at most the first 64 characters of the branch's name before its eight digits, so a long branch name stays within what a file system allows.

### Fixed

- `/jig:changelog`'s status report answers with a release run still going before a newer one that ended, and reads only the release workflow's own runs, so other workflows' runs can no longer hide a release in progress. Its runs are listed back to the point past which none can still be going, split by when each was created rather than by its status, so newer runs that ended cannot hide one and a run whose status changes between listings is still seen; a listing `gh` may have cut short at its limit reads as unknown rather than as an answer.

## [0.53.0] - 2026-10-18

### Added

- The [`change-areas` skill](plugin/skills/change-areas/README.md)
  (`/jig:change-areas`) resolves a change against the repository's
  change-area catalog (`drive.change_areas_catalog`): which areas it
  touches, and what it owes — the checks to run before a push, the mandatory
  reviews, the tracker labels and flags, the steps after a deploy. It prints
  JSON with the validation plan that `drive.validation_plan_command`
  expects, GitHub Actions outputs (`<area>=` for the closure, `<area>-seed=`
  for the direct match), a dorny/paths-filter spec, a post-deploy checklist
  and a review-gate table, and checks the catalog: its schema, the
  `impliedBy` graph, the workspaces and each generator's outputs and
  sources. A push resolves every commit it carried (the event's `before`,
  or `--before`), `--files -z` reads paths separated by null bytes, and a git command
  has a deadline. A repository whose catalog needs more than the generic schema
  runs it through a [composer](GLOSSARY.md), its own short script that
  adds its fields, outputs and validation policy.
- `review` resolves the catalog with the `change-areas` resolver when the
  repository declares a catalog but no `drive.validation_plan_command`
  (`--no-validation`, so a catalog without validation profiles still routes
  its reviews), and reports any resolver failure, an unknown field included,
  as a blocking catalog finding.

### Changed

- [M3](modules/M3-change-area-catalog/README.md) states the corrected
  design the resolver implements. Tracker flags are read from the seed
  areas, like tracker labels; mandatory reviews (`review.skills`) are read
  from the closure. A change to a generator's `generated[].source` seeds its
  owning area for every projection, not only the freshness check.
  Validation profiles are declared in the catalog under `profiles:`,
  shallowest first, and an area without one, like a file no area matches,
  gets the deepest, which must list at least one check. Every file of a
  workspace is matched by its own area's paths, not some other area's; a
  workspace with no files yet is covered when one of those paths could
  match a plainly named file in it (letters, digits, `_`, `-` and `.`,
  neither starting nor ending with `.`, and no Windows device name such as
  `CON`), and a workspace is written as git lists paths
  (`apps/web`).
  Closed value lists for `category`, `deployTier`,
  `agent`, tracker flags, post-deploy environments and profiles are declared
  under `vocabularies:`; without one a field takes any text.
- **Breaking:** the catalog field `validation.needsSandbox` is removed. A
  catalog that declares it fails the `change-areas` schema check: remove
  the field, or, where agents must run some changes on a CI-identical remote
  machine, declare the field in the repository's composer and compute that
  requirement in its validation plan, from the seeds' closure.

## [0.52.1] - 2026-10-17

### Changed

- Jig names its creator, Ophir Radnitz: the copyright line in `NOTICE` and
  `LICENSE-MIT-0`, the plugin's author in its Claude Code and Codex
  manifests, and a "Created by" line in the website's footer.

## [0.52.0] - 2026-10-17

M7 now covers what happens after the merge.

### Added

- M7's lifecycle template gains a post-merge stage, "what does the merge still
  owe?": after every merge, each class of residual obligation (the tracker
  state, deferred findings, out-of-tree actions, temporary scaffolding, live
  verification and the next step) is settled as owed, and filed or done, or as
  not owed, with the evidence that settled it. A deferred reply is checked
  against the tracker, since the unresolved-threads gate can see that a reply
  names a reference but not that the item behind it exists. The next step is
  picked with a bias toward closure.
- Both human-in-the-loop registry templates (M7's and M0's) gain two rows:
  picking the next item from the computed ranking, and reopening on a
  rejecting verdict or waiving a missing acceptance review, which needs an
  approver other than whoever runs the sweep.
- A criterion in the audit's M7 file, `post-merge-obligations-settled`, at the
  Standard level. A repository that has the practice scores it from its
  lifecycle document and its recent merges; one that does not gains a
  recommendation.

## [0.51.1] - 2026-10-17

### Changed

- A template or a gate that a skill uses now lives in that skill, not in the
  module it came from: the module contract no longer requires `templates/` and
  `reference/` in every module, and the licence gate lists templates under
  `plugin/skills/*/templates/` in `NOTICE` like those under `modules/`. Nothing
  moves yet; the `kickoff` and `docs` skills bring their assets in when they
  arrive.

## [0.51.0] - 2026-10-17

The audit costs what the profile asks for, runs unattended, and splits its
scoring across agents with tools to put the parts together.

### Added

- `score.ts --draft --profile <id>` leaves the criteria beyond that profile's
  target *not examined*: a new score that meets no bar, is never a gap, and
  shows on the [audit sheet](plugin/skills/audit/references/report-sheet.md)
  as not examined. On a re-audit the prior record's profile is the default;
  `--examine-all` scores everything; a `--profile` other than the prior
  record's adds its targets to the declared profile's. `--at <rev>` scores a
  commit from a temporary worktree while the checkout has changes, and keeps
  it for the surveys to read until the record is done.
- `record.ts fill` writes answers (`M1/<id>: <score> | <evidence>`, or JSON)
  into a draft, and `record.ts merge` combines copies of a draft that several
  agents scored; both refuse unknown criteria, a probe's score changed, and
  answers that disagree. The survey prompts return their modules' answers in
  that form, read step 1's host facts instead of querying the host again,
  and leave drift to one pass.
- `record.ts summary --profile <id>` and `report.ts validate|render --profile
  <id>` show a record under another profile without changing it.
- The report source gains `left_on_purpose` (gaps the auditor chose to
  leave, with the reason), a recommendation's `status: "applied"` with
  `applied_in` (shown as done, asking no decision) and `needs: "host-admin"`.
  The sheet shows the other profile the facts could support near a
  boundary, with how many modules would be at target under it.
- Configuration fit reports a checkout behind its integration branch, a
  leftover `groundwork` overlay or references to the old plugin, `.context/`
  not ignored, an `issue_tracker.file_command` that resolves nowhere, a
  `gates.command` that runs less than CI, a gate tool an agent would need
  permission for, and an AI reviewer posting without being named in
  `review.reviewer_app` (or named and never posting).
- `record.ts check` warns of evidence naming a path or line the audited
  commit does not have.
- The audit skill says what to do unattended: never block on a question, and
  apply, without the team's decisions, only drift fixes and written rules.
  It names a private scratch folder per audit (`mktemp -d`, or one under `.context/jig-audit/`).
- New criterion `M0/instruction-file-stays-small`, split from
  `M0/universal-instruction-file`, which now asks only that the file exists
  and is vendor-neutral. Many more criteria carry probes, and probe lists
  cover more CI providers, hook managers and dependency updaters. A probe
  can cap a criterion's rung instead of ruling it out (`mechanical: <probe>`):
  without CI, a check run only locally still scores `advisory`. The draft
  records the ceiling as the entry's `at_most`, and `record.ts fill`, `merge`
  and `check` refuse a score above it.

### Changed

- **Breaking**: `record.ts check`, `compare` and `summary`, and `report.ts
  validate` and `render`, refuse a record (a prior or older one included)
  whose commit the repository does not hold, and a report whose repository
  name, owner included, none of its remotes names; run the audit from a full
  clone of the audited repository. `report.ts --other-repository` renders
  another repository's audit on purpose.
- With the forge readable, the integration branch is the forge's default
  branch, and a local `origin/HEAD` that disagrees is reported. With at most
  one person committing in the last year, the suggested profile is Solo/Lite
  even where CI deploys. The tracker team suggestion counts issue keys in
  branch names and commit subjects too.
- The criteria say when to score `expected-absent` (the shape rules the
  practice out for good) and when to score what the repository does without
  the module a practice presupposes; a
  check only in a local hook is `advisory`; a host plan that cannot require
  checks is scored advisory with a local hook as the ceiling; shapes include
  `infrastructure`.

## [0.50.0] - 2026-10-17

### Added

- [`/jig:code-stats`](plugin/skills/code-stats/README.md) measures what a
  repository is made of. It classifies every tracked file by area (what it is
  for: scaffolding, CI, build, database, ops, tools, docs, repository
  configuration, production), kind (code, test, docs, config, data,
  generated, fixture, asset, vendored), language and module, counts its lines
  of code, and reports in the terminal, as versioned JSON (`--json`) or as a
  self-contained interactive HTML report (`--html`). It needs no setup: test
  conventions for JavaScript and TypeScript, Python, Go, Java and Kotlin,
  Rust, Ruby, PHP, C#, Elixir and shell, the `linguist-*` attributes in
  `.gitattributes`, generator banners, lockfiles, a table of build tools and
  one of database tools, and the workspace manifests of pnpm, npm, Go, Cargo,
  Gradle and uv. Vendored files are left out of the totals unless
  `--include-vendored` is given. Every output shows the unclassified share,
  so a layout the defaults do not fit is visible, and `--explain <path>`
  names the rule behind each value of one file. A new
  [`code_stats`](plugin/CONFIGURATION.md#code_stats) section of
  `.config/jig.yaml` sets the areas, the default area, kind globs and module
  folders, and `code_stats.classify_command` lets a repository classify files
  with a command of its own.

## [0.49.0] - 2026-10-17

`/jig:drive-pr` no longer assumes every repository has an AI reviewer.

### Changed

- **Breaking**: `/jig:drive-pr` waits for an AI reviewer only where the
  repository names one, with `review.reviewer_app` or
  `review.reviewer_check_pattern` in `.config/jig.yaml` (or the
  `DRIVE_PR_REVIEWER_APP` and `DRIVE_PR_REVIEWER_CHECK` overrides). Before, a
  repository that set neither was held in `AWAITING_REVIEWER` until the
  timeout, looking for a check named `AI review`. Now it converges on zero
  unresolved threads, zero unaddressed summary findings and green CI, and a
  check that only looks like a reviewer's counts as an ordinary check. A
  repository whose AI reviewer relied on the built-in check name must set
  `review.reviewer_app` (its GitHub App slug) to keep waiting for it;
  `review.bots` alone no longer makes the drive expect one.

## [0.48.1] - 2026-10-17

### Changed

- The plugin's README says a release run writes the waiting changes that ask
  for a release as one version, the largest bump any of them asks for. A test covers notes
  from several merges becoming one version and one changelog section.

## [0.48.0] - 2026-10-17

`fix-ci` attributes a test failure on a freshly fetched base before it fixes
anything, and M14 gains the practices around it: the skip tripwire, stale-test
triage, behaviour pins, a runtime canary, one toolchain version source, and
exit-code assertions that print the child's output.

### Added

- M14 skip tripwire
  (`modules/M14-testing-strategy/reference/tests-executed/`): a gate that
  fails a CI job whose suites executed zero tests, counted from the runner's
  JUnit report as the test cases not skipped, per suite where asked; a
  missing or unreadable report, one that is not well-formed XML, or one
  with a suite or case outside its place in the JUnit tree fails closed.
  The report is read by `plugin/shared/junit-report.ts`, a strict XML
  parser that reads the document in order against the XML grammar
  (predefined entities only, line ends normalized, a `DOCTYPE` read by its
  grammar and without an internal subset), shared with
  `fix-ci`'s probe so the two gates cannot read one report differently. Core piece 11 states the rule,
  the mappings give the report flag per runner (Bun, Vitest, Jest, pytest,
  gotestsum, Surefire and others), the template carries it, and the audit
  scores the Standard criterion `M14/provisioned-suites-executed`.
- `fix-ci` stale-test triage: `plugin/skills/fix-ci/scripts/probe-base.ts`
  reproduces a failing check on a freshly fetched base in a throwaway
  worktree (never a stash, never a checkout in the working tree), with the
  repository's install command run there first (`--setup`), and says
  whether the failure is the change's, pre-existing, or undecidable. For a
  test, the verdict is the named case's own result in the JUnit report the
  command writes on the base (`--expect` the test's name, `--junit` the
  report), so another case failing beside a passing one is not read as the
  same failure. An exact case name is read before a partial one, a skipped
  case beside a run one is no answer, and a report already at that path on
  the base is removed before the command runs, so only the report the
  command writes is read; a check with no per-case report counts as pre-existing only
  when the base's output shows the error message CI showed. A fetch, an
  install, a git call, setup or command past its own `--timeout`, a report with no answer for the
  case, or a different failure on the base is no answer. `SKILL.md`'s test-failure step runs it in
  place of the pointer to a procedure the repository was assumed to have.
  M14 core piece 12 states the rule (fix a stale test inline when cheap,
  otherwise delete it with a tracker item recording what it covered;
  regenerate a test only when its premise is obsolete) and links M13's
  unscoped run on the integration branch; the glossary defines *stale test*
  and *fresh-base probe*; the audit scores the Lite criterion
  `M14/stale-test-triage-written`.
- M14 behaviour pins and the runtime canary: every workaround for a defect
  in a dependency has a test beside it that asserts the defective behaviour
  against the real dependency and names the workaround (core piece 13), and
  `modules/M14-testing-strategy/templates/runtime-canary.yml` is a scheduled
  workflow that blocks nothing, runs the suites with pins and the
  integration tier against the runtime's next release, smokes the compiled
  binary, and records the build it used (core piece 14). The mappings give
  the shape of a pin per runner and the next-release channel per runtime;
  the audit scores `M14/dependency-workarounds-pinned` (Standard) and
  `M14/next-release-canary` (Strict).
- M2 one version source
  (`modules/M2-generated-artifact-freshness/reference/toolchain-pins/`): a
  toolchain version is declared in one place, and the gate fails when a pin
  site (a CI setup step, a container build argument, a package-manager
  field, a type package) differs from it. A CI setup step is read from the
  parsed workflow (`step:` with its version input), so a comment is no step
  and a step without its version is caught; every file a structured path
  names must hold the pin, every glob must match a file, and an empty
  version is no version. A setup step that reads the version from a file
  agrees only when that file is the source and the action's own reader,
  which the gate mirrors for `actions/setup-node` and `oven-sh/setup-bun`,
  takes the source's value from it; any other action, and a file the action
  reads in a way the gate does not follow (`package.json`, `mise.toml`),
  sets its version explicitly. Exceptions carry a reason and prune themselves. Jig declares its own pins in `.config/toolchain-pins.yaml`
  and runs the gate as `bun run pins` in the fast gates; the audit scores
  `M2/toolchain-pins-one-source`.
- M14 exit-code assertions that print the child's output: a test that
  asserts a spawned process's exit status asserts it through a helper that
  prints the child's captured output when the assertion fails
  (`lib/test-helpers/expect-spawn-exit.ts`, with `expectSpawnExited` for a
  child whose exit is awaited), since a bare assertion reports
  two numbers and a genuine regression then reads like a process killed
  under load. Core piece 7, the Standard level, the template and AGENTS.md
  state the rule, the mappings give the helper and the lint per ecosystem,
  and the audit scores the Standard criterion
  `M14/spawn-exit-assertions-print-output`. Jig's own lint rule
  `tools/quality/grit/no-bare-exit-code-assertion.grit` flags the bare shape,
  synchronous or awaited, in test files at `warn`, so the ratchet lets its count only fall. Outside
  drive-pr no test asserts either shape the rule matches, and the
  resource-lock suite's own wrappers (an array of awaited exits, a helper's
  returned code) assert through the helper too; a wrapper that renames the
  field is outside what the rule sees. The drive-pr suite keeps 1,002 bare
  assertions to burn down.

### Changed

- `@types/bun` moves to the runtime's version (1.4.3), which the toolchain
  pins gate found a patch behind.

## [0.47.0] - 2026-10-17

Jig's gate set runs cheapest first and to the end, M1 covers the supply chain of application dependencies and secrets, and the enforcement ladder gains the agent-runtime rung, with a plugin hook on it: the turn-budget guard.

### Added

- M1 core piece 7 states the practice for application dependencies and
  secrets: a [release cooldown](GLOSSARY.md) held by the updater and by
  every package manager at install time, with exact-name exemptions; an
  [install-script allowlist](GLOSSARY.md) whose packages the updater never
  auto-merges; one policy file every installer and the updater repeat, held
  in step by a lockstep gate that runs before any install could run a script
  ([`reference/supply-chain-lockstep/`](modules/M1-gates-enforcement-ladder/reference/supply-chain-lockstep/README.md),
  with fixtures and a self-test); the updater's self-check; and layered
  secret scanning, where the CI layer scans exactly the change's commits
  and fails on an empty range. The templates
  [`supply-chain-policy.yaml`](modules/M1-gates-enforcement-ladder/templates/supply-chain-policy.yaml)
  and [`secret-scan.yml`](modules/M1-gates-enforcement-ladder/templates/secret-scan.yml)
  ship with it;
  [`mappings.md`](modules/M1-gates-enforcement-ladder/mappings.md) maps
  each value onto Renovate, Dependabot, Bun, pnpm, npm and yarn, and the
  secret scanners per layer. The gate requires Bun's `trustedDependencies`
  even when empty and never `null` (omitted, Bun trusts its own built-in
  list), refuses every
  pnpm setting besides `onlyBuiltDependencies` that can grant a build (in
  `.npmrc` too), reads the cooldown from
  `pnpm-workspace.yaml` (an `.npmrc` only beside it), and holds Renovate's
  exemption and guard rules to package names alone. Jig states its own
  policy in `.config/supply-chain-policy.yaml`, runs the gate first among
  the repository checks in `bun run gates` and before CI's install, sets
  an empty `trustedDependencies` in each install root's `package.json` and
  the cooldown in each install root's `bunfig.toml`,
  and installs with scripts off in every CI install.
- M1 core piece 8 names [agent-runtime hooks](GLOSSARY.md) as the rung
  between convention and git hooks, with their rules: local files only,
  bounded cost, three outcomes that fail open loudly, one registration in
  every runtime, and a self-test per hook that one runner discovers in CI.
  [`mappings.md`](modules/M1-gates-enforcement-ladder/mappings.md#agent-runtime-hooks)
  maps the rung onto Claude Code's and Codex's hook systems, and
  [`templates/hook-self-tests.sh`](modules/M1-gates-enforcement-ladder/templates/hook-self-tests.sh)
  is the runner, self-tested beside it.
- The plugin ships an agent-runtime hook, the turn-budget guard
  ([`hooks/turn-budget-guard.ts`](plugin/hooks/turn-budget-guard.ts),
  registered by `hooks/hooks.json` before every tool call): it counts the
  session's agentic turns off the transcript and hands the agent a wrap-up
  instruction within 50 turns of the runtime's cap of 1000, so an unattended
  session writes its handoff before the runtime aborts it. `JIG_TURN_BUDGET`
  (`0` turns it off), `JIG_TURN_BUDGET_MARGIN` and `JIG_TURN_BUDGET_REFIRE`
  change the thresholds
  ([CONFIGURATION.md](plugin/CONFIGURATION.md#environment-variables)).
  Codex runs a plugin's hooks only once trusted, and its transcript is not
  in the format the guard reads
  ([plugin/README.md § Codex notes](plugin/README.md#codex-notes)).
- New M1 criteria, `since: next`: `dependency-release-cooldown`,
  `install-scripts-allowlisted`, `supply-chain-policy-lockstep`,
  `updater-self-checked`, `secret-scan-blocks-in-ci`,
  `secret-scan-local-and-forge-layers` and
  `agent-runtime-hooks-self-tested`; Jig's audit record scores them against
  the commit it audited.

### Changed

- `bun run gates` runs its cheap stages first (the context budget, format,
  lint, types and the repository checks) and runs to the end: every stage
  reports, the run closes with the list of what failed, each line the
  command that reruns that stage alone, and it exits 1 when a stage found
  violations and 2 when the only failures could not check (a stage that
  cannot start included). Each stage's name quotes its arguments and its
  status follows as a shell comment, so the line pastes into a shell as it
  is. `--fast` keeps
  its meaning. [CONTRIBUTING.md](CONTRIBUTING.md#quality-gates) lists
  the stages in the new order, and M1 core piece 1 states the practice.
- drive-pr's reference on the turn budget and its `SKILL.md` say the plugin
  ships the counter, instead of asking each repository to install one.

## [0.46.0] - 2026-10-17

### Added

- Herdr is the workspace runtime Jig's tooling targets first
  ([ADR-0005](docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md)):
  the launcher's Herdr provider and checks of the skills inside Herdr are
  [ROADMAP.md](ROADMAP.md) item 19, and
  [M12](modules/M12-parallel-agent-ergonomics/mappings.md)'s mappings say
  where the worktree lifecycle hooks wire in Herdr: the create hook in the
  created worktree, the remove hook in a wrapper that parks before removing.
- `reflect` records `herdr` as the session's wrapper when the session runs
  in a Herdr pane.
- [M12](modules/M12-parallel-agent-ergonomics/README.md) states the
  control channel into an unattended agent as a practice: binding
  directives are a closed set enforced by code that fails closed, and notes
  only advise. `drive-pr`'s drive mailbox is its runnable form, and
  [mappings.md](modules/M12-parallel-agent-ergonomics/mappings.md#control-channels)
  compares it with what agent runners offer. The audit scores it as a new
  Standard criterion, `unattended-agent-control-channel`, expected-absent
  where no agent runs unattended; the drive mailbox meets it only with its
  push-hold recheck wired as the last pre-push hook command. The worktree
  ergonomics template carries it as rule 9.
- [The memory tiers](modules/M9-tasks-memory/templates/MEMORY-TIERS.md)
  name the machine-local store: a per-clone folder outside every worktree
  for what the worktrees of one machine share, which must hold no work state
  the tracker lacks, and the review-loop record that does not meet that yet. They also say how the several agents of one worktree share its
  scratch directory. The M9 audit criterion `memory-location-designated`
  observes where shared state lives.
- Glossary entries for the control channel and the machine-local store; the
  worktree scratch entry names `.context/`.

### Changed

- The glossary defines *workspace runtime*, and its launcher and workspace
  provider entries no longer present one runtime as the one Jig uses.
- The documents the site shows say what Jig supports and plans rather than
  what its maintainers happen to use: tracker, design-tool, CI and agent-tool
  bindings are named as the current implementation, configuration examples
  use neutral values, and notes on how Jig itself is built and released
  moved to [CONTRIBUTING.md](CONTRIBUTING.md).
- The roadmap is split: [ROADMAP.md](ROADMAP.md), which the site shows,
  says in a few sentences what each item gives a team, and
  [design/plan.md](design/plan.md) holds the detail and the work only
  Jig's maintainers need, under the same numbers; `bun run gates` checks
  that every roadmap item is in the plan in the same group and order, and
  that the documents the site shows cite only roadmap items.
- `resolve-review-comments` says which severity formats it reads from any
  reviewer and which only from CodeRabbit.
- The plugin README is written for teams that use the plugin: adding a
  skill to Jig and releasing it are in [CONTRIBUTING.md](CONTRIBUTING.md).
- `review`'s interface-surface check asks for M15's upper bound on every
  published request input: a type, plus a maximum length, pattern or format
  on a string, a maximum on a number, a maximum item count on an array and a
  closed shape on an object.

## [0.45.0] - 2026-10-17

M11 now watches whether scheduled automation is still running, not only how it last finished.

### Added

- M11 process observability: **heartbeat**. Every scheduled job declares the cadence it must produce a result at, in a cadence registry ([`templates/scheduled-jobs.yaml`](modules/M11-process-observability/templates/scheduled-jobs.yaml)). A job whose last result is older than its cadence plus grace, or that has produced none, is **stale** unless its failures in a row already make it red, and stale is never green; a job is exactly one of green, degraded, red, stale or running, with the number of failures in a row that make it red set per job. The watcher reports to an external monitor on success and on failure, so a watcher that itself stops is an incident (a dead-man's switch). The module README states the doctrine; its mappings list the monitor products, a run-history collector per provider and the watcher workflow for GitHub Actions and GitLab CI.
- M11 reference gates in [`reference/heartbeat/`](modules/M11-process-observability/reference/heartbeat/README.md): `classify-heartbeat.ts` classifies each declared job from a run history and exits non-zero for a red or stale job, and fails closed on a history or registry it cannot trust (an impossible date, one run listed twice, an empty history makes every job stale, and the job that runs the classifier is declared with `watcher: true` and left out of the classification); `check-schedules-declared.ts` fails a scheduled workflow missing from the registry. Both have self-tests and fixtures.
- Audit criteria `scheduled-jobs-staleness-watched` (Standard) and `heartbeat-reports-to-external-monitor` (Strict) in M11. The `heartbeat` event gains optional `red_jobs`, `stale_jobs` and `red_or_stale_jobs` counts, and the metrics registry template a `scheduled-jobs-red-or-stale` metric.
- Jig declares its own scheduled workflow in `.config/scheduled-jobs.yaml`, and `bun run gates` fails a scheduled workflow that is not in it.

## [0.44.0] - 2026-10-17

The `changelog` skill: a repository turns change notes on with one section of its own configuration, and the release step and branch check read it.

### Added

- M2's [generated-file inventory](GLOSSARY.md): every derived file is
  declared once, with its outputs, its source, its regenerate command and
  its check, and one generic runner
  (`modules/M2-generated-artifact-freshness/reference/inventory/`) runs
  every declared check as the only CI step the practice needs, reporting
  every result and failing closed on an inventory it cannot read or a check
  that cannot start; each check runs in a process of its own with a
  deadline (`$JIG_COMMAND_TIMEOUT_SEC`, `lib/bounded-shell.ts`); a copyable
  inventory starter in M2's `templates/`.
- M3's catalog `generated:` block is the list of M2 inventory entries an
  area owns, which the runner reads straight from the catalog; Jig's own
  derived files are declared there and `bun run gates` runs their checks
  through the runner (`scripts/check-generated-files.ts`).
- Regeneration after merge through a pull request: the GitHub Actions
  skeleton `modules/M2-generated-artifact-freshness/templates/regenerate-after-merge.yml`
  (one pull request per generator on a fixed branch, merged by a person, no
  CI-skip marker on any commit, a credential of its own), with the
  steps for other providers in M2's `mappings.md`.
- Generator coverage (`reference/generator-coverage/`): the inputs a
  generator reads are the inputs that exist; and one-way derivation with
  structured artifacts compared as parsed data (`reference/compare-as-data/`).
- Numbers in prose: the constraint-versus-tally test in M2's README and in
  M0's `AGENTS-skeleton.md`; a facts registry checked exactly by
  `reference/prose-facts/check-registered-facts.ts` (each fact derived from
  globs or a command, every registered phrasing of a stated copy compared);
  and the advisory lint `reference/prose-facts/lint-derivable-counts.ts` over
  tallies nobody registered, with the `<!-- measured -->` escape.
- Audit criteria, each `since: next`: M2 `regeneration-after-merge-via-pull-request`,
  `generator-reaches-every-input`, `derivation-one-way-compared-as-data` and
  `numbers-in-prose-rule-stated`.
- `/jig:changelog` ([README](plugin/skills/changelog/README.md)): when a change needs a change note, how to write one a reader of the changelog can use, and `check.ts`, `status.ts` and `release.ts`, each printing the plugin version it ran as. It is on only in a repository whose own `.config/jig.yaml` sets `changelog.file`; elsewhere every command says `not configured` and writes nothing.
- The `changelog:` configuration section (`file`, `format`, `notes_dir`, `version`, `release_paths`, `note_paths`, `placeholders`, `after_version`, `unreleased`, `authors`, `tag_prefix`, `release.push`, `release.branch`), documented in [CONFIGURATION.md](plugin/CONFIGURATION.md#changelog) and listed in the audit's configuration schema. It is read from the repository's own file alone: a user file or a `JIG__CHANGELOG__*` variable that sets a field is refused, never merged. The audit refuses what the skill refuses: it resolves the section against the repository, so a changelog, format, version file or version key that is missing, or version files that disagree, are reported.
- The branch check holds a branch to the `changelog:` section its base holds (`git show <base>:.config/jig.yaml`), so a pull request cannot weaken its own check. A branch that edits the section is also checked against the section it proposes, and the check prints the change.
- Common Changelog beside Keep a Changelog: format detection, its change types, no Unreleased section, references to the pull request or commit and the authors taken from git alone, one notice per release, `**Breaking:**` entries listed first and tied to `release: major`, a link definition per version.
- Versions kept in JSON, TOML or YAML files at a key, in a plain `VERSION` file, or only in tags; derived from `package.json`, `pyproject.toml` and `Cargo.toml` when the repository names none. Only the value at the key changes, and the file is parsed again to confirm it.
- `after_version`, a command the release step runs after it moves the version, for files that repeat it. Inside a CI job (`CI`, `GITHUB_ACTIONS` or another service's marker set) it runs only when the job sets `JIG_AFTER_VERSION_IN_CI=1`. Its output goes to standard error, and after `JIG_AFTER_VERSION_TIMEOUT_SEC` seconds (1800 by default) it is stopped with every process it started.
- `changelog.unreleased: wait` for Keep a Changelog, and a first-release link that points at the version's own tag.
- A structural check of each note with `Bun.markdown` for the format's change types; a Bun without it fails with the version it needs (1.4.3).

### Changed

- M2's Strict criterion `artifact-inventory-generated-and-gated` now asks
  for the declared inventory and the one runner, so it can be met;
  `prose-facts-ci-checked` asks for the registry and its phrasings.
- M3's graph-validated criterion and reference follow the inventory's field
  names (`generated[].source`), and the catalog checker validates `generated:`
  entries with the runner's own validation.
- CONTRIBUTING's derived-files section points at the catalog as the one
  source instead of carrying its own table.
- The shared `lib/files.ts` lists only files present on disk (a tracked file
  deleted from the working tree no longer counts), with forward slashes on
  every platform, and blanks code with CommonMark's fence grammar, now shared
  with `check-referenced-paths.ts`.
- **Breaking:** `check.ts` and `release.ts` under `plugin/skills/changelog/scripts/` no longer take `--notes`, `--changelog`, `--version-file`, `--release-path` or `--stamp*`; they read the `changelog:` section of `.config/jig.yaml`. A repository that called them by hand moves those values into that section.
- Jig's own release step and changelog gate read the `changelog:` section of Jig's `.config/jig.yaml` instead of constants in `scripts/`.

## [0.43.0] - 2026-10-16

### Added

- Opt-in drive timing traces with child-process context and command
  durations. Enable them with `JIG_TRACE=1` or choose a file with
  `JIG_TRACE_FILE`; `reap-state.ts` removes trace days older than 14 days.

### Changed

- Share retry and polling policies across the runtime (a retry takes a
  required classifier and rethrows any error it does not name as transient
  at once), and release live resources in reverse acquisition order through
  one process-wide cleanup registry on normal completion, errors and
  termination signals.

## [0.42.0] - 2026-10-16

M15 Contracts and error handling, a practice module for the failures and interfaces that callers and stored data depend on.

### Added

- [M15 Contracts and error handling](modules/M15-contracts-errors/README.md):
  a failure keeps its cause and travels on one of three declared channels (a
  result type for an expected outcome, a typed domain error with a registered
  code across a module boundary, one defect primitive for a bug), callers
  branch on type or code and never on message text, errors reach callers
  through one boundary with a fixed response shape that sends no internal
  detail on a server-side failure, and telemetry is keyed on code and type.
  With a copyable error contract
  ([`templates/ERROR-HANDLING.md`](modules/M15-contracts-errors/templates/ERROR-HANDLING.md)),
  a detached-work helper and unhandled-rejection listener
  ([`reference/detached/`](modules/M15-contracts-errors/reference/detached)),
  and the lint rules below.
- The GritQL rules against swallowing a failure (a default-returning catch,
  discarded child error output, an unchecked parse cast) are now the module's
  reference lint rules
  ([`reference/lint-rules/`](modules/M15-contracts-errors/reference/lint-rules)),
  joined by two more: a thrown native error outside the typed family, and a
  branch on an error's message text. Jig runs all of them on its own code
  under the ratchet.
- One error-code registry as the single source of truth: every code declared
  once with its metadata, every other copy generated under M2's freshness
  triad, no code constructed elsewhere, and the registry and the code audited
  both ways. A neutral template registry
  ([`templates/error-codes.yaml`](modules/M15-contracts-errors/templates/error-codes.yaml))
  and two gates with fixtures and a self-test
  ([`reference/error-registry/`](modules/M15-contracts-errors/reference/error-registry)):
  no inline code outside the registry, with an allowlist by identity; orphans
  against a baseline by identity, and reverse orphans in hand-written
  documents.
- Migration discipline: a merged migration is never edited, renamed or
  deleted (held at merge time by a gate over the diff against the merge base,
  and at apply time by the runner's hash), the ledger and the files match one
  to one in strictly increasing order, a migration changes structure only
  with a data change's exception in an allowlist outside the file, and a
  migration's commit carries M1's review marker. A copyable contract
  ([`templates/MIGRATIONS.md`](modules/M15-contracts-errors/templates/MIGRATIONS.md)),
  the merge-time gate with a self-test over scratch repositories
  ([`reference/migration-immutability/`](modules/M15-contracts-errors/reference/migration-immutability)),
  and mappings per migration tool and database parser.
- Published interface surface: an operation is internal unless a named
  external consumer justifies publishing it, with the published and the
  internal contract documents generated from one source; every request input
  declares a bound, and the count of unbounded fields only falls; an
  operation declares every failure status its code can produce. A copyable
  policy ([`templates/INTERFACE-SURFACE.md`](modules/M15-contracts-errors/templates/INTERFACE-SURFACE.md))
  and two gates over the contract document with fixtures and a self-test
  ([`reference/interface-surface/`](modules/M15-contracts-errors/reference/interface-surface)):
  no internal operation in the published document, and the unbounded-input
  count held against the merge base or a ceiling.
- M15's criteria at Lite, Standard and Strict in the audit
  (`since: next`), the module's targets in the Team/Standard and
  Regulated/Strict profiles, its place in the survey map, and its scores in
  Jig's own record and the calibration record. Glossary entries for the
  module's terms: failure channel, result type, domain error, defect, error
  boundary, correlation id, detached work, error-code registry, orphan code,
  migration ledger, fix forward, structure-only migration, published
  interface, bounded input.
- The `review` skill's contract tier asks, for an operation a change adds to
  the published contract, who its external consumer is, that every input it
  declares carries a bound, and that its declared failure statuses cover what
  its handler and the error boundary can produce.
- A shared GritQL fixture harness (`lib/test-helpers/grit-fixtures.ts`) that
  runs a directory of rules against its `good`/`bad` fixtures, used by Jig's
  own rules and the module's.

### Changed

- M1's ratchet names a Biome plugin by its file rather than its path, so a
  rule moved to another directory under the same name keeps its strictness
  and is not reported as a loosening.
- M1's gate-authoring example and its commit-msg marker reference point at
  M15's migration discipline for the migration rules; M2's README points at
  M15 for the registry practice an error-code catalog is generated from.

## [0.41.0] - 2026-10-16

Jig now teaches keeping the areas that no gate covers under a known audit cadence.

### Added

- An audit catalog template in [M8](modules/M8-learning-loop/README.md#the-audit-catalog-areas-no-gate-covers): one row per drift-prone area with its owner, cadence, tooling, last-audited date and open work, where an area audited only by hand is tracked as a gap in tooling. [M4](modules/M4-docs-governance/README.md) links to it from its wiki-lint cadence, and the module's mappings say where the reminder for each cadence lives.
- An optional deep-review tracker template that versions the dimensions of a deep review and queues a re-review of every area last reviewed under an older version.
- The audit scores one new criterion, `M8/audit-catalog-maintained` (Standard), which a repository without such a catalog scores as absent, unless a gate fully covers every one of its areas (then the criterion is expected to be absent and counts as met); Jig's own record and the example audit carry it. The glossary defines audit catalog, drift-prone area and deep-review tracker.

## [0.40.0] - 2026-10-16

### Added

- `/jig:audit` scores a new Standard criterion for
  [M0](modules/M0-instruction-architecture/README.md),
  `model-pins-are-family-aliases`: every model an agent or skill pins is a
  family alias in its metadata (or, for a judgment pass inside a skill, in
  that skill's configuration), never a versioned model id (or, where the
  runtime has no aliases, the vendor's most general model name or one
  centrally mapped name), a CI check over that metadata enforces it, and any
  committed roster of assignments is generated and drift-checked. A
  repository whose agents and skills pin no model meets it.
- The [glossary](GLOSSARY.md) defines model tier, Judgment tier, decision
  layer, family alias, A/B baseline, cost per completed task and model roster.

### Changed

- M0's [model routing policy](modules/M0-instruction-architecture/reference/model-routing-policy.md)
  gains a narrow Judgment tier beside Strategic, Execution and Scout, admitted one decision layer at a time by an admission test that
  runs before the cost ladder, with containment against creep, a mandatory
  A/B baseline, a one-line downgrade and a compliance rule for scheduled
  sends. Moving a pin on cost grounds needs a measured cost per completed
  task in either direction; pins are family aliases, never version strings;
  and a roster, where kept, is generated from metadata and drift-checked.
  [mappings.md](modules/M0-instruction-architecture/mappings.md#model-tiers-per-vendor)
  gains the Judgment row, Claude Code's family-alias mechanics and dated
  observations on Judgment-tier data retention, usage credits and
  enablement.

## [0.39.0] - 2026-10-16

The fleet-health sensor now reports an epic census beside its stuck-epic signal.

M5 names the split between skeleton files, which hold the architecture's contracts and which agents treat as read-only, and tissue, which agents may change freely, and ships the gate that enforces it.

### Added

- `fleet-health.ts` reports read-only signals about started epics: `finished-but-open` (every child closed, the epic still open), `tail-blocked` (at least 80% delivered with one or two children open) and `orphan-risk` (no children, project, owner or repository label). None is commented on an epic, and each reminds that closing an epic requires an accepting acceptance verdict or a waiver. Configuration: `signals.tail_blocked.*` and `labels.repositories` in the [fleet-health file](plugin/CONFIGURATION.md#the-fleet-health-file); both are optional, so an existing file keeps loading.
- M5 ADR practice: a skeleton-file inventory template (`templates/skeleton.yaml`) and a reference gate (`reference/skeleton-gate/check-skeleton-adr.ts`, with fixtures built in its self-test). A change to a listed file merges only when it edits the inventory or a `Decision-Record: ADR-NNNN` trailer names a record that resolves to one file and has an approved or amended status that nothing superseded. The gate runs as a `commit-msg` hook and, over a pull request's range, as the CI authority; it fails closed on an inventory entry that matches no file (a renamed or deleted skeleton file), on a skeleton file renamed out of a listed directory, and on input it cannot read. It extends M1's commit-msg marker, and M5's mappings give the hook, CI and code-owner wiring per host.
- The M0 AGENTS template gains a "read before modifying" line for the skeleton inventory.
- Audit: the M5 criterion `skeleton-changes-need-recorded-authority` (Strict, mechanical), scored in Jig's own record and the calibration record. The glossary gains "Skeleton file / tissue".

### Changed

- The tracker port's `startedIssueActivity` now also returns each child's state and the epic's project, assignee and labels. A custom tracker adapter must supply them.
- A finished-but-open epic is no longer also reported as `stuck-epic`.

## [0.38.0] - 2026-10-16

M13 Pipeline economy is complete: the CI hold, caches, runner sizing, one
authoritative leg and measured cost join the module, with the reference
checks and criteria that score them; the github-actions skill reviews
concurrency keys, dispatch refs and expression injection; and gate output for
agents, classified retries and a gated pipeline index reach M12, M1 and M10.

### Added

- [M13](modules/M13-pipeline-economy/README.md) states the CI hold as
  a practice (core piece 7): a required check fails on every held head from
  the instant the label is applied, only the hold's own label transitions
  skip work, releasing the hold reruns every required check, and the driver
  certifies only results that started after the release. The
  [workflow-convention lint](modules/M13-pipeline-economy/reference/workflow-conventions/README.md)
  gains a `ci-hold-events` rule for the trigger types beside its guard and
  held-head rules; [M1's CI skeleton](modules/M1-gates-enforcement-ladder/templates/ci-pr-gates.yml)
  carries the wiring as an opt-in block; M7's review-round piece links the
  practice; criteria score it at Standard and Strict.
- M13 core piece 8, caches: complete keys (environment values included),
  one shared namespace where an empty credential fails the job, bounded
  retention with a hit rate reported each run, and a trust boundary where
  only trusted contexts write. The new
  [cache-mount-coverage](modules/M13-pipeline-economy/reference/cache-mount-coverage/README.md)
  check fails a container build whose dependency store is on a cache mount
  that a reading step does not carry or carries as a different cache, or
  that is pinned by a per-command flag, and stops on any shell spelling it
  does not read; the mappings cover the task runners, build tools and both CI
  providers; M11's registry template gains `ci-cache-hit-rate`; criteria
  score the piece's key, namespace, hit rate, retention, wiring and trust
  boundary.
- M13 core pieces 9 to 11: a job's runner class follows its measured work
  and a machine's parallelism is one bounded product; CI is the single
  authority for each check and every leg before it selects no more than CI
  does, with a costly extra leg an opt-in under reopen conditions; and cost
  is measured on a cadence, each decision recorded before and after with
  the threshold that reopens it. The
  [cost ledger template](modules/M13-pipeline-economy/templates/ci-cost-ledger.yaml)
  and the [cost-ledger check](modules/M13-pipeline-economy/reference/cost-ledger/README.md)
  carry it; M11's registry gains `ci-runner-minutes`,
  `ci-sandbox-minutes-share`, `ci-cost-per-change` and `ci-queue-wait`;
  criteria score the runner class, the one authority
  and the ledger.
- The [github-actions](plugin/skills/github-actions/SKILL.md) skill
  checks concurrency keys (the ref, the event and the dispatch inputs; one
  pending run per group survives; group names compare case-insensitively),
  which workflow file a dispatch or a `workflow_run` executes, queue time
  outside `timeout-minutes`, a workflow expression inside `run:` in favour
  of `env:`, the identity that writes a machine-advanced ref, and coverage
  as a scheduled trend; the glossary defines expression injection.
- [M12](modules/M12-parallel-agent-ergonomics/README.md) core piece 8,
  agent-facing gate output: a quiet mode condenses a green run and prints a
  red one in full, keeps the gate's own exit status, and ends each part
  with one named verdict line, where a missing line means did not run. The
  [quiet-run](modules/M12-parallel-agent-ergonomics/reference/quiet-run/README.md)
  wrapper carries it, spooling the output to temporary files and passing a
  cancellation on to the command; the mappings give the runners' flags and the
  command-rewriting hook's safety model; criteria score the named quiet
  invocation (Lite), the scripted quiet form and the verdict line, and apply
  to single-checkout repositories too, since only the module's worktree
  practices are expected-absent there. Jig's own `scripts/gates.ts` does not yet run in the
  quiet form (M12's Future).
- [M1](modules/M1-gates-enforcement-ladder/README.md) gate-authoring
  rule "classify before retrying": a step retries only an error its pattern
  list marks transient, aborts at once on any other with the original
  message, and the classifier is tested against recorded messages. The
  [retry-classified](modules/M1-gates-enforcement-ladder/reference/retry-classified/README.md)
  wrapper runs a command under that rule, with an optional permanent list
  that wins over a transient-looking line and a doubling delay, and answers
  for one message in its classify mode; the mappings place it per provider; a Strict criterion
  scores it.
- [M10's architecture template](modules/M10-environments-deploy/templates/CI-ARCHITECTURE.md)
  states that a page listing the pipelines is dropped, checked or generated
  by M2's ladder, never hand-kept; a Standard criterion scores it.
- Glossary entries for the CI hold's held head, cache namespace, expression
  injection, quiet mode, verdict line, error classifier and pipeline index.

### Changed

- [drive-pr](plugin/skills/drive-pr/README.md)'s CI-hold contract now
  requires the workflow to run on the hold label's own `labeled` event and
  to skip on no other label event.
- M13's placement piece and mappings carry the run-definition rule for a
  dispatch and a `workflow_run` on both providers.
- `plugin/CONFIGURATION.md`: `ci.hold_label` points at the M13 practice.

## [0.37.3] - 2026-10-16

### Fixed

- The decision sheet's browser tests no longer fail now and then on a busy machine. After a reload they counted the restored picks at once, before the sheet had shown them; they now wait, up to five seconds, for the first restored pick to appear.

## [0.37.2] - 2026-10-16

### Changed

- The skills list (the plugin README's table and the website's Skills page)
  is grouped into families (deliver a change, review a change,
  understand, decide and record, learn from the work, inspect and analyse),
  each in the order its skills are used: `do-item` before `drive-pr`,
  `reflect` before `review-reflections`.
- Every skill row has a "Works with" column saying what starts it, what it
  runs and what it hands over to, for example `drive-pr` with
  `resolve-review-comments` and `resolve-conflicts`. The Skills page
  and each skill's page show it.

## [0.37.1] - 2026-10-16

### Fixed

- Drive-pr's quota tests now exercise both acceptance and rejection of the legacy
  `EST5EDT` zone independently of the runtime's zone database, so local gates
  pass on runtimes that reject it. Unsupported reset zones continue to park the
  drive rather than guessing a reset time.

## [0.37.0] - 2026-10-16

M10's verified-pointer watchdog decides by cause, and the environment kit gains its hygiene rules: every created resource has a reaper, the promotion gap is read from git ancestry, and a check confirms an environment's currency before judging it; M12 gets per-worktree data namespaces with their reaper.

### Added

- M10 doctrine for [environment hygiene](modules/M10-environments-deploy/README.md#environment-hygiene): every resource the pipeline creates has an owner-keyed reaper that reads an expiry written at creation, reports by default, acts only on an explicit opt-in and refuses production; the promotion gap between two environments is computed from git ancestry, never kept by hand in tracker fields; and a scheduled check against an environment that is deliberately behind first confirms the environment's currency, with the floor derived from history, and drops the cell rather than skipping it. The [`CI-ARCHITECTURE.md`](modules/M10-environments-deploy/templates/CI-ARCHITECTURE.md) template carries the rules, and [mappings.md](modules/M10-environments-deploy/mappings.md#environment-hygiene) wires them per provider.
- [`reference/promotion-gap/`](modules/M10-environments-deploy/reference/promotion-gap) in M10: a report that takes two environment pointers (or a collected log), extracts work-item keys from commit subjects and trailers by a configurable pattern, refuses a pair that is not on one line, and offers a bound and a JSON form; its count is the `promotion-gap-items` metric in M11's [registry template](modules/M11-process-observability/templates/metrics-registry.yaml).
- [`reference/worktree-namespace/`](modules/M12-parallel-agent-ergonomics/reference/worktree-namespace) in M12: the data namespace a worktree derives from its identity, and the reaper's decision over one owner's namespaces (expired, orphaned, unlabelled, production refused). Every namespace name ends in a 64-bit digest of the raw identity, so identities that differ only in case or punctuation get their own; the reaper reads `git worktree list --porcelain` as its live census, refuses any record that is not complete porcelain, and refuses to run while any worktree is detached or two branches derive one name; the drop decides each name again under a per-name lock the create also takes, waited for within a bound, in a working directory of its own run, and stops on the first failure; where several clones create namespaces, each takes its own prefix so a reaper judges only what its census can see; and `--production` is required; M12's README, [`WORKTREE-ERGONOMICS.md`](modules/M12-parallel-agent-ergonomics/templates/WORKTREE-ERGONOMICS.md) template and [mappings](modules/M12-parallel-agent-ergonomics/mappings.md#per-worktree-data-namespaces) carry the rule and the per-database commands.
- Criteria `created-resources-have-reapers`, `promotion-gap-from-ancestry` and `environment-currency-checked` in M10, `worktree-namespaces-keyed-and-reaped` in M12, and `watchdog-decides-by-cause` in M10, each scored in Jig's own audit record and the calibration record.
- Glossary entries for reaper (symmetric teardown), promotion gap, environment currency, worktree namespace, code-bearing change, dropped trigger and back-merge.

### Changed

- M10's [verified-pointer watchdog](modules/M10-environments-deploy/reference/verified-pointer) decides why the pointer lags instead of judging a threshold: lag counts only code-bearing commits; a running or failed verification is fine; a success that left the pointer behind fails for a person and is never re-run; no conclusive run past a grace window is a dropped trigger, the one cause it heals by dispatching verification at the tip, up to a budget of dispatches at that tip (`--max-heal-attempts`, default 3, against the observed `HEAL_ATTEMPTS`) past which it fails as `heal-exhausted`; the grace window ages from when the forge recorded the oldest unverified code-bearing change reaching the branch; a run that has waited for a runner past a bound is cancelled and fails; a pointer that diverged from the integration branch fails and names a back-merge as the recovery. The threshold mode stays for a repository that collects no run state. Verification covers the whole range from the pointer to the tip, which the template, the example spine and the per-provider collectors now say, with M13's bound and supersede rules and its queue-stall check cross-linked.

## [0.36.0] - 2026-10-16

The plugin gains a home for the code its skills share, and a failing script
can now say why it failed.

### Added

- `plugin/shared/`, beside `skills/`, holds the code more than one skill
  uses. New there: type guards and `decodeJson()`, which names the input and
  the field that did not have the expected shape; `swallow()` and
  `errnoCode()` for errors; an injectable clock; and a logger that writes to
  standard error.
- `JIG_LOG` (`error`, `warn`, `info`, `debug`; default `warn`) and
  `JIG_LOG_FORMAT` (`text` or `json`) set what the scripts' diagnostics say
  ([configuration reference](plugin/CONFIGURATION.md#environment-variables)).
  Under `JIG_LOG=debug` a failing script also prints the stack of the
  failure and its causes; a failed `gh` call in `resolve-review-comments`
  adds the last 4,096 bytes of its error output, which a timed-out or
  oversized call now prints by default too.
- Each line of drive-pr's driver log starts with its time and a level, and
  the log moves to `drive-pr-<PR>.log.1` before it grows past 10 megabytes.

### Changed

- **Breaking** for repository code that imports one of the plugin's shared
  modules from the installed copy: `cli.ts`, `proc.ts`, `consumer.ts`,
  `config-layers.ts`, `yaml.ts`, `gh-conditional.ts`, `tracker-labels.ts` and
  the vendored YAML parser moved from `skills/resolve-review-comments/scripts/lib/`
  to `shared/`, beside `skills/`. Import them from there. Scripts run by
  path, such as `jig-config.ts`, have not moved.
- **Breaking** for a skills folder copied by hand (a container image's
  `/etc/codex/skills/`, or `~/.claude/skills/` for a tool without plugin
  support): the skills' scripts now import from `shared/`, so copy
  `plugin/shared/` into a `shared/` folder beside the skills folder as well
  ([where it works](plugin/README.md#where-it-works)). A plugin install
  needs nothing.

## [0.35.2] - 2026-10-16

### Changed

- The plugin's code comments and tests state each rule directly instead of
  pointing at an unnamed earlier change, and the tests no longer carry the
  placeholder issue keys a mechanical scrub left behind. No behaviour
  changes.
- The origin-reference gate (`scripts/check-no-tracker-refs.ts`) reads the
  organization's name and tracker team key from the repository's own
  `.config/jig.yaml` (`review.repo_slug` and `issue_tracker.team`), so its
  pattern file spells out neither. A pattern that names a value the
  configuration does not supply makes the gate fail rather than pass. The
  gate also catches a tracker key folded into a name (`eng1234-main`,
  `PRE_ENG_1234_ACCOUNT` for a team `ENG`).

## [0.35.1] - 2026-10-16

### Changed

- Ship the change-note release and branch-check scripts inside the plugin, so they run from its installed cache with the same behavior.

## [0.35.0] - 2026-10-16

Merges that wait for one release run now ship together, change notes are
read by a Markdown parser, and the branch-protection audit combines every
rule that applies to `main`.

### Changed

- The release step releases every waiting change note as one version: the
  largest bump any of them asks for, with all of their notes. A run releases
  the tree it checked out, which already holds the code of every merge that
  landed before it started, so a version numbered and described for the
  earliest merge alone could ship a later breaking change under a patch
  number. [ADR-0002](docs/adr/ADR-0002-the-plugin-is-its-directory.md) and
  [ADR-0004](docs/adr/ADR-0004-change-notes-released-after-the-merge.md) are
  amended; `.github/workflows/release.yml` runs the step once.
- Change notes are parsed with Bun's Markdown parser, and a note may hold only
  headings, list items, paragraphs, inline links, code spans and emphasis. A
  code block, raw HTML, quote, table, image or task list is refused wherever
  it sits, not only where a hand-written check expected it. An email address
  is written as `<mailto:…>`, since the parser cannot tell a bare one from a
  relative link the release step would move.
- `scripts/check-branch-protection.ts` reads every page of the rules that
  apply to the branch and combines them with classic protection, as GitHub
  does: a required check or a thread-resolution rule counts whichever
  ruleset holds it. It reports each ruleset's bypass actors with their mode
  instead of one administrator-enforcement flag, and says `unknown` where
  GitHub omits the list. Offline input lists bypass actors under
  `rulesets[]`, and a rule without its ruleset's id or a ruleset with an
  unknown enforcement mode is refused rather than counted as active.
- `/followup` judges whether a merge's release ran by that merge's own notes
  and release run, renamed and edited notes included, so a note a later merge
  added no longer reads as a failed release.

### Removed

- **Breaking**: `release.ts` in
  [change-note scripts](plugin/skills/changelog/scripts/README.md)
  no longer has `--per-merge`, and its `--json` output no longer has
  `remaining`. A caller that looped until none remained runs it once.

### Fixed

- A change note no longer fails the gate for a code span of three backticks on
  a line of its own, or for `]:` inside a link's title. A note no longer
  passes the gate with a comment opener in a list item that follows an item
  holding a lone pair of backticks, or with raw HTML behind two backslashes.
  Whether text sits in a list item, and which links the release step
  rewrites, is checked against the parser, and a declaration or footnote
  definition is refused only where a renderer would read one, not inside a
  code span. The release step writes a note's links only when the parser
  reads the rewritten text as the original with each relative link moved.
- The release step refuses to write several notes from a shallow clone, whose
  history cannot tell the order they merged in.

## [0.34.0] - 2026-10-15

### Fixed

- Reflection no longer attaches a finding to another owner's class issue. The
  `pattern:<class>` label is shared by every repository filing into the same
  tracker team, so two repositories reviewing the same class used to land on the
  first one's issue. The `plan` of `/jig:reflect` and `/jig:review-reflections`
  now carries an `owner_marker` (`Jig owner: <owner>`, the owner
  percent-encoded): the issue filed for a
  class must carry it as a line of its own in the description, and the lookup
  attaches only to open issues that carry the asking owner's marker. A class
  issue filed before this change has no marker and is not attached to: the next
  escalation files a new one. The tracker port's `labelledIssues` can now return
  descriptions, and refuses an issue whose requested description is missing or
  neither a string nor an explicit null, rather than reading it as unmarked; an
  explicit null is an empty description and so carries no marker.

## [0.33.1] - 2026-10-15

### Fixed

- The drive-pr test that checks `RunHandle.stop()` empties the process group
  counts a zombie as gone, as `stop()` itself does. It reads the group from
  `/proc` where that answers and from `ps` otherwise, so on a host whose
  PID 1 reaps orphans late, a killed descendant still holding its
  process-table slot after `stop()` returned no longer fails the test.

## [0.33.0] - 2026-10-15

### Added

- `drive.max_rounds` sets a repository's default round budget for `drive-pr`
  (default `10`, as before). `--max-rounds` still overrides it for one run.
  Jig's own configuration sets it to 30.

### Changed

- Integer settings accept only whole numbers that can be represented exactly
  (up to 2⁵³ − 1). This applies to `drive.max_rounds`, `--max-rounds`,
  `pull_requests.size_budget`, `pull_requests.max_stack_depth`,
  `pull_requests.mark_ready`, and the audit's configuration check. A larger
  value used to be read as a rounded number and is now refused.
  **Breaking** for a `.config/jig.yaml` that sets one of these
  `pull_requests` values above 2⁵³ − 1: `drive-pr` reads the whole policy
  when it starts and stops with exit 1, and `do-item`'s pull-request plan
  refuses it too. Before upgrading, lower the value to 9007199254740991 or
  less, or delete it to use the default.

## [0.32.1] - 2026-10-15

Prose fixes to the PR review loop's skills. No configuration changes and no
script changes.

### Changed

- The triage rubric's guardrail on human-decided text also covers a fix that
  adds or changes a normative rule inside such a span while leaving the decided
  value as recorded. An unattended loop that accepted such additions one
  finding at a time extended a decision over several rounds until one addition
  contradicted the recorded amendment. A finding whose fix does this is never
  an ordinary accept: it is parked or escalated, or only wording that leaves
  the rule unchanged is accepted. The review arbiter's `fix-now` restriction
  says the same.
- `/jig:drive-pr` and `/jig:resolve-review-comments` say that `--tier` is the
  finding's rank in the rubric's priorities, taken from the kind of file the
  finding sits on and not from the PR's overall kind. The
  `resolve-review-comments` README states the same rule for human readers.
- `/jig:resolve-review-comments`' pre-reply checks include that each behaviour
  a reply asserts is in the staged diff, and that a temporal claim is tested
  after the boundary it names.
- `/jig:drive-pr` states that a drive likely to outlast the harness's
  background ceiling must start outside the harness, because the harness
  stops the command's whole process group at the ceiling.
- `/jig:drive-pr` tells the agent to close each reply-template heredoc on its
  own delimiter when batching calls (a mismatch posts the next command to the
  PR as the body), to stop and report when the worktree's branch is not the
  PR's head branch instead of renaming or checking out branches, to run each
  emitted plan check as its own command (a `set -e` script skips the checks
  after a failed non-last member of an `&&` list), and to re-read an
  inherited held thread reply against its thread before treating it as settled.
  That re-read comes before `finish-round.ts`, which drains every hold, and a
  mismatch is dispatched through `triage-thread.ts` after the fresh reply;
  `--cleanup-only` stays reserved for a human thread left open. An inherited
  summary-finding hold, which has no posted reply, has its held reason re-read
  against the finding before `finish-round.ts` too. On a mismatch the stale
  hold is released first, because parking leaves it in the held batch and the
  drain would post it, then re-held with the correct reason or parked.
- `/jig:drive-pr` names a separate terminal pane or a new session for a drive
  started outside the harness, because `nohup` alone leaves the command in the
  harness's process group.
- The glossary defines a human-decided span and its normative rules.

## [0.32.0] - 2026-10-15

### Changed

- M13's job timeouts are generous and capped. Every job has a timeout of about
  two to three times its slowest healthy run, because its work is to stop a
  hang, not to police a slow day; the workflow-convention lint's `job-timeout`
  rule now also fails a job above 60 minutes (a job that cannot be sharded
  carries a reasoned exception), where it accepted anything below the
  provider's six-hour default. The module, the copyable pipeline-economy page
  and the M1 workflow skeleton say the same.
- M14 enforces a tight tier budget on the suite's own command or step; the
  job timeout around it is M13's generous backstop and enforces a budget
  alone only when the budget is that loose.
- **Breaking** for a repository audited at Strict on M13: `/jig:audit` adds
  `M13/job-timeout-ceiling-linted`, which requires the CI-configuration lint
  to fail a job timeout written as a number above an hour unless a reasoned
  exception covers that job. A lint that accepts any value below the
  provider's default does not meet it; the comparison with an earlier audit
  reports it as added by Jig, not as a regression. To meet it, enforce the
  ceiling in the lint (M13's reference lint does) and register a reasoned
  exception for each job that cannot be sharded below an hour.
- `/jig:audit`: `M14/tier-budgets-enforced` observes that the bound
  enforcing a declared tier budget is no looser than it; a job timeout well
  above the budget is a backstop, not its enforcement.

## [0.31.1] - 2026-10-15

### Changed

- The plugin's update guide says a merge that changes `plugin/` is released
  as a new version by the release step on `main`, from the pull request's
  change note, instead of the pull request bumping the version itself.

## [0.31.0] - 2026-10-15

Pull requests stop conflicting over the changelog and the version: each adds
a change note, and the release is written after the merge.

### Added

- Change notes, [M12](modules/M12-parallel-agent-ergonomics/README.md)'s
  new core piece: a pull request records its changelog entry and the release
  it needs in a file of its own instead of editing the changelog and the
  version that every pull request edits, so merging one no longer puts the
  others in conflict. The portable form is
  [change-note scripts](plugin/skills/changelog/scripts/README.md):
  `release.ts` writes the notes into a Keep a Changelog file after the merge
  (Unreleased for a note that asks for no release, the next version's
  section otherwise), moves the version files to the largest bump asked for,
  moves the comparison links and fills in a placeholder for the version,
  with `--per-merge` one merge at a time; `check.ts` fails a note it could not read, a branch that edits what the
  release step writes, and a change to a released path without a note that
  asks for a release. M12's mappings compare Changesets, towncrier, scriv and
  changie, and say why a union merge driver or a changelog generated from
  commits is not the same.
- `/jig:audit` scores two new M12 criteria:
  `M12/change-records-one-file-per-change` (Lite) and
  `M12/change-records-assembled-after-merge` (Standard). Jig's record scores
  both absent at its audited commit, which predates them.
- [ADR-0004](docs/adr/ADR-0004-change-notes-released-after-the-merge.md):
  a pull request adds a change note, and the release is written after the
  merge. ADR-0002 is amended to match.

### Changed

- Jig's own pull requests add a change note under
  [changes/](changes/README.md) instead of editing CHANGELOG.md or the plugin
  manifests. After every merge, `.github/workflows/release.yml` runs
  `scripts/release.ts` on main, one run at a time and one merge at a time: it
  writes the notes into CHANGELOG.md, and when a note asks for a release it
  moves both manifests, commits and tags `v<version>`, so each merge that
  changes `plugin/` is still a version of its own. The workflow pushes as the
  `jig-release` GitHub App, the one actor main's ruleset lets push past the
  pull-request and check rules, with a token minted per run from a key only
  main's `release` environment holds. `bun run gates` holds branches to it
  (`scripts/check-changelog.ts`).
- A criterion's or a configuration field's `since:` may be `next` until its
  release: the audit reads it as newer than any released version, and Jig's
  release step replaces it with the version it releases.
- `/followup` checks that the release workflow wrote the merge's notes before
  it checks the tags, and `/website-update` records a site change as a change
  note.
- `main`'s rules (a pull request with `gates` green and its threads
  resolved, no force push, no deletion) move from branch protection to a
  repository ruleset, the only form that can let the release App past them;
  repository administrators keep their bypass. `scripts/check-branch-protection.ts`
  reads a ruleset as well as branch protection and lists its bypass actors
  ([ADR-0003](docs/adr/ADR-0003-a-person-merges.md) is amended to match).

## [0.30.0] - 2026-10-15

### Added

- The [Notion store](plugin/skills/reflect/README.md#notion-store) for
  session reflection (`reflection.store: notion`): reflections in a Notion
  database people browse, filter and sort, from two settings, the
  integration's secret in `NOTION_TOKEN` and `reflection.notion.database`.
  `notion-store.ts init --parent <page>` creates the database with its
  properties and views and prints the setting. Each change gets one page
  (its issue key, else its branch, per repository), where every reflection
  adds a section with the session and its findings as readable text, and a
  decision adds a review note under its finding. Each event is kept on the
  page as a JSON code block in a collapsed toggle, which is all `list`
  reads; the page properties (Status, Severity, Classes, Repository and the
  rest) are recomputed from the events after every write, and
  `notion-store.ts repair` recomputes them after a failed write. A Status a
  person changed by hand is kept, and `diagnose` reports it until a decision
  agrees. `list` caches pages that have not changed since the last read, and
  requests keep to Notion's rate limit. The store passes the conformance
  suite against a local fake of the Notion API; a run against Notion itself
  is an opt-in test (`notion-live.test.ts`).
- `store-contract.ts`'s `runConformance` and the store client's `runStore`
  take the environment the store command runs in.

### Changed

- [design/reflection.md](design/reflection.md) now describes only the future
  Jira store; the Notion store is documented in the reflect skill's README,
  and roadmap item 7 holds only its run against Notion itself.

## [0.29.0] - 2026-10-15

M13's workflow conventions are checked by a gate instead of left to prose.

### Added

- [M13's workflow-convention lint](modules/M13-pipeline-economy/reference/workflow-conventions/README.md),
  the reference gate behind M13's Strict level. It reads the parsed GitHub
  Actions workflows and composite actions and fails a job without a timeout
  below the provider's default, a pull-request workflow without a cancelling
  concurrency group, a path filter on a workflow holding a required check, a
  required aggregator not on exactly `!cancelled()`, a heavy job without
  the CI hold's guard or a hold without a reachable sentinel that fails a
  required check, a
  heavy suite with a per-change trigger, differing environments across jobs
  that share a cache, a `uses:` not pinned to a commit SHA (or an image to a
  digest), push and pull-request path filters that differ or sit on only one
  of the two, and trigger paths
  that are not whole areas of the change-area catalog. Required checks come
  from `ci.required_checks`, or are derived as the jobs that need every
  other job of their workflow; heavy suites and cache groups are declared
  in its own configuration. Every
  exception carries a reason, one that suppresses nothing fails the lint, and
  input it cannot parse or that is malformed (a repeated key, an empty
  `jobs:`, an action without `runs:` included) exits 2. Whether GitHub
  accepts a value, such as a cron expression or a Node runtime, stays
  GitHub's check and a workflow linter's. Jig's workflows
  pass it in `bun run gates`, with `nightly.yml` declared heavy and no
  exception.
- `lib/workflows.ts`: the one reader of workflow files, shared by M7's
  PR-target safety lint and the workflow-convention lint.

### Changed

- `/jig:audit`: `M13/workflow-conventions-linted` now requires the lint to
  fail closed on a file it cannot parse, to accept only reasoned exceptions,
  and to fail on one that suppresses nothing; it names the cancelling
  pull-request concurrency group among the conventions instead of a
  concurrency key that drops runs, which a lint cannot judge. Jig's record
  keeps its scores; the next audit re-scores it, with this change targeting
  `M13/workflow-conventions-linted` and
  `M13/no-required-pipeline-path-filtered`.
- `/jig:github-actions` names a workflow-convention lint among the checks a
  repository may already run.

## [0.28.1] - 2026-10-15

### Fixed

- The audit sheet keeps the reader's place when Back or Forward comes while
  the smooth scroll of a link just followed is still running: the page no
  longer keeps part of that scroll and ends a few pixels (up to a few
  dozen) from where the entry was left. The browser check for a position
  scrolled to just before Back, which failed about one run in five, now
  waits for that smooth scroll to end before it scrolls, and a second check
  covers following a link and going Back at once. The corrected jump never
  overrides a later move: following another link before it is made, or
  scrolling on purpose, drops it. Only a jump made before the input is
  dropped: Escape leaving the guide keeps the way back it makes itself.

## [0.28.0] - 2026-10-15

### Added

- Session reflection, as two skills with a pluggable store.
  [`/jig:reflect`](plugin/skills/reflect/README.md) records what a session
  learned about the repository's scaffolding: findings are captured in a
  per-worktree journal as they happen (`journal.ts note`), and at a natural
  end the skill merges duplicates, names each finding's class, escalates a
  class that recurs `reflection.escalate_after` times to one tracker issue
  labelled `pattern:<class>`, and contributes the rest to a store every
  repository on the machine (or in the team) shares.
  [`/jig:review-reflections`](plugin/skills/review-reflections/README.md)
  reads the findings the repository it runs in would fix (in Jig, every
  finding about Jig's skills from every repository), reconciles approved
  fixes with what merged, groups what recurred, proposes a change per group,
  and records each decision once a person approves. The records are an
  append-only log of findings and decisions, each with the session that
  wrote it (Jig version, skills, harness, model, and which of those the agent
  stated), and a finding's status and a class's recurrence are computed from
  it. A store is any command that answers the store contract (`check`,
  `append`, `list`, `diagnose`); `store-contract.ts` is its conformance
  suite, and the plugin ships a filesystem store (a folder of JSONL files,
  one per write, so synced or shared folders merge without conflicts).
- The `reflection` configuration section
  ([CONFIGURATION.md](plugin/CONFIGURATION.md#reflection)): its presence in
  any layer turns reflection on, normally in `~/.jig/jig.yaml`.
- M8's invariant now says reflection records are append-only, carry an id,
  and have their state computed; its mappings list the reflection stores.
  M12's worktree-remove hook parks a worktree's unsent findings for the next
  reflection, and refuses the removal when it cannot.

- The plugin's requirements name git 2.36 as the minimum, the first version
  with both options the scripts use: `--path-format` and
  `git worktree list -z`.

### Changed

- **Breaking:** `/jig:drive-pr`'s `reflectDue` and `$DRIVE_PR_REFLECT_DUE`,
  and `/jig:resolve-review-comments`' wind-down prompt after a long review,
  fire only when reflection is on, and ask for `/jig:reflect` rather than a
  repository's own `/reflect`. The wind-down also notes the round count in
  the reflection journal. A repository that relied on that nudge to run its
  own `/reflect` stops being nudged until a configuration layer has a
  `reflection` section: add one (`reflection: {}` uses the defaults) to keep
  it.
- The Linear tracker's requests can be cancelled. `labelledIssues` and
  `postComment` take an `AbortSignal`; a cancelled signal ends the request in
  flight and starts no further page. The `linear` command-line client now
  runs without blocking, so a caller's timer fires while it runs, and the
  client is stopped when the signal is cancelled or the calling process is
  terminated.

## [0.27.1] - 2026-10-15

What can be adapted in Jig, and how, in one place. No behaviour changes.

### Added

- [plugin/EXTENDING.md](plugin/EXTENDING.md), and its page on the site
  (`/plugin/extending/`): the ways a repository adapts Jig (a value, a
  command of its own, an implementation behind an interface, a row in a
  module's mappings); the commands a repository supplies, with their
  contracts; the tracker interface and how to add an adapter, with what
  still assumes Linear; reflection stores; AI reviewers; what depends on
  GitHub as the forge and on GitHub Actions as the CI system; the agent
  tools; the launcher's providers; which parts run on which operating
  system; and how an extension is contributed. Each limit names the roadmap
  item that would lift it.
- The roadmap's later work gains a forge interface, a CI provider for
  `fix-ci`'s log download, and Windows support for `drive-pr` and `do-item`;
  item 12 names the operations the tracker interface needs before a second
  adapter works end to end, and item 10 the fields named after Linear.

### Changed

- The plugin's [requirements](plugin/README.md#requirements) give minimum
  versions: git 2.36, the GitHub command line 2.48, Claude Code 2.1.285 for
  a drive's long background commands, and say that `do-item` is not tested
  on Windows.
- [Where it works](plugin/README.md#where-it-works): a tool without plugin
  support takes every skill folder side by side, since skills import
  scripts from their siblings.


## [0.27.0] - 2026-10-14

A new module, [M14 Testing strategy](modules/M14-testing-strategy/README.md),
and the audit criteria that score it. Nothing a consumer has configured stops
working; a re-audit reports the new criteria as added since the prior audit.

### Added

- [M14 Testing strategy](modules/M14-testing-strategy/README.md): test tiers
  with a trigger and a time budget, the full end-to-end sweep kept off the
  per-change path by a check, honest test doubles proven by a mutation check,
  an injected clock with a lint rule, polling with a deadline instead of
  fixed sleeps, isolation predicates tested against the real engine, typed
  test-data builders, type-checked tests, tests with every change, tests kept
  off the developer's real state, and coverage as a scheduled trend rather
  than a per-file gate. It ships a testing-strategy template, a
  tests-with-changes gate (base ref, source globs, test-path templates and an
  exemptions file as arguments) and a polling helper, each with a self-test,
  and per-ecosystem mappings for TypeScript, Python, Go, the JVM and .NET.
- AGENTS.md § Rules for every change states Jig's own testing rules: tests are
  type-checked, a test that needs another home directory, working directory
  or environment spawns a subprocess, waits poll with a deadline, and a new
  test is seen to fail first; M14 has the rest.
- `/jig:audit` scores M14's criteria (`since: 0.27.0`); its
  automation survey asks about tiers, budgets and the other testing rules.
  Team/Standard targets M14 Lite and Regulated/Strict M14 Standard; M14 comes
  after M7 in the adoption order.

### Changed

- `score.ts --check` checks the modules listed in `MODULE_IDS` rather than a
  contiguous `M0`…`M<n>` range, so a planned module number can stay open
  while that module is written.
- The execa calibration record scores M14's criteria against the same
  commit, so the website's audit example renders a complete record.
- M1 lists M14's `fixed-delay:` token and tests-with-changes exemptions file
  as suppressions for its registry; M10 tells its test-data factory apart
  from M14's typed builders.

## [0.26.0] - 2026-10-14

### Added

- M3 catalog rules for seeds versus dependency closure, agent gate depth,
  generated-output coupling, externally corroborated code-bearing anchors,
  and an independent catalog self-check trigger. The auditor's M3 criteria
  now cover these facts; shortcut-only criteria use `expected-absent` where
  the repository has no shortcut.
- A brownfield coverage-gate adoption pattern with frozen exceptions,
  partial-coverage pins and a live owner, also shown on the site's adoption
  page.

## [0.25.0] - 2026-10-14

A new practice module, M13 Pipeline economy: spend CI only where it changes
a merge decision, and never let a saving turn a failure into a pass.

### Added

- [M13 Pipeline economy](modules/M13-pipeline-economy/README.md): six
  sub-invariants (honest signal first, select, supersede, bound, order and
  parallelize, place), their GitHub Actions and GitLab CI mappings, a
  copyable policy page with the placement table, and a queue-stall watchdog
  (a reference check with its self-test and a scheduled workflow), because
  job timeouts do not count time spent waiting for a runner.
- `/jig:audit` scores M13's nine criteria (Lite: superseded pull-request
  runs cancelled, a timeout on every job, no required pipeline filtered by
  paths at its trigger; Standard: a catalog resolver drives selection, one
  aggregated required check, slow suites nothing waits for on a schedule;
  Strict: the conventions linted, CI cost measured, a queue-stall watchdog).
  Team/Standard and Regulated/Strict aim for M13 Lite, so a re-audit reports
  M13's criteria as added by Jig.

### Changed

- The execa calibration record scores M13's criteria against the same
  commit, so the audit's tests read a complete record.
- `/jig:github-actions`' performance checks name M13 as the practice they
  apply, and collect coverage on a schedule unless a coverage threshold
  gates the merge.
- M10's CI-ARCHITECTURE template links to M13's placement table instead of
  carrying its own copy; M1, M3, M7, M10 and M11 link to M13 where they
  touch it.

## [0.24.0] - 2026-10-14

The plugin reads the change-area catalog through one reader.

### Added

- `drive-pr/scripts/lib/change-areas-catalog.ts` is the plugin's one reader
  of the consumer's change-area catalog (`drive.change_areas_catalog`). It
  matches a path to the areas whose own `paths` (and `generated[].source`)
  match it, and returns each area's `tracker.labels` (alone, and joined to
  the area's own `labels`) and `tracker.flags`, reading `linear.labels` and
  `linear.flags` as the older spelling. It is step 3 of the `work-batch`
  build order (`design/work-batch.md`): the batching
  skill will read area flags through it.

### Changed

- `fleet-health`, `verification-fit.ts`, `determine_agent.ts` and
  `resolve-conflicts` use that reader and its one path-glob matcher instead
  of their own. `resolve_conflicts.generated` globs now also understand
  `{a,b}` and `[...]`, as catalog globs always did; `[!...]` and `[^...]`
  both negate a class, and a `]` first in a class is one of its members. A
  `[...]` class no longer matches `/`, so it stays within one path segment
  as `*` and `?` do, and `**` now also matches a path whose name contains a
  newline.
- **Breaking** for a catalog with a malformed area (for example `paths:`
  that is not a list of strings, or a glob such as `src/{a,b` that compiles
  to no pattern): `verification-fit.ts` now stops on it with the field at
  fault, and `determine_agent.ts` routes by labels alone and prints
  `Catalog unavailable, routing by labels only: <reason>` on stderr.
  `resolve-conflicts` refuses such a glob in `resolve_conflicts.generated`
  with exit 2. Fix the field the message names.
- **Breaking** for the fleet-health sensor, which already refused a catalog
  whose `paths`, `generated` or `labels` were malformed: it now also refuses
  one whose `tracker.flags` or `linear.flags` is not a list of strings, and
  compiles every glob when it loads the catalog rather than only the globs a
  path reaches. A catalog it refuses leaves merged PRs unclassified, so no PR
  counts as product progress and the delivery-system share is not measured.

## [0.23.0] - 2026-10-14

### Added

- M4's stale `last_updated` gate
  ([reference/stale-last-updated/](plugin/skills/docs/scripts/stale-last-updated/README.md)):
  a diff that changes a document's body must advance `last_updated`, or leave
  it at today's UTC date. It runs over a CI diff range (old side at the merge
  base for `A...B`) or the staged changes in a pre-commit hook, skips a file
  a merge carries unchanged from one side, and prints a `SKIP` note in CI when
  no range is given. It compares the two sides' bodies and their dates as the
  shared frontmatter reader parses them, never a patch. A renamed document is
  compared with its old path and only an added one is exempt. Frontmatter
  removed, left unclosed or unreadable on the new side fails, so does a
  document that is not a regular file on both sides (replaced by a symlink),
  and only a calendar date counts as a bump. Two cases have no date to hold:
  a document with no frontmatter on either side passes, and an old side the
  reader rejects has no date, so the commit that corrects it passes on any
  calendar date. A side it cannot read, an unresolvable, one-sided or doubled
  range (in every mode), `--staged` with `--range=`, a named path outside the
  repository, or an unknown option exits 2. A body line starting
  `last_updated:` or a comment added to the date is not a bump.
- Sticky UTC stamping for generators
  ([reference/stamp/](plugin/skills/docs/scripts/stamp/README.md)):
  a generator writing into the docs tree advances `last_updated` only when its
  output changed, so it neither breaks the stale gate nor churns dates. It
  reads the date through the shared reader and refuses frontmatter that
  never closes or that reader reports an error in, with or without a
  `last_updated` line, or a `last_updated` whose value continues past its key
  line, rather than stamping it half-replaced.
- M4's index generator writes an orphan report, `.orphans.md`, beside
  `INDEX.md`: the documents no other document lists under `related:`. It is a
  warning, never a failure; `--check` fails when either file is stale, and
  the report's date is sticky so the check gives the same answer on any day.
  A `related:` entry starting with `/` resolves from the repository root,
  report links resolve from the report's own directory, and the report's
  frontmatter values can be set through `ORPHANS_*` variables.
- Path-scoped frontmatter rules: `path_rules:` in the schema adds required
  fields, narrowed values and forbidden body text (outside code fences) for
  the documents under a path prefix. A rule that cannot be evaluated, or
  whose prefix matches no document in the tree, fails the check. The schema
  template carries neutral examples, commented out for adopters to adapt.
- M4's adoption steps say to bring existing docs into line with a codemod
  (survey, plan, then apply, one commit per mapping family, singletons to a
  triage list) before tightening a validator.
- `/jig:audit` scores new M4 criteria: `frontmatter-subset-declared`,
  `generators-stamp-sticky-utc`, `orphan-report-generated` and
  `path-rules-enforce-subtree-vocabulary` (expected-absent where no subtree
  needs rules of its own). `stale-doc-gate` names what its check must
  observe.
- The glossary defines *path-scoped rule*, *orphan document*, *sticky
  stamping* and *codemod*.

### Changed

- M4's frontmatter reader reads an explicit YAML subset and reports each
  construct outside it (tabs in indentation, anchors, tags, explicit or
  quoted keys, flow mappings, nested mappings, multi-line plain values,
  duplicate keys, unterminated quotes, values starting with a character YAML
  reserves, escapes YAML does not define in a double-quoted value, characters YAML
  does not allow such as control characters) as a violation with its line,
  instead of guessing. Whitespace is YAML's (space and tab, so U+00A0 is
  content) and a carriage return on its own ends a line, in every M4 script
  that reads a document: the stale gate, sticky stamping and the scar lint
  find the same frontmatter and lines the reader does. Block scalars keep YAML's indentation, folding and
  chomping. The self-test checks block scalars and one-line values (plain,
  quoted, in a list) against a YAML parser over every combination of a set of
  line shapes and characters. Trailing comments are cut
  quote-aware, `null`, `~` and blank
  values count as absent for a required field, and `tags` may be a block
  sequence as well as `[a, b]`. The subset is listed in the checker's
  README and the `WIKI-SCHEMA.md` template. **Breaking** for docs using a
  construct outside the subset: rewrite it inside the subset (the README
  lists both sides).
- M4's frontmatter checker parses the whole schema with js-yaml from
  `lib/vendor/` and reads every section from the result, so any YAML spelling
  counts (`required: [title]` included) and a section of the wrong shape fails
  the check instead of dropping its checks. **Breaking** for a copy of
  `reference/` without Jig's `lib/vendor/` beside the `modules/` folder that
  holds it (Jig's own layout): the checker exits 2 there; vendor `lib/` or run
  it from a pinned Jig checkout. `last_updated` and `decision_date` must be
  calendar dates, not only `YYYY-MM-DD` in shape. A section set to `null`
  is a schema error, not an omitted one, and a schema that cannot be read
  exits 2. The generated `INDEX.md`, which has no frontmatter, is left out:
  the file at the generator's index path (`$OUT`, else `INDEX.md` in
  `$DOCS_DIR`) that opens with its marker; the marker exempts nothing at any
  other path. A schema section
  must be a mapping where one is expected: a date
  or binary value is an error. `NEW_DOCS` lists one path per line, and an
  entry naming no checked file fails the check. **Breaking** for a
  space-separated `NEW_DOCS` of more than one file: put one path per line.
- M4's CI recipes ([mappings.md](modules/M4-docs-governance/mappings.md))
  pass the base branch and file names as data, never into the shell program;
  check renamed documents at their new path; check every document when the
  schema changes; select their own work instead of filtering the GitHub
  trigger, so the check reports on every pull request; and name the scripts
  under `<m4>`, a Jig checkout or a copy that keeps Jig's layout. File lists
  come from `git diff -z` through a file, so names with spaces or non-ASCII
  characters survive and a failing `git diff` stops the step; the pathspec
  `'docs/*.md'` covers documents directly under `docs/`, which
  `'docs/**/*.md'` misses; and a vendored checker's paths (`VENDORED`) feed
  both the work selector and the whole-tree comparison.
- M4's index generator and scar lint refuse a document whose frontmatter is
  present but outside the subset (exit 2) rather than reading part of it. The
  index leaves out only the generated index and report (a nested `INDEX.md`
  is a document), writes each title and description as one table cell,
  rejects an unknown argument, and refuses `OUT` and `ORPHANS` naming one
  file. An ADR's `decision_date` needs a value; only `supersedes` and
  `superseded_by` may be `~`, and a blank one is missing.
- M4's scar lint reports a named file it did not scan (not `status:
  approved`): `NOT SCANNED` when none of the named files is promoted, and a
  `NOTE` listing the skipped files beside `OK` or the scar report. A run over
  the whole tree still prints plain `OK`. `/jig:descar` says so.

## [0.22.0] - 2026-10-14

M0 states that instructions must reach each runtime, and that what every
session loads is a budget. Nothing a consumer has configured stops working.

### Added

- [M0](modules/M0-instruction-architecture/README.md) gains the invariants
  **delivery is observed** (a rule reaches a runtime by an import or a file it
  reads natively, the load model is recorded with dated evidence and a way to
  re-check it, precedence is a written convention, and parity is judged by
  what each runtime receives) and **always-loaded context is a budget** (the
  chained instruction files, unscoped rules, skill and agent discovery
  metadata and MCP server instructions are measured against the smallest
  consumer's budget, and text past it counts as undelivered). Its
  [mappings](modules/M0-instruction-architecture/mappings.md) list each
  runtime's and reviewer's budget with the date it was checked, where the
  always-loaded surface lives per runtime, and a CI recipe that runs before
  dependencies are installed.
- M0's [context-budget checks](modules/M0-instruction-architecture/reference/context-budget/README.md):
  `check-instruction-chain.ts` fails any root-to-directory `AGENTS.md` chain
  over the smaller of the configured `project_doc_max_bytes` and the
  consumer budget (32,768 bytes by default), and `check-discovery-budget.ts`
  checks skill and agent descriptions against the 1,024-character cap, the
  512-character soft target and the 1,536-character combined cap, and the
  skill listing against 8,000 characters, path-scoped skills included. Both
  use only Bun's built-ins.
- `/jig:audit` scores the new M0 criteria `load-model-recorded` (Standard)
  and `context-budget-gated` (Strict, mechanical).
- `bun run gates` runs the context-budget checks over Jig first (the plugin's
  skills must meet the 512-character soft target), and CI runs them before
  installing dependencies.

### Changed

- `/jig:audit`'s description is shorter (471 characters, within the soft
  target); the detail it dropped is in the skill's body.
- A pointer line no longer counts as bringing in the universal instruction
  file. M0's layers and `/jig:audit`'s `tool-deltas-are-pointers` criterion
  accept an import or the runtime's native read; where a runtime has
  neither, the delta is generated from it and checked for freshness (a
  projection, not a hand-kept copy), or the gap is recorded in the load
  model. A repository whose tool file only points to `AGENTS.md` scores
  lower on that criterion at its next audit.
- [plugin/README.md](plugin/README.md) § Add or change a skill states the
  512-character description target and the 1,024-character hard limit.

### Fixed

- The audit sheet owns history scroll restoration: each history entry keeps
  its own position under a key in its history state, recorded as the reader
  scrolls and when they leave, so Back, Forward and a reload return the reader
  to where they were in that entry, in the report and in its guide alike. Only
  the most recently used positions stay in memory; an older entry restores from
  its history state, and a position not yet written there is kept in
  preference to one that is, within the same bound.
- A re-audit reports a criterion whose `since` is newer than the prior
  audit's plugin version as added by Jig even when the prior record carries a
  score for it, so a criterion filled in after the fact is not reported as a
  long-standing gap.

## [0.21.0] - 2026-10-14

### Added

- M1 states that a gate has three outcomes: passed, found violations, or
  could not check (exit 0, 1 and 2). A gate never turns input it could not
  find or read into a pass, and a skipped or stale result is never evidence
  that a change passed. An input empty where its format requires content
  fails closed; one whose format allows zero entries may pass empty, and the
  gate says it examined zero. The glossary defines *fail closed*, *could not
  check*, *mutation testing* and *shadow job*.
- M1's gate-authoring rules (core piece 3, which replaces "a grep with a
  self-test outlives an AST analyzer"): fail closed on a missing or empty
  section, an undecodable row, a repeated key or a failed command; count the
  population read; answer a question about whether code runs or a value binds
  with a real parser or an exact pinned text, never a guessed pattern; keep a
  self-test's recognizer broader than the gate's; mutation-test every fixture,
  each clause of a fail-closed chain alone; state the verdict's scope on green
  runs too; and give each finding its rule, place, problem and fix, written
  as an annotation in CI. [mappings.md](modules/M1-gates-enforcement-ladder/mappings.md#actionable-findings-in-ci)
  maps GitHub's `::error` command and GitLab's Code Quality report.
- M1's exceptions prune themselves: every suppression token and allowlist
  entry carries a reason the gate checks, and one that suppresses nothing
  fails the gate. The suppression-registry template gains a "Stale when"
  column, and its allowlist row requires a checked reason.
- M1's gate lifecycle: a recurring syntactic review finding becomes a
  fixture-tested lint rule under the ratchet, with bulk rewrites by a tool that
  never gates; a replacement tool runs in a non-blocking shadow job with
  published parity counts before it takes over; a retired gate records what
  replaced it and the coverage lost; unused code and duplication are measured
  on every change from entry points declared one by one.
- `/jig:audit` scores new M1 criteria: `gate-outcomes-distinguish-could-not-check`
  and `stale-exceptions-fail` (Standard), and
  `gate-self-tests-cover-empty-input` (Strict).
- `lib/findings.ts`: the shared finding format, GitHub annotations with the
  workflow-command escaping, the could-not-check report, and the reasoned
  exception-list reader.

### Changed

- M1's grep-gate reference exits 2 when its scan root is missing or holds no
  text file (it passed before), states its scope on green runs, prints each
  finding with its rule, file and line, problem and fix, writes `::error`
  annotations under GitHub Actions, and fails on a `todo-exempt:` that
  suppresses nothing. It counts each TODO on its own, so a TODO citing an
  issue no longer clears a bare TODO on the same line, and a TODO inside a
  cited issue key is part of that citation. **Breaking** for a copy of the gate run on a folder
  that may not exist: point `SRC_DIR` at a folder with source in it.
- Jig's own gates follow the rules: the Markdown, glossary, origin-reference,
  instruction-path, workflow-safety, licence, change-area and audit-fit checks
  exit 2 when they read nothing, and every check states its scope when it
  passes.
  The Markdown, glossary and origin-reference checks write findings in the
  shared format with annotations. The glossary allowlist and the
  origin-reference allow patterns need a reason per group and fail on an
  entry that suppresses nothing (20 stale glossary entries are gone). The
  change-area and review-risk checks and M7's PR-target safety lint, which
  Jig's workflow-safety check runs, reject a repeated YAML key. The ratchet
  exits 2 in CI without a merge base, and the gates M1 does not yet bring in
  line are listed in [M1 § Jig's own gates](modules/M1-gates-enforcement-ladder/README.md#jigs-own-gates).
- `/jig:fix-ci` reads a gate's "could not check" (exit 2) as a problem with
  the gate's input or environment, not with the code, and applies the fix a
  finding names.

## [0.20.0] - 2026-10-14

### Added

- M10 states how a promotion executes
  ([README § Promotion execution](modules/M10-environments-deploy/README.md#promotion-execution)):
  the gated commit is the shipped commit (the first job resolves the
  `verified` pointer once and every later job takes the commit from its
  output; promotions to one environment never drop a queued request and wait
  for every earlier one, refusing a re-run and checking again before the
  migration; the promotion
  and its gate code run from the trusted ref, the only ref the production
  environment admits);
  build once (the verified artifact is promoted by digest, with
  per-environment settings supplied at deploy time); post-deploy identity (a
  deploy is complete only when the live environment reports the promoted
  identity, its rollouts are ready and a readiness check of its critical
  dependencies passes, each under a deadline, and downstream work reads a
  manifest of what deployed); and release state off the source line (release
  pointers only fast-forward, after the identity check, and refuse a gated
  commit older than themselves; rendered
  deployment state lives on its own ref written by one machine identity that
  branch protection admits). The CI-architecture and pipeline templates gain
  the gate's commit output, a verify-identity step and a deploy manifest after
  every deploy, and advance the release pointer last;
  `mappings.md` maps digest pinning, runtime configuration, Argo CD and Flux,
  GitHub's concurrency semantics, rollout checks and the identity check.
- M10's promote-safety lint gains rule (c): a production deploy job fails when
  it selects its commit by name (a `ref:` or `--ref` naming a branch or a
  branch-shaped expression such as `inputs.branch`, or a run step's `git
  fetch`, `pull`, `checkout`, `switch`, `reset`, `merge`, `rebase` or
  `rev-parse` of a name) instead of an upstream job's output. The `verified`
  pointer by name is accepted only in a job with no upstream job (in GitLab,
  a later stage is upstream unless the job says `needs: []`), resolved
  there once, and a `git fetch` of a ref the job pushes to (its rendered-state
  ref) is not a selection when a publishing push from the same repository to
  the same remote writes it. Git commands are recognized however git is
  spelled, after global options and inside nested substitutions; only a
  command at a command position, outside quoted text and heredoc bodies, in a
  repository its own text establishes, can grant an exemption; a remote
  `HEAD`, an ancestor such as `HEAD~1`, and a `FETCH_HEAD` of unknown origin
  count as names. The shapes a line matcher still misses (a command that may
  not run, a verb spelled with quotes, a fetch that keeps `FETCH_HEAD`, a
  control word used as an argument) are
  listed under its Known limits. Option arity follows the git verb, ref names keep
  their case, and a `#` inside a quoted string does not start a comment.
- `/jig:audit` scores new M10 criteria: `artifacts-built-once-promoted-by-digest`
  (standard), `promotions-serialized-from-trusted-ref`,
  `deploy-verifies-live-identity` and `release-state-off-source-line`
  (strict). `deploys-verified-artifacts-only` also observes that later jobs
  of a promotion take the commit from an upstream output.
- The glossary defines *digest*, *build once*, *GitOps*, *rendered state* and
  the *post-deploy identity check*.

### Changed

- `/jig:github-actions` describes the deploy and promotion stages with the
  digest, the trusted ref, one promotion at a time and the identity check.

## [0.19.1] - 2026-10-14

### Changed

- The plugin's README says a suite too long for the gate job gets its own
  sharded job in both the gates workflow and the nightly workflow.

## [0.19.0] - 2026-10-13

### Added

- M9 states the work-item rules
  ([README § Work-item rules](modules/M9-tasks-memory/README.md#work-item-rules)):
  an epic closes on an accepted verdict or a recorded waiver, never on its
  count of open children, and hands off its tails with a link back; a flag
  that fires a gate goes on the item that ships the change; labels carry
  durable classification only; every filing path sets priority and category
  at birth, the priority from one severity mapping and the category checked
  against one category list; copies of the taxonomy's key sets are
  checked for exact equality; prioritization is computed and a person picks.
- `/jig:audit` scores new M9 criteria: `gate-flags-scoped-to-shipping-item`,
  `epic-closure-requires-acceptance` and `issues-prioritized-at-creation`.
  A declared flag scope counts as convention, and a ranker that is only
  planned is not credited.
- `/jig:audit`'s configuration check compares the explicitly configured
  `issue_tracker.labels` (and the older `review.taxonomy.epic_label` and
  `provenance_label`) and `review.taxonomy.types` with the repository's
  `label-taxonomy.yaml`, when it has one. A taxonomy whose sections are
  malformed leaves the labels unchecked rather than reading as empty.

### Changed

- M9's label-taxonomy lint requires every flag to declare its `scope`
  (`shipping-item` or `container`) and `apply_when`, and accepts
  `do_not_apply_when` and `requires` (labels a flag may only appear with).
  **Breaking** for a taxonomy copied from the template: add `scope` and
  `apply_when` to each flag. The lint now parses the file as YAML with
  js-yaml, vendored in `lib/vendor/`, so every spelling of an entry is
  checked, a repeated key is rejected, and a field that is not text (a null
  list member, a list-valued id) is reported rather than read as absent.
  A copy of `lib/` must now include its `vendor/` folder.
- M9's taxonomy template gains an `epic` flag, and its statuses are
  `do-item`'s canonical states (`backlog`, `ops-pending`, `canceled` and
  `duplicate` added; `blocked`, a relation between items, removed).
- `/jig:do-item` closes an epic only on its newest verdict accepting it, or
  on a waiver while that verdict is not a rejection, including when every
  sub-issue is done; without either it moves the epic to `in_review`. An
  extracted tail gets its backlink and a comment naming the epic before it
  leaves the epic.

## [0.18.3] - 2026-10-13

### Fixed

- A drive armed from an unattended Claude Code session (`claude -p`, the Agent
  SDK, a cloud or scheduled session) was stopped after 30 minutes (10 in a
  `claude -p` run whose prompt is passed as text), partway through a round,
  because the harness limits background commands to that unless the agent
  passes a `timeout`, and to 2 hours at most. `/jig:drive-pr`
  and `/jig:do-item` now tell the agent to spawn the driver with a `timeout` of
  8 hours. The ceiling is the machine's to raise: set `BASH_MAX_TIMEOUT_MS` to
  `28800000`. A drive longer than 8 hours (a long quota sleep, many rounds)
  is still stopped there and resumes when re-armed. [drive-pr's README](plugin/skills/drive-pr/README.md#the-background-time-limit)
  explains the limit, what a stopped drive leaves behind and how to resume it,
  and [CONFIGURATION.md](plugin/CONFIGURATION.md#environment-variables) lists
  the variable.

## [0.18.2] - 2026-10-13

The work from Jig's audit of 2026-10-13, a lean AGENTS.md (it keeps the
rules every session needs and points to [CONTRIBUTING.md](CONTRIBUTING.md)
and [docs/](docs/README.md) for the detail), and Jig's licence. No consumer
change.

### Added

- Jig is licensed under the Apache License 2.0 ([LICENSE](LICENSE)), with the
  module templates under MIT No Attribution ([LICENSE-MIT-0](LICENSE-MIT-0))
  so a repository can copy them without a notice. [NOTICE](NOTICE) names the
  licensor, the template files and the vendored third-party code with its
  licences; the plugin carries copies of LICENSE and NOTICE, and
  `package.json` and both plugin manifests declare the licence.
  `scripts/check-licences.ts` in the gates keeps NOTICE complete and the
  plugin's copies identical. Outside contributions sign off under the
  Developer Certificate of Origin.
- [CONTRIBUTING.md](CONTRIBUTING.md): how a change to Jig is made: one
  cohesive pull request per piece of work, the parallel-workspace rules, the
  pull-request lifecycle, the toolchain, the gates and the ratchet, local
  hooks, the derived files with their regenerate commands and drift checks,
  and keeping the auditor current.
- [docs/README.md](docs/README.md): Jig's own documents: their kinds, how
  each changes, which one wins when two disagree, and how decision records
  change. [docs/dispositions.md](docs/dispositions.md) lists Jig's defaults,
  each with the condition that changes it.
- [docs/adr/](docs/adr/): Jig's first decision records: the Bun and
  TypeScript toolchain, the plugin as its directory shipped in versions, and
  a person merging every pull request.
- [design/README.md](design/README.md) maps Jig's delivery stages to M6,
  requires a fresh-context review of a design before it is built, and gives
  the skeleton a new design starts from.
- New repository checks in `bun run gates`: M7's PR-target safety lint over
  Jig's workflows (`scripts/check-workflow-safety.ts`); the paths the
  instruction files and CONTRIBUTING.md name in code spans exist
  (`scripts/check-instruction-paths.ts`); and the AI reviewer's high-risk
  paths match the change-area catalog (`scripts/review-risk.ts`).
- The change-area catalog's optional `reviewRisk: high` marks the areas whose
  paths `scripts/review-risk.ts --write` writes into `.config/ai-review.yaml`.
  New narrow areas carry those paths, and `module-reference` splits from
  `module-templates`.
- Local git hooks (`lefthook.yml`, lefthook pinned in `mise.toml`): a commit
  formats its staged files, a push runs `bun scripts/gates.ts --fast`.
- `.config/ai-review.yaml` states that every automated reviewer only
  comments, and the measured precision a reviewer must reach before it may
  block.
- GLOSSARY.md names the words to avoid: **Consumer repository** and
  **Issue** are defined, and terms with rival words carry an *Avoid* line.

### Changed

- `/jig:audit apply` takes several recommendations and groups them into as
  few pull requests as possible, one unless part of the work needs its own
  decision; it leaves the audit record's scores to the next audit.
- M7's PR-target safety lint reads each workflow as parsed YAML: checkout
  inputs in any letter case and only under `with:`, the trigger from the
  parsed `on:`, and any reference outside the base side counts as untrusted.
  A workflow that does not parse fails with exit 2.
- M2's referenced-paths check skips slash commands, quoted shell text and
  fenced code written with tildes or indented, and resolves a bare folder
  name against the folders git lists.
- `decide`'s worked example against Jig's own corpus expects the approved
  toolchain decision record as the precedent.
- The plugin test checks the vendored YAML parser's licence, and the
  freshness test checks M2's committed example index.
- `scripts/check-branch-protection.ts` checks Jig's branch policy: the
  `gates` check required, every review thread resolved before merging, no
  force-push or deletion. An approving review, administrator enforcement and
  an up-to-date branch are reported, not required, and remediation keeps them
  as they are. CONTRIBUTING.md states the policy; `main` now requires
  resolved threads.

## [0.18.1] - 2026-10-13

### Changed

- `/jig:audit`'s M0 criteria follow the module: `tool-deltas-are-pointers`
  observes an import of the universal file where the runtime supports one,
  and `per-directory-instructions` observes that nested files extend their
  parent rather than a closest-file-wins policy.
- `/jig:audit` observes the practices M9 and M10 now teach: M9's
  `memory-location-designated` looks for one authoritative work-state store
  and handoffs on the tracker item (a resumption file for the same
  worktree may stay in its scratch), and M10's
  `verification-separated-from-pr-gates` looks for suites placed per change
  only when a merge or the `verified` pointer waits for them.

## [0.18.0] - 2026-10-13

The groundwork for batching several small issues into one pull request
(`design/work-batch.md`, [ROADMAP.md](ROADMAP.md) item
13). Nothing a consumer has configured stops working.

### Added

- The tracker interface reads candidate pools: `openIssues` (a team's open
  issues by label conditions, including "carries none of these"),
  `openChildren` (the team's open children of one of its issues) and
  `poolIssue`. Each issue comes with its priority, creation time, state and
  assignee ids, labels, whether it has open children, and which nested lists
  were truncated. The Linear adapter implements them, refuses an empty label
  condition, which would read every open issue, and fails a read whose
  priority or children page it cannot read.
- `design/work-batch.md`: the design of a `work-batch`
  skill, moved from a working repository that uses it.

### Changed

- The change-area catalog's tracker block is `tracker:` (`tracker.labels`,
  `tracker.flags`), no longer `linear:`, in
  [M3](modules/M3-change-area-catalog/README.md)'s specification, example
  and template. `drive-pr`'s fleet-health sensor reads `tracker.labels` and
  still reads the older `linear.labels`, so a catalog can be renamed at any
  time. In the fields the sensor reads (`paths`, `generated` and its
  sources, `labels`, and the `tracker:`/`linear:` blocks with their
  `labels`), a value
  that is present but not the expected shape, `null` included, is refused;
  only an omitted field reads as empty. Other catalog fields are not
  validated by the sensor.
- The Linear adapter's `getIssue` fails a response that leaves out the
  issue, instead of reporting the issue as missing.

## [0.17.0] - 2026-10-13

The audit learns from its first live re-audit of Jig: it gathers the facts a
profile suggestion needs, shows the trend across past records and the gaps no
recommendation covers, and warns when a session runs an older plugin than the
one installed.

### Added

- `config-fit.ts` reports profile facts (human contributors in the last 90
  days and year, CI files that name deploy, release or publish work,
  compliance documents) and a `suggested_profile` with its reasons, lightest
  first: Solo/Lite for one person and no such CI file, Team/Standard
  otherwise, Regulated/Strict never on its own. The starter configuration
  gains `review.repo_slug` and `pull_requests.stacking` where the repository
  host proves them: stacking only from open pull requests based on another
  open pull request's branch.
- `config-fit.ts` warns (`fact:newer-plugin-installed`) when a newer version
  of the plugin is installed beside the one running (a version folder whose
  manifest names it): a session keeps the version it started with, so an
  update reaches the next session.
- The audit sheet:
  - **Trend**: `report.ts render --prior <record> --history <record>…` shows
    each module's level across past records, each measured against today's
    criteria without those added after its plugin version (a changed pass
    bar is read as it is now).
  - **Uncovered gaps**: a criterion within the target that no recommendation
    names and no held decline covers is marked in the map and listed;
    `report.ts validate` warns about each.
  - **Profile signals**: the report source's `profile.signals` lists facts
    worth revisiting the profile for, shown beside the profile.
  - "Decided by a probe" only for a score the probe wrote (`probe: `
    evidence).
  - **Conditional targets**: the profile's conditional targets, and those of
    the profile it is heading to, are checkboxes beside the profile
    selector, copied as `profile_conditions`; `apply-feedback` sets them in
    the record.
  - **Flag a score**: any criterion's score can be marked wrong with a note,
    copied as `scores:`; `apply-feedback` prints it as a calibration note and
    never changes the score.
  - With a profile, "Since the last audit" counts and lists the criteria
    still open within the target apart from those beyond it.
  - **A guide inside the sheet**: what Jig and the audit are, the
    enforcement ladder, the modules, the profiles with each one's
    target per module, how the audit works and how to read the report. It
    opens as its own view from the top bar (`#guide`), and is the last
    section without a script and in print. A first audit opens with a
    welcome that points to it.
  - **Icons and explanations**: each criterion in the maturity map is an
    icon for its rung (Lucide icons, inlined with their ISC licence, no
    network request) with a popover giving the criterion, its score and
    where it stands against the profile; every module ID is one chip with a
    popover naming the module and what it solves.
  - "Since the last audit" is a table with colour-coded changes and count
    badges.

### Changed

- `record.ts apply-feedback` ranks the accepted work as the sheet's Start
  here does (leverage × effort, then a quick win, then the report's order),
  no longer configuration first and in adoption order.
- A module the plugin added after an earlier audit reads as incomplete at
  that audit, in the comparison and the trend, no longer as Strict.
- M3's `consumer-view-generated` criterion accepts a view derived from the
  catalog on every run, as CI area flags are, besides a committed copy with a
  freshness gate, as the module's reference already did.

## [0.16.1] - 2026-10-13

Faster tests and a CI that runs only what a pull request's changes need.
Nothing in a consumer's configuration or a skill's behaviour changes.

### Added

- Jig's own change-area catalog, `.config/change-areas.yaml`
  ([M3](modules/M3-change-area-catalog/README.md)), resolved by
  `scripts/change-areas.ts`. CI selects its jobs from it: the drive-pr suite
  runs when the drive-pr skill or something it depends on changed, and macOS
  and Windows run the gate set when anything outside documentation changed;
  Linux always runs the whole gate set, and a push to `main` runs everything.
  `bun run gates` fails when the catalog is malformed or a file belongs to no
  area. `.config/jig.yaml` names the catalog in `drive.change_areas_catalog`.

### Changed

- `bun run test` runs test files in parallel, one per processor core.
- The longest test files of `drive-pr` and `resolve-review-comments` are
  split into several shorter ones, so parallel runs and CI shards are no
  longer held up by one file.
- Fixed waits in the skills' scripts (final-CI polling, kill grace periods,
  lock heartbeats and waits, polling intervals) can be shortened through
  environment variables the test suites set; the production values are
  unchanged and a variable can only lower its wait. They are internal test
  settings, not configuration.

### Fixed

- The drive-pr test harness kept its own lock pacing out of the scripts it
  spawned, so those tests waited at the production lock interval.

## [0.16.0] - 2026-10-13

The audit's result becomes an **audit sheet**: a polished HTML report a team
reads, decides on and hands back to the agent. A repository declares the
profile it aims for, and the audit recommends toward that target and no
further.

### Added

- The audit sheet ([format](plugin/skills/audit/references/report-sheet.md)):
  `report.ts render` turns the report source an audit writes, the record and
  the configuration-fit report into one self-contained HTML file and the same
  report as Markdown. It opens with the summary and a maturity map against the
  target, then the moves that matter most, what changed since the last audit,
  the recommendations grouped as *now*, *as you grow* and *optional*, every
  criterion with how it was decided and its evidence, configuration fit with a
  starter configuration, drift, and what was examined and what could not be
  checked. Each recommendation can be accepted, taken in its lighter form,
  refined, declined with a reason and a revisit condition, or marked *this is
  wrong*; **Copy decisions** writes them as one block for the agent.
  `report.ts validate` and `extract` check a source and recover everything a
  sheet was rendered from.
- [`profiles.yaml`](plugin/skills/audit/profiles.yaml): each profile's
  target level per module, conditional targets (M12 when agents work in
  parallel workspaces, M3 when a change's implications stop being obvious)
  and the order to adopt modules in. The record gains `profile:` and
  `profile_conditions:`; `record.ts check` refuses an unknown profile or
  condition, and `record.ts summary` shows the target and the gap.
- Each module's criteria file states its `purpose` in one sentence.
- Proportion: the record's `heading_to` names the profile a project is
  growing toward, and a recommendation may name a `lighter` option. The audit
  recommends toward the declared profile and no further; without one it
  suggests the lightest profile the repository's facts support.
- `record.ts apply-feedback <file|-> --report <source.json|sheet.html>`
  records the decisions copied from the audit sheet: it refuses a block written for
  another repository, commit or report (and an option it does not know, and
  accepted or refined work on a criterion the record holds declined), adds
  each decline to the record's `declined` list, or renews the entry that
  already declines the same refs, with every comment in the file and every
  other key of the entry kept (two declines of the same refs in one block must
  agree; a kept key's value must be one JSON can hold, so a date in one is
  quoted), sets the
  profile when
  the team changed it, and prints the accepted and refined work in adoption
  order, after the report's drift, and each *this is wrong* as a calibration
  note.
- `config-fit.ts --draft` prints a starter `.config/jig.yaml` (or the
  additions to an existing one) from the values the repository implies, each
  with the evidence it came from, never a default (a review bot whose
  account type cannot be read is reported unchecked, not suggested); an addition to a section
  the file already has says to merge it there. `--json` carries it as
  `draft`. The configuration schema gains `default`.

### Changed

- **Breaking:** a key of a `declined` entry in `.config/jig-audit.yaml`
  beyond `refs`, `reason`, `revisit_when` and `revisit_after` is now kept, so
  its value must be text, a finite number, `true`, `false`, `null`, or a list
  or mapping of those, and no list or mapping may appear twice among one
  entry's kept keys (a YAML alias to one does that; an alias to text or a
  number is fine); every `record.ts` command refuses the record otherwise.
  Before updating, quote a date in such a key (`reviewed_on: "2026-10-01"`),
  replace an infinite number, and write out a repeated list or mapping.
- `/jig:audit` ends with the audit sheet instead of a report written from
  `references/report-template.md`, which is gone: the sheet's Markdown copy is
  the text form. The skill asks for the team's profile on a first audit and
  records the decisions pasted back from the sheet.

## [0.15.0] - 2026-10-12

The auditor becomes a plugin skill, `/jig:audit`, that a repository runs again
and again. Nothing in a consumer's configuration changes.

### Added

- `/jig:audit` ([audit skill](plugin/skills/audit/README.md)): checks the
  repository's `.config/jig.yaml` against the repository, scores every
  module's maturity criteria with file-path evidence, writes the result to
  `.config/jig-audit.yaml`, and on a re-run reports what was fixed, regressed,
  is still open or was added by Jig since, without repeating a recommendation
  the team declined until its revisit condition holds. Read-only unless asked
  to apply one recommendation, which opens one pull request through
  `do-item`'s pull-request policy. `/jig:audit portfolio` compares several
  repositories' records.
- `config-fit.ts`: unknown, refused, deprecated and mistyped fields, what the
  skills' own validation rejects, commands and paths that do not exist, an
  unknown integration branch, required checks that never ran on recent merged
  pull requests, missing pull-request labels, an unreachable tracker, declared
  values the repository contradicts (`stacking: none` with stacked pull
  requests open, a declared reviewer that reviews nothing), and settings the
  repository suggests (a gate command, a change-area catalog, reviewers, the
  issue-key prefix). A command is checked as a shell would run it: a line
  the shell refuses, every `make` target, a bare `yarn`, `pnpm` or `bun`
  script, a program file that is missing, not executable or not tracked; what
  runs after a `cd` or in another directory, through `env` or `exec` with an
  option, or on a line using shell syntax beyond plain words, quotes and
  `&&`, `||`, `;` and `|` (a line break, an escape, a comment, an expansion,
  a glob, a tilde, a redirection) is reported unchecked, unless that line is
  one the shell refuses anyway. Without
  forge access the forge questions are unchecked, never passing. A decline in
  the audit record never hides an error, nor, from `check-audit-fit.ts`, an
  unknown key. It judges the repository's file alone, never the user file
  or `JIG__*` variables of whoever runs it, and reports what those add on
  that machine.
- A machine-readable configuration schema,
  [`config-schema.yaml`](plugin/skills/audit/config-schema.yaml), listing every
  field with its type, readers, deprecation and whether only a repository may
  set it. Tests fail when it and
  [CONFIGURATION.md](plugin/CONFIGURATION.md) list different fields or
  readers, or when its value sets differ from the reading skills' own.
- Optional `probe`s on maturity criteria (a necessary condition a file search
  can rule out, which scores the criterion `absent` when it does not hold, and
  leaves it unchecked when a file was too large to search) and
  `since:` markers on criteria and configuration fields, so a re-audit tells
  what Jig added from what the repository lost.
- M1 criterion `existing-findings-ratcheted` (Strict): a rule that still has
  findings is ratcheted against the merge base and promoted at zero.
- Jig's own audit record, [`.config/jig-audit.yaml`](.config/jig-audit.yaml),
  and a [calibration run](plugin/skills/audit/calibration/2026-10-12-execa.md)
  of the skill against an external library.

### Changed

- The modules' maturity criteria moved from `modules/M<n>-<name>/maturity.yaml`
  to [`plugin/skills/audit/criteria/`](plugin/skills/audit/criteria/README.md),
  and the auditor's method, survey prompts, templates and calibration run from
  `audit/` into the skill; `audit/score-modules.ts` is now the skill's
  `score.ts`. Each module README links its criteria file.
## [0.14.0] - 2026-10-12

### Added

- **Configuration layers.** Below the repository's `.config/jig.yaml`, every
  skill now reads `~/.jig/jig.yaml` (`JIG_HOME` moves the folder) for a
  person's or a machine's own values, and above it `JIG__<SECTION>__<FIELD>`
  environment variables for one run. Sections merge field by field; other
  values replace. The user file refuses the fields that describe one
  repository (`gates.command`, `repository.base_branch`, `issue_tracker.team`,
  `review.repo_slug`, `review.repo_label`, `ci.required_checks`). A layer (a
  file, or the environment variables together) may not hold a `__proto__`
  key, a value that contains itself, or more than 10,000 values once its
  aliases are expanded. A user file
  alone does not make a repository adopted. `JIG_USER_LAYER=off` leaves the
  user file out, and the independent review sets it so that its policy comes
  from the base branch alone. See
  [configuration layers](plugin/CONFIGURATION.md#configuration-layers).
- `resolve-review-comments/scripts/jig-config.ts` prints every field set in
  any layer, its value and the file or variable that set it; a key that
  holds a dot is written in quotes.

### Changed

- Every skill reads its configuration through one shared reader. Errors about
  a field name the file or variable that set it, not always the repository's
  file. An empty `.config/jig.yaml` is read as no values instead of being
  refused.
- `github-actions`, `promote-memory`, `design-brief-builder` and `descar`
  have the agent read their values with `jig-config.ts` rather than from
  `.config/jig.yaml`, so the user file and the environment apply to them too.

## [0.13.0] - 2026-10-12

The plugin's scripts run on Bun only, and Jig's own code now passes a
ratchet: the findings it already has are tolerated, new ones fail the gates.

### Changed

- **Breaking:** the plugin's scripts run on Bun only. They were also
  documented to run with `node <script>.ts` on Node 22.18 or later; that is
  no longer supported or tested. A machine that started a script with `node`
  starts it with `bun`. Jig tests with Bun 1.4.3. `programmatic-execution`,
  whose analysis scripts run with whatever runtime a machine has, accepts Bun
  or Node 24 or later (was Node 22.18).
- Scripts recognise their own entry point with `import.meta.main`, so a script
  started through a symlinked path (a symlinked checkout, a skills directory
  of links) still runs.
- `review` lists every `Ratchet-Loosen` commit trailer in its summary for a
  person to confirm.
- do-item's scripts exit 1 with the error and its stack when an unexpected
  error escapes them, instead of leaving it to the runtime's unhandled
  rejection.

### Added

- M1's **ratchet gate**
  ([`reference/ratchet/`](modules/M1-gates-enforcement-ladder/reference/ratchet/README.md)):
  counts findings per rule in the working tree and in the merge base, fails
  when a count grows or a configuration loosens a rule without a
  `Ratchet-Loosen: <rule>: <reason>` commit trailer, and reports rules ready
  to become errors. A loosening includes an override or a narrowed file
  scope, a reordered include list or override, any change to a setting it
  does not rank in a configuration file it already compares, a counter,
  configuration file or support path dropped or changed in the ratchet's own
  wiring, and a support path added there. M1's README places it between advisory and blocking.
- Jig's gates gain Biome rules (floating promises, misused promises,
  parameter properties, enums and namespaces as errors; empty blocks
  ratcheted), GritQL rules in `tools/quality/grit/` with their own
  fixtures (unchecked `JSON.parse` casts, `catch` blocks that drop the error
  and return a default, discarded child-process error output, local copies of
  record guards, `process.exit` where the command-line boundary sets the exit
  code, ad hoc
  process signal handlers), fallow (unused files, exports and dependencies;
  complexity and duplication of the changed files against the merge base),
  and stricter compiler settings (`erasableSyntaxOnly`, `noImplicitOverride`,
  `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`), with
  `exactOptionalPropertyTypes` ratcheted.

### Fixed

- This repository's own `.config/jig.yaml` labels its follow-ups `jig`
  (was `groundwork`, a label the tracker no longer has) and names `sourcebook`
  among the repository labels; the follow-up and epic labels move to
  `issue_tracker.labels`, and agents file issues through the Linear tool.
- `bun run typecheck` ran TypeScript 6, not the pinned TypeScript 7: a second
  package's `tsc` shadowed it. Type checking now uses `bun check`, which
  reports TypeScript 7's errors, and TypeScript 6 is no longer installed; the
  terminal-states consistency check uses TypeScript 7's compiler API.

## [0.12.0] - 2026-10-12

Groundwork is renamed **Jig**. Every machine and every repository that uses
the plugin follows the steps in
[Moving from the `groundwork` plugin](plugin/README.md#moving-from-the-groundwork-plugin):
on each machine, stop the drives, run `bun tools/plugin/setup.ts`, remove the
old plugin and rename the `GROUNDWORK_*` variables; in each repository, rename
the configuration file and the `/groundwork:` commands. **There is no
transition period: no old name is read, so nothing falls back and nothing
warns.**

### Changed

- **Breaking:** the plugin and both marketplaces are `jig@jig` (were
  `groundwork@groundwork`), and every command is `/jig:<skill>` (was
  `/groundwork:<skill>`); the review arbiter agent is `jig:review-arbiter`.
  `tools/plugin/setup.ts` installs `jig@jig` and does not touch
  `groundwork@groundwork`; remove that and the `groundwork` marketplace by
  hand. A repository that enables the plugin by id in `.claude/settings.json`
  changes the id.
- **Breaking:** the repository moves to `https://github.com/docomply/jig`;
  install commands, marketplace sources and links use the new address.
- **Breaking:** the configuration file is `.config/jig.yaml`
  (was `.config/groundwork-overlay.yaml`); the old file is not read, and a
  repository that still has only the old one is reported as unconfigured.
- **Breaking:** environment variables are `JIG_*` (were `GROUNDWORK_*`); the
  old names are not read. Variables only this repository's own tests and
  gates read (`JIG_GATES_SKIP_SEPARATE_SUITES`, `JIG_TEST_TMPDIR`,
  `JIG_BASH_PARITY`, `JIG_REQUIRE_BROWSER`, `JIG_MARKETPLACE`,
  `JIG_SETUP_TIMEOUT_SECONDS`) are renamed the same way.
- **Breaking:** default locations move from `groundwork` to `jig`, and nothing
  is read from the old ones: the drive state
  (`~/.local/state/jig/drive-pr/`, so a drive starts from empty state unless
  `migrate-state-dir.ts --from ~/.local/state/groundwork/drive-pr` moved it),
  the fleet-health snapshot folder (`~/.local/state/jig/dashboard`), the
  verification-fit log, the GitHub answer cache (`~/.cache/jig/gh-cache`) and
  the `resolve-conflicts` snapshot (`<git-dir>/jig/conflicts.json`). A
  machine that sets `DRIVE_PR_STATE_DIR` is not affected by the first.
- The roadmap queues the rename, the licence, skill assets in the plugin, the
  kickoff family of skills and a changelog skill ahead of the auditor skill.

### Added

- The Jig logo: a horizontal lockup heads the README, and the round mark is
  the plugin's icon in both tools (`assets/brand/`, `plugin/assets/`).

## [0.11.0] - 2026-10-12

### Added

- `resolve-conflicts` skill: resolves the conflicts a merge, rebase or
  cherry-pick stopped on. `conflict-map.ts` names each side by its role (the
  branch or the upstream, so a rebase's reversed "ours" and "theirs" cannot
  mislead), classifies every conflicted path (text, lockfile, generated,
  binary) and lists the commits on each side that changed it.
  `check-resolution.ts` refuses a resolution that leaves conflict markers or
  unmerged paths, lacks a recorded decision, or drops lines either side added
  without saying why, and prints the decisions for the merge commit message.
  Configuration: `resolve_conflicts.generated`.
- `drive-pr` hands a conflicting pull request to `resolve-conflicts` in its
  conflict-repair round.
- [Recommended third-party skills](plugin/RECOMMENDED-SKILLS.md) that work well
  with Groundwork, and credits for the outside work Groundwork's own skills
  build on.
- This changelog, and a gate that requires an entry for the current plugin
  version.
- Nested agent instructions: [plugin/AGENTS.md](plugin/AGENTS.md) and
  [modules/AGENTS.md](modules/AGENTS.md).
- [CONFIGURATION.md](plugin/CONFIGURATION.md) documents the review-triage file
  (`.config/review-triage.yaml`) and every environment variable the skills
  read; the drive-pr README lists its tunable limits and every exit state.

### Changed

- Groundwork's content no longer names the organization it was extracted from,
  and code comments, test names and documents no longer carry review
  provenance (reviewer names, pull-request numbers and review rounds of the
  original repository). The rationale they annotated stays. The
  issue-tracker reference gate now also rejects the organization's name outside
  the repository's own address and publisher fields. An allow pattern exempts
  only the text it matches, not the rest of its line.
- M10's verified-pointer watchdog measures `AGE_SECONDS` as how long the
  oldest commit not yet verified has waited (`0` when the pointer is at the
  tip), not the age of the verified commit, which read a quiet branch as
  stalled. Copied recipes change their `AGE_SECONDS` line to the one in
  [mappings.md](modules/M10-environments-deploy/mappings.md).
- M11's `heartbeat` event requires the `emitter` it speaks for.
- The roadmap lists only work that is still open; finished phases are recorded
  here and in git history.
- Module READMEs end in a **Status** section (what the module provides, what
  it leaves out and why, what is future) and link the plugin skills that run
  their practice; the skills link back.
- The plugin README's installer-migration section is cut to the steps a
  repository still on a `v0.1.x-review-pilot` tag needs.

### Fixed

- M7's thread-state exporter reads the `wont-fix` verdict
  `resolve-review-comments` writes as `rejected`, instead of `unclassified`,
  which failed the unresolved-threads gate on correctly settled threads.
- Documentation that named files, flags, exit codes or configuration fields
  that do not exist, or described defaults wrongly, across the modules, the
  plugin and its skills.

### Removed

- The founding charter (`docs/founding-charter-2026-07-18.md`). It analysed the
  original repository's practices; what Groundwork took from it lives in
  [principles/](principles/), [modules/](modules/README.md) and
  [audit/](audit/README.md).

## [0.10.0] - 2026-10-12

### Added

- `decide` skill: settles a technical dilemma against the repository's existing
  decisions, then rules or escalates to a human with a cited decision sheet.
  Includes a TypeScript port of a Simplified Technical English linter
  (`ste-lint`), whose output matched the original Python implementation's on
  874 files.
- `explain` skill: writes a cited, commit-dated explainer sheet (HTML and
  Markdown) of how part of a system works today.

## [0.9.1] - 2026-10-11

### Fixed

- `drive-pr` on stacked pull requests: a round's validation plan and change set
  use the pull request's own base, so an upper layer's plan covers that layer
  alone, and a stacked layer's required checks are its base's plus those of the
  branch the stack's bottom layer targets.

## [0.9.0] - 2026-10-11

### Changed

- **Breaking:** the `do-issue` skill is renamed `do-item`
  (`/groundwork:do-item`), and its configuration section `do_issue` is renamed
  `do_item`. A `do_issue` section is no longer read; the skill stops and names
  the rename. Update instructions and configuration before machines update.

## [0.8.0] - 2026-10-11

### Added

- `issue_tracker.labels`: the label each role the skills act on maps to (epic,
  human-in-the-loop flag and facets, manual operations, review follow-up, bug,
  pattern prefix, batch sizes, the tails an epic may hand off).
- `issue_tracker.states`: the tracker's own state names, read by the
  parent-status reconciliation.

## [0.7.0] - 2026-10-11

### Added

- `pull_requests`: a declared policy for how agents open pull requests
  (stacking, stack depth, branch names, draft or Ready, when the drive marks a
  draft Ready, issue link, size budget, labels), applied by `do-issue`'s
  `pr-plan.ts`.
- [plugin/CONFIGURATION.md](plugin/CONFIGURATION.md): every configuration field
  in one reference.

### Changed

- **Breaking:** a repository that stacks pull requests must declare
  `pull_requests.stacking`; without it the skills refuse to stack.

## [0.6.0] - 2026-10-11

### Added

- Procedure skills: `review`, `fix-ci`, `github-actions`, `adr`, `descar`,
  `promote-memory`, `programmatic-execution` and `design-brief-builder`. Their
  shell and Python helpers are Bun scripts with tests.

## [0.5.0] - 2026-10-11

### Changed

- **Breaking:** the CI checks a drive waits for come from
  `ci.required_checks`, or by default from the base branch's protection, and
  the CI hold is opt-in through `ci.hold_label`. A repository that relies on
  the hold sets both before its machines update; a drive that still owns a hold
  label without that configuration stops and names the missing setting.
- The AI reviewer's check name and comment markers are `review.*` fields.

## [0.3.0] - 2026-10-10

### Added

- `drive-pr` skill: runs a pull request's review rounds unattended until it
  reaches one named end state, including its fleet-health and loop-metrics
  reports.
- `do-issue` skill: picks up a tracker item and carries it to a driven pull
  request, through a tracker interface with a Linear adapter.
- `review-arbiter` agent: rules on contested review findings.

## [0.2.0] - 2026-10-09

### Added

- The `groundwork` plugin for Claude Code and Codex, installed once per
  machine, with `resolve-review-comments` as its first skill. A repository
  commits only its values, in `.config/groundwork-overlay.yaml`.

### Removed

- The per-worktree installer (pinned release, host cache, rendered adapters,
  links and a git hook). The `v0.1.x-review-pilot` releases stay tagged for
  repositories that have not migrated.

## [0.1.1-review-pilot] - 2026-10-06

### Fixed

- The packaged review skill keeps its TypeScript type contracts.

## [0.1.0-review-pilot] - 2026-10-06

### Added

- First packaged release of the `resolve-review-comments` skill, installed per
  worktree from a pinned release.

[Unreleased]: https://github.com/jig-harness/jig/compare/v0.115.0...HEAD
[0.115.0]: https://github.com/jig-harness/jig/compare/v0.114.0...v0.115.0
[0.114.0]: https://github.com/jig-harness/jig/compare/v0.113.0...v0.114.0
[0.113.0]: https://github.com/jig-harness/jig/compare/v0.112.0...v0.113.0
[0.112.0]: https://github.com/jig-harness/jig/compare/v0.111.0...v0.112.0
[0.111.0]: https://github.com/jig-harness/jig/compare/v0.110.0...v0.111.0
[0.110.0]: https://github.com/jig-harness/jig/compare/v0.109.0...v0.110.0
[0.109.0]: https://github.com/jig-harness/jig/compare/v0.108.0...v0.109.0
[0.108.0]: https://github.com/jig-harness/jig/compare/v0.107.0...v0.108.0
[0.107.0]: https://github.com/jig-harness/jig/compare/v0.106.0...v0.107.0
[0.106.0]: https://github.com/jig-harness/jig/compare/v0.105.0...v0.106.0
[0.105.0]: https://github.com/jig-harness/jig/compare/v0.104.1...v0.105.0
[0.104.1]: https://github.com/jig-harness/jig/compare/v0.104.0...v0.104.1
[0.104.0]: https://github.com/jig-harness/jig/compare/v0.103.0...v0.104.0
[0.103.0]: https://github.com/jig-harness/jig/compare/v0.102.0...v0.103.0
[0.102.0]: https://github.com/jig-harness/jig/compare/v0.101.1...v0.102.0
[0.101.1]: https://github.com/jig-harness/jig/compare/v0.101.0...v0.101.1
[0.101.0]: https://github.com/jig-harness/jig/compare/v0.100.0...v0.101.0
[0.100.0]: https://github.com/jig-harness/jig/compare/v0.99.0...v0.100.0
[0.99.0]: https://github.com/jig-harness/jig/compare/v0.98.0...v0.99.0
[0.98.0]: https://github.com/jig-harness/jig/compare/v0.97.2...v0.98.0
[0.97.2]: https://github.com/jig-harness/jig/compare/v0.97.1...v0.97.2
[0.97.1]: https://github.com/jig-harness/jig/compare/v0.97.0...v0.97.1
[0.97.0]: https://github.com/jig-harness/jig/compare/v0.96.0...v0.97.0
[0.96.0]: https://github.com/jig-harness/jig/compare/v0.95.0...v0.96.0
[0.95.0]: https://github.com/jig-harness/jig/compare/v0.94.2...v0.95.0
[0.94.2]: https://github.com/jig-harness/jig/compare/v0.94.1...v0.94.2
[0.94.1]: https://github.com/jig-harness/jig/compare/v0.94.0...v0.94.1
[0.94.0]: https://github.com/jig-harness/jig/compare/v0.93.0...v0.94.0
[0.93.0]: https://github.com/jig-harness/jig/compare/v0.92.0...v0.93.0
[0.92.0]: https://github.com/jig-harness/jig/compare/v0.91.3...v0.92.0
[0.91.3]: https://github.com/jig-harness/jig/compare/v0.91.2...v0.91.3
[0.91.2]: https://github.com/jig-harness/jig/compare/v0.91.1...v0.91.2
[0.91.1]: https://github.com/jig-harness/jig/compare/v0.91.0...v0.91.1
[0.91.0]: https://github.com/jig-harness/jig/compare/v0.90.0...v0.91.0
[0.90.0]: https://github.com/jig-harness/jig/compare/v0.89.0...v0.90.0
[0.89.0]: https://github.com/jig-harness/jig/compare/v0.88.0...v0.89.0
[0.88.0]: https://github.com/jig-harness/jig/compare/v0.87.2...v0.88.0
[0.87.2]: https://github.com/jig-harness/jig/compare/v0.87.1...v0.87.2
[0.87.1]: https://github.com/jig-harness/jig/compare/v0.87.0...v0.87.1
[0.87.0]: https://github.com/jig-harness/jig/compare/v0.86.0...v0.87.0
[0.86.0]: https://github.com/jig-harness/jig/compare/v0.85.3...v0.86.0
[0.85.3]: https://github.com/jig-harness/jig/compare/v0.85.2...v0.85.3
[0.85.2]: https://github.com/jig-harness/jig/compare/v0.85.1...v0.85.2
[0.85.1]: https://github.com/jig-harness/jig/compare/v0.85.0...v0.85.1
[0.85.0]: https://github.com/jig-harness/jig/compare/v0.84.0...v0.85.0
[0.84.0]: https://github.com/jig-harness/jig/compare/v0.83.2...v0.84.0
[0.83.2]: https://github.com/jig-harness/jig/compare/v0.83.1...v0.83.2
[0.83.1]: https://github.com/jig-harness/jig/compare/v0.83.0...v0.83.1
[0.83.0]: https://github.com/jig-harness/jig/compare/v0.82.0...v0.83.0
[0.82.0]: https://github.com/jig-harness/jig/compare/v0.81.2...v0.82.0
[0.81.2]: https://github.com/jig-harness/jig/compare/v0.81.1...v0.81.2
[0.81.1]: https://github.com/jig-harness/jig/compare/v0.81.0...v0.81.1
[0.81.0]: https://github.com/jig-harness/jig/compare/v0.80.0...v0.81.0
[0.80.0]: https://github.com/jig-harness/jig/compare/v0.79.1...v0.80.0
[0.79.1]: https://github.com/jig-harness/jig/compare/v0.79.0...v0.79.1
[0.79.0]: https://github.com/jig-harness/jig/compare/v0.78.0...v0.79.0
[0.78.0]: https://github.com/jig-harness/jig/compare/v0.77.0...v0.78.0
[0.77.0]: https://github.com/jig-harness/jig/compare/v0.76.0...v0.77.0
[0.76.0]: https://github.com/jig-harness/jig/compare/v0.75.0...v0.76.0
[0.75.0]: https://github.com/jig-harness/jig/compare/v0.74.0...v0.75.0
[0.74.0]: https://github.com/jig-harness/jig/compare/v0.73.0...v0.74.0
[0.73.0]: https://github.com/jig-harness/jig/compare/v0.72.0...v0.73.0
[0.72.0]: https://github.com/jig-harness/jig/compare/v0.71.0...v0.72.0
[0.71.0]: https://github.com/jig-harness/jig/compare/v0.70.2...v0.71.0
[0.70.2]: https://github.com/jig-harness/jig/compare/v0.70.1...v0.70.2
[0.70.1]: https://github.com/jig-harness/jig/compare/v0.70.0...v0.70.1
[0.70.0]: https://github.com/jig-harness/jig/compare/v0.69.0...v0.70.0
[0.69.0]: https://github.com/jig-harness/jig/compare/v0.68.0...v0.69.0
[0.68.0]: https://github.com/jig-harness/jig/compare/v0.67.0...v0.68.0
[0.67.0]: https://github.com/jig-harness/jig/compare/v0.66.1...v0.67.0
[0.66.1]: https://github.com/jig-harness/jig/compare/v0.66.0...v0.66.1
[0.66.0]: https://github.com/jig-harness/jig/compare/v0.65.1...v0.66.0
[0.65.1]: https://github.com/jig-harness/jig/compare/v0.65.0...v0.65.1
[0.65.0]: https://github.com/jig-harness/jig/compare/v0.64.0...v0.65.0
[0.64.0]: https://github.com/jig-harness/jig/compare/v0.63.0...v0.64.0
[0.63.0]: https://github.com/jig-harness/jig/compare/v0.62.0...v0.63.0
[0.62.0]: https://github.com/jig-harness/jig/compare/v0.61.1...v0.62.0
[0.61.1]: https://github.com/jig-harness/jig/compare/v0.61.0...v0.61.1
[0.61.0]: https://github.com/jig-harness/jig/compare/v0.60.0...v0.61.0
[0.60.0]: https://github.com/jig-harness/jig/compare/v0.59.0...v0.60.0
[0.59.0]: https://github.com/jig-harness/jig/compare/v0.58.1...v0.59.0
[0.58.1]: https://github.com/jig-harness/jig/compare/v0.58.0...v0.58.1
[0.58.0]: https://github.com/jig-harness/jig/compare/v0.57.0...v0.58.0
[0.57.0]: https://github.com/jig-harness/jig/compare/v0.56.1...v0.57.0
[0.56.1]: https://github.com/jig-harness/jig/compare/v0.56.0...v0.56.1
[0.56.0]: https://github.com/jig-harness/jig/compare/v0.55.0...v0.56.0
[0.55.0]: https://github.com/jig-harness/jig/compare/v0.54.0...v0.55.0
[0.54.0]: https://github.com/jig-harness/jig/compare/v0.53.0...v0.54.0
[0.53.0]: https://github.com/jig-harness/jig/compare/v0.52.1...v0.53.0
[0.52.1]: https://github.com/jig-harness/jig/compare/v0.52.0...v0.52.1
[0.52.0]: https://github.com/jig-harness/jig/compare/v0.51.1...v0.52.0
[0.51.1]: https://github.com/jig-harness/jig/compare/v0.51.0...v0.51.1
[0.51.0]: https://github.com/jig-harness/jig/compare/v0.50.0...v0.51.0
[0.50.0]: https://github.com/jig-harness/jig/compare/v0.49.0...v0.50.0
[0.49.0]: https://github.com/jig-harness/jig/compare/v0.48.1...v0.49.0
[0.48.1]: https://github.com/jig-harness/jig/compare/v0.48.0...v0.48.1
[0.48.0]: https://github.com/jig-harness/jig/compare/v0.47.0...v0.48.0
[0.47.0]: https://github.com/jig-harness/jig/compare/v0.46.0...v0.47.0
[0.46.0]: https://github.com/jig-harness/jig/compare/v0.45.0...v0.46.0
[0.45.0]: https://github.com/jig-harness/jig/compare/v0.44.0...v0.45.0
[0.44.0]: https://github.com/jig-harness/jig/compare/v0.43.0...v0.44.0
[0.43.0]: https://github.com/jig-harness/jig/compare/v0.42.0...v0.43.0
[0.42.0]: https://github.com/jig-harness/jig/compare/v0.41.0...v0.42.0
[0.41.0]: https://github.com/jig-harness/jig/compare/v0.40.0...v0.41.0
[0.40.0]: https://github.com/jig-harness/jig/compare/v0.39.0...v0.40.0
[0.39.0]: https://github.com/jig-harness/jig/compare/v0.38.0...v0.39.0
[0.38.0]: https://github.com/jig-harness/jig/compare/v0.37.3...v0.38.0
[0.37.3]: https://github.com/jig-harness/jig/compare/v0.37.2...v0.37.3
[0.37.2]: https://github.com/jig-harness/jig/compare/v0.37.1...v0.37.2
[0.37.1]: https://github.com/jig-harness/jig/compare/v0.37.0...v0.37.1
[0.37.0]: https://github.com/jig-harness/jig/compare/v0.36.0...v0.37.0
[0.36.0]: https://github.com/jig-harness/jig/compare/v0.35.2...v0.36.0
[0.35.2]: https://github.com/jig-harness/jig/compare/v0.35.1...v0.35.2
[0.35.1]: https://github.com/jig-harness/jig/compare/v0.35.0...v0.35.1
[0.35.0]: https://github.com/jig-harness/jig/compare/v0.34.0...v0.35.0
[0.34.0]: https://github.com/jig-harness/jig/compare/v0.33.1...v0.34.0
[0.33.1]: https://github.com/jig-harness/jig/compare/v0.33.0...v0.33.1
[0.33.0]: https://github.com/jig-harness/jig/compare/v0.32.1...v0.33.0
[0.32.1]: https://github.com/jig-harness/jig/compare/v0.32.0...v0.32.1
[0.32.0]: https://github.com/jig-harness/jig/compare/v0.31.1...v0.32.0
[0.31.1]: https://github.com/jig-harness/jig/compare/v0.31.0...v0.31.1
[0.31.0]: https://github.com/jig-harness/jig/compare/v0.30.0...v0.31.0
[0.30.0]: https://github.com/jig-harness/jig/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/jig-harness/jig/compare/v0.28.1...v0.29.0
[0.28.1]: https://github.com/jig-harness/jig/compare/v0.28.0...v0.28.1
[0.28.0]: https://github.com/jig-harness/jig/compare/v0.27.1...v0.28.0
[0.27.1]: https://github.com/jig-harness/jig/compare/v0.27.0...v0.27.1
[0.27.0]: https://github.com/jig-harness/jig/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/jig-harness/jig/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/jig-harness/jig/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/jig-harness/jig/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/jig-harness/jig/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/jig-harness/jig/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/jig-harness/jig/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/jig-harness/jig/compare/v0.19.1...v0.20.0
[0.19.1]: https://github.com/jig-harness/jig/compare/v0.19.0...v0.19.1
[0.19.0]: https://github.com/jig-harness/jig/compare/v0.18.3...v0.19.0
[0.18.3]: https://github.com/jig-harness/jig/compare/v0.18.2...v0.18.3
[0.18.2]: https://github.com/jig-harness/jig/compare/v0.18.1...v0.18.2
[0.18.1]: https://github.com/jig-harness/jig/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/jig-harness/jig/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/jig-harness/jig/compare/v0.16.1...v0.17.0
[0.16.1]: https://github.com/jig-harness/jig/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/jig-harness/jig/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/jig-harness/jig/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/jig-harness/jig/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/jig-harness/jig/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/jig-harness/jig/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/jig-harness/jig/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/jig-harness/jig/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/jig-harness/jig/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/jig-harness/jig/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/jig-harness/jig/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/jig-harness/jig/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/jig-harness/jig/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/jig-harness/jig/compare/v0.3.0...v0.5.0
[0.3.0]: https://github.com/jig-harness/jig/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jig-harness/jig/compare/v0.1.1-review-pilot...v0.2.0
[0.1.1-review-pilot]: https://github.com/jig-harness/jig/compare/v0.1.0-review-pilot...v0.1.1-review-pilot
[0.1.0-review-pilot]: https://github.com/jig-harness/jig/releases/tag/v0.1.0-review-pilot
