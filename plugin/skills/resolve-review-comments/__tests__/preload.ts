// Isolated consumer policy for the operated skill suite; never read another repo.
import { join } from "node:path";
process.env.GROUNDWORK_OVERLAY = join(
  import.meta.dirname,
  "fixtures",
  "overlay.json",
);
process.env.GROUNDWORK_REVIEW_TRIAGE_CONFIG = join(
  import.meta.dirname,
  "fixtures",
  "review-triage.yaml",
);
