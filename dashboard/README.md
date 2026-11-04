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
Why the page looks and reads as it does is the
[design round](../design/prototypes/dispatch-dashboard/README.md), whose
scenarios are `fixtures.ts` here.

The site shows this page over the `loud` scenario; after a change to how the
page looks, or to that scenario, take its shots again with
`bun run dashboard-shots` in `website/`.

It has a type-check project of its own, since it needs the browser's types and
the rest of the repository must not see them; `bun run typecheck` runs both.
