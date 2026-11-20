/** Run the tick's dependency observation with the send fixture's home. */
import { report } from "../../dispatch/__tests__/line-fixtures.ts";
import { personPickupHolds } from "../../dispatch/lib/person-pickup-holds.ts";
import { readPickupConditions } from "../../dispatch/lib/tick-pickup-conditions.ts";
import { openTracker } from "../../skills/do-item/scripts/lib/tracker/index.ts";
import { trackerConfigFrom } from "../../skills/do-item/scripts/lib/tracker/config.ts";

if (import.meta.main) {
  const [slug, root, checkout] = process.argv.slice(2);
  if (slug === undefined || root === undefined || checkout === undefined)
    throw new Error("expected a repository, state directory and checkout");
  const holds = personPickupHolds(slug, root);
  if (!holds.ok) throw new Error(holds.failure.reason);
  const tracker = openTracker(
    trackerConfigFrom({ issue_tracker: { github: { repository: slug } } }),
    checkout,
  );
  const observed = report();
  await readPickupConditions(
    holds.value,
    { slug, root, checkout, apply: true, records: [], tracker },
    observed,
  );
  const failed = observed.records.find((record) => !record.ok);
  if (failed !== undefined) throw new Error(failed.detail);
}
