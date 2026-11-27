/**
 * A child for `fixed-batch-policy.test.ts`: the command line as a dispatched
 * pass runs it, in the working directory the test chose, with an in-memory
 * tracker whose fixed members both lost their priority after the tick.
 */
import { main } from "../../scripts/candidates.ts";
import { fakeTracker, issue } from "../helpers.ts";

const tracker = fakeTracker([
  issue("ENG-1", { priority: 0, type: "bug", size: "small" }),
  issue("ENG-2", { priority: 0, type: "bug", size: "small" }),
]);
process.exit(await main(process.argv.slice(2), () => tracker));
