import { expect, it } from "bun:test";
import { trackerConfigFrom } from "../../do-item/scripts/lib/tracker/config.ts";
import { retiredLabels } from "../scripts/lib/sections.ts";
import { FakeRepo, LABEL_SECTION, NATIVE_SECTION } from "./fake-repo.ts";

it("uses the former label prefix for the sweep after switching stores", async () => {
  const overlay = {
    issue_tracker: { adapter: "github", facets: NATIVE_SECTION },
  };
  const config = trackerConfigFrom(overlay);
  const stores = await new FakeRepo()
    .view(NATIVE_SECTION)
    .tracker.facetStores();
  const labels = retiredLabels(overlay, config, process.cwd(), stores, {
    ...LABEL_SECTION,
    size: { store: "label", prefix: "old-size:" },
  });
  expect(labels).toContain("old-size:small");
  expect(labels).not.toContain("small");
});
