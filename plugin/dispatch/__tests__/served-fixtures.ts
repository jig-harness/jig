/** The served-pickup tests' shared pool issue: an unstarted task for Alex. */
import type { PoolIssue } from "../../skills/do-item/scripts/lib/tracker/port.ts";

export const issue = (
  key: string,
  labels: string[] = [],
  assignee: string | null = "alex",
): PoolIssue => ({
  identifier: key,
  title: key,
  url: null,
  priority: 2,
  type: "task",
  size: "small",
  createdAt: "2026-01-01",
  updatedAt: "v1",
  state: { id: "s", name: "Todo", type: "unstarted" },
  assignee: assignee ? { id: assignee, name: assignee } : null,
  labels,
  isEpic: labels.includes("epic"),
  hasOpenChildren: labels.includes("epic"),
  truncated: [],
});
