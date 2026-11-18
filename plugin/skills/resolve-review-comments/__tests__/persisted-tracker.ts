/** Persist writes around a transport fixture so later batch reads see them. */
import type { Issue, Tracker } from "../../do-item/scripts/lib/tracker/port.ts";

export function persistedTracker(tracker: Tracker): Tracker {
  const written = new Map<string, Issue>();
  return {
    ...tracker,
    async createIssue(input) {
      const made = await tracker.createIssue(input);
      written.set(made.identifier, {
        ...input,
        id: made.identifier,
        identifier: made.identifier,
        url: made.url,
        type: input.type ?? null,
        priority: input.priority ?? 0,
        size: input.size ?? null,
        nativeType: null,
        isEpic: false,
        parent: null,
        children: [],
        assignee: null,
        project: input.project ?? null,
        state: { name: "Backlog", type: "backlog" },
      });
      return made;
    },
    async getIssue(key) {
      return written.get(key) ?? tracker.getIssue(key);
    },
    async searchIssues(text, opts) {
      return [
        ...(await tracker.searchIssues(text, opts)),
        ...[...written.values()].filter((i) => i.description.includes(text)),
      ];
    },
    async updateIssue(key, patch) {
      const issue = written.get(key);
      if (issue === undefined) return tracker.updateIssue(key, patch);
      Object.assign(issue, patch);
      issue.labels = [
        ...new Set([...issue.labels, ...(patch.addLabels ?? [])]),
      ].filter((l) => !patch.removeLabels?.includes(l));
    },
    async listRelations(key) {
      return written.has(key) ? [] : tracker.listRelations(key);
    },
  };
}
