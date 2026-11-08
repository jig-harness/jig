/** A merged pull request and runtime account for follow-up launch tests. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mergedPr, SLUG, type World } from "./fixtures.ts";
import { account, machineFile } from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

export const FOLLOWUP_CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  followup_command: /followup
`;

export function followupWorkspace(
  w: World,
  limits: Record<string, string> = {},
): void {
  w.setConfig(FOLLOWUP_CONFIG);
  withOrigin(w);
  const branch = "feature/9-done";
  w.setPrs("merged", [mergedPr(9, branch, "2026-10-31T12:00:00Z")]);
  w.setComments(9, []);
  const path = join(w.root, "ws-9");
  mkdirSync(path, { recursive: true });
  w.setWorkspaces([{ branch, linkedPR: 9, path }]);
  machineFile(
    w,
    [account(w, "a", "a@example.com")],
    limits,
    ["followup", "notify"],
    { followup_since: "2026-10-30T00:00:00Z" },
  );
}
