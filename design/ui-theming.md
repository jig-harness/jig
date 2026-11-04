# One look for Jig's pages, and a theme a repository can set: design

**What problem this solves.** Jig's tooling draws several pages a person
reads in a browser: the dispatch dashboard (`jig dispatch dashboard`), the
decision sheet (`decide`), the explainer sheet (`explain`), the audit sheet
(`audit`) and the code-stats report (`code-stats`). Each picks its own
colours. The dashboard wears Jig's look (warm paper, green accent, light and
dark), the sheets share a neutral grey and blue in light only, and the
code-stats report has a blue of its own in both modes. Only the dashboard
carries Jig's mark as its icon. A reader moving from one page to the next
sees three products, a reader whose system is dark gets a white sheet, and a
team that wants the pages to look like its own tools has nothing to change.
With this built, every page wears one look in both modes and carries the
mark, and a team can give its pages its own accent colour and mark.

This is the design of [plan.md](plan.md) item 36 (one look) and of the
plan's later item, a repository's theme. The dashboard's icon is built:
`dashboard/build.ts` inlines the adaptive mark.

## How it works

### The pages and how each is drawn

| Page | Drawn | Colours today | Dark mode |
| --- | --- | --- | --- |
| Dispatch dashboard | built once by `dashboard/build.ts` into `plugin/dispatch/dashboard-page/`, served by `plugin/dispatch/dashboard.ts` under a content policy | `dashboard/src/styles.css`, Jig's look | yes |
| Decision, explainer and audit sheets | written per run by each skill's script, through the sheet kit (`plugin/skills/decide/scripts/sheet-kit/`) | `PALETTE`, `TOKEN_TINTS` and `OUTCOME_INK` in the kit | no |
| Code-stats report | `plugin/skills/code-stats/scripts/report.html`, a template the report script fills | its own `:root` block | yes |

The difference matters for a theme: the dashboard is a page built before it
ships, so anything a machine adds to it is added when the server serves it;
the sheets and the report are written on the machine that runs the skill, so
a theme is written into the file then.

### One set of colour names

`plugin/shared/theme.ts` holds the colour names every page draws with, each
with a light and a dark value: the page and its surfaces (`bg`, `surface`,
`sunk`), text (`ink`, `muted`), rules (`line`, `line-strong`), the accent
(`accent`, `accent-hover`, `on-accent`, `accent-soft`), highlight (`hl`,
`hl-line`), `focus`, and the outcome colours (`ok`, `warn`, `risk` and
their tints). Its values are the dashboard's, which are Jig's look and the
site's. Each page maps its own CSS custom properties onto these names, so a
page keeps the names its rules use and only the source of their values
moves.

The module also holds the text-on-background pairs any page draws, light
and dark, and its test holds every pair to WCAG AA (the Web Content
Accessibility Guidelines' minimum contrast, 4.5:1 for text). A genre's own
contrast test (the sheet kit's `KIT_TEXT_PAIRS` and the audit sheet's
pairs) reads the colours from here and adds the dark pairs.

The site keeps its own stylesheet; a test checks that the colours it shares
with `theme.ts` agree, so neither build reads the other's files.

### The mark on every page

Every page names Jig's adaptive mark (`website/public/brand/jig-mark-adaptive.svg`,
the site's favicon) as its icon, written into the page as a `data:` address:
the dashboard because its server refuses a request without the page's token,
and the sheets because they are opened as files, where there is no server to
ask.

### A repository's theme

Two fields in a new `ui` section of the configuration, and nothing else:

| Field | Type | Default / meaning |
| --- | --- | --- |
| `ui.accent` | a CSS colour (`#1a6444`, `oklch(0.46 0.12 255)`) | Jig's green |
| `ui.mark` | path to an image file (vector or PNG) | Jig's adaptive mark |

One colour is all a team gives: the rest is derived. The light and dark
accents keep the given colour's hue and chroma, at the lightness nearest to
it that reaches 4.5:1 on that mode's surfaces; a colour that already does
stays as given. A colour with transparency is composited onto the mode's
page surface first, so every derivation starts from an opaque colour (a
fully transparent one would otherwise match its background at every
lightness). `accent-hover` is derived from the accent the same way.
`accent-soft` is a background, not text, so it is derived for its own
foreground instead: the given hue and chroma, at the lightness nearest to
the accent's that keeps ordinary ink at 4.5:1 on it. `on-accent`, the label
on an accent button, is chosen against the derived accent itself: black or
white, whichever reaches 4.5:1 on it. So a
team's colour never fails contrast and is never refused for it; only a
value that is not a colour is refused, with the field and the layer that
set it named.

What a theme does not reach:

- **The outcome colours** (`ok`, `warn`, `risk`) mean the same on every page
  in every repository, so a team cannot recolour a risk.
- **A chart's categorical colours** (the code-stats report's kinds) are a
  palette chosen for telling series apart, not for a brand.
- **Fonts.** Every page uses the system's font stacks; a web font needs the
  network or a file embedded in each page, and the dashboard's content
  policy loads neither.

Which layer sets it follows who the page belongs to:

- **The sheets and the report** belong to the repository they were written
  in, so they read `ui` from every layer
  ([CONFIGURATION.md § Configuration layers](../plugin/CONFIGURATION.md#configuration-layers)):
  the repository's file overrides a person's user-file defaults, as every
  higher layer overrides a lower one.
- **The dashboard** spans every repository the machine dispatches for, so
  it reads `ui` from the user file and the environment only, and a `ui.mark`
  there is an absolute path, as `clones` paths are.

### How each page receives it

- **The dashboard.** The server reads the theme when it starts, and adds to
  the built page, after its stylesheet, one `<style>` block that sets the
  derived custom properties, and replaces the icon's address. The page's
  script is unchanged, so the content policy's script hash still holds, and
  the policy already allows inline styles and `data:` images. A theme that
  sets nothing serves the built page byte for byte.
- **The sheets.** The sheet kit's root block takes the theme as an input and
  writes it into the file; a genre's own rules are unchanged.
- **The code-stats report.** The report script writes the theme into the
  template's root block as it writes the data.

### What a mark may hold

A mark is drawn only as an image (the icon, an `<img>`), never written into
a page's markup: a browser runs no script and loads nothing from a vector
image it draws as an image, so a mark cannot reach the page's token or its data. The
file is read once, refused above 64 kilobytes, and written as a `data:` address.

## Build order

1. **One look.** `plugin/shared/theme.ts` with its pairs and test; the
   dashboard's styles, the sheet kit and the code-stats report read their
   colours from it; the sheets and the audit sheet gain dark mode, with
   their dark pairs in their contrast tests; every page carries the mark;
   the site's agreement test. A consumer sees its sheets change colour, so
   the change note is a `minor` release.
2. **A repository's theme.** The `ui` section in the configuration reader
   and CONFIGURATION.md, the derivation and its test, the dashboard
   server's style block, and the sheet kit's and report's theme input. It
   waits until a repository using Jig asks for it
   ([dispositions § Leave the unproven out](../docs/dispositions.md)).

## Left out

- **More than an accent and a mark.** A full set of colours a team writes
  out is a set it must keep at WCAG AA in two modes by hand; one colour
  derived into the rest cannot fail. More fields wait for a team that
  needs one.
- **A product name in the pages' titles.** The pages are named for what
  they show; a team that needs its name there is a reason to add a field
  then.
- **A mode switch on each page.** Every page follows the reader's system
  setting, which already says which mode the reader wants.
- **The design prototypes** under `prototypes/`: they record a design
  round as it was returned, and are not pages Jig ships.
