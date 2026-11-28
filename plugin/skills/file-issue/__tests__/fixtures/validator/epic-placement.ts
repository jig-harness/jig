import { main, type Deps } from "../../../scripts/validate-labels.ts";
import { join } from "node:path";

const [, , nativeType, exempt] = process.argv;
if (nativeType === undefined) throw new Error("expected a native issue type");
const labels = ["app", "roadmap"];
const deps: Deps = {
  openTracker: () => ({
    listLabels: async () => labels.map((name) => ({ name, group: null })),
    filedAs: async () => ({ nativeType, labels }),
    unavailableFacets: async (type, requested) => {
      if (type !== nativeType || requested.join(",") !== "priority,size")
        throw new Error("unexpected create-screen query");
      return exempt === "true" ? [...requested] : [];
    },
  }),
  readStdin: async () =>
    JSON.stringify({ title: "Draft", description: "", type: "feature", labels }),
};
const taxonomy = join(import.meta.dir, "label-taxonomy.yaml");
process.exitCode = await main(
  ["--check-tracker", "--json", "--taxonomy", taxonomy],
  deps,
);
