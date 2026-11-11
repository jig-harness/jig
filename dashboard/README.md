# The dispatch dashboard's page

The source of the page `jig dispatch dashboard` serves. The plugin runs from a
copy with no `node_modules`, so it carries the page as files built from here
and the pinned packages: `plugin/dispatch/dashboard-page/`, never edited by hand.

```sh
bun dashboard/build.ts            # write the built page
bun dashboard/build.ts --check    # exit 1 when it differs from a fresh build
bun dashboard/serve-fixture.ts --scenario loud   # the real server over a fixture database
bun test dashboard                # the page's tests, in Chromium where one is found
```

What the server and the page say to each other is
[`plugin/dispatch/lib/dashboard-contract.ts`](../plugin/dispatch/lib/dashboard-contract.ts).
Current PR state is read separately through `GET /pr`, with a minute cache and
bounded, deadline-protected forge calls. The historical outcome stays unchanged;
a merged or closed PR no longer presents its drive decision as actionable after
a successful refresh. Follow-up failures still need a person after merge.

The page also names a web app manifest and icons, so a phone's browser can
offer to install it (`plugin/phone-access.md`). `build.ts` writes the manifest
and copies `icons/` beside the page. The icons are PNGs rendered from Jig's
mark (`website/public/brand/jig-mark-light.*`): `icon-192.png` and
`icon-512.png` as it is, and `icon-maskable-512.png` from
`icons/jig-mark-maskable.*`, the mark at 80% on a full-bleed square, so a
launcher that crops icons to its own shape does not clip it. A new icon is
rendered again from its drawing, by any tool, and replaces the PNG here.

Why the page looks and reads as it does is the
[design round](../design/prototypes/dispatch-dashboard/README.md), whose
scenarios are `fixtures.ts` here.

The site shows this page over the `loud` scenario; after a change to how the
page looks, or to that scenario, take its shots again with
`bun run dashboard-shots` in `website/`.

It has a type-check project of its own, since it needs the browser's types and
the rest of the repository must not see them; `bun run typecheck` runs both.
