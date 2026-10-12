// Isolated consumer policy for the operated skill suite; never read another repo.
import { join } from "node:path";
process.env.JIG_OVERLAY = join(import.meta.dirname, "fixtures", "overlay.json");
process.env.JIG_REVIEW_TRIAGE_CONFIG = join(
  import.meta.dirname,
  "fixtures",
  "review-triage.yaml",
);
