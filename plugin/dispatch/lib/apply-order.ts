/** Launch groups take turns leading the whole tick, so neither can be held behind another group's backlog across repositories. */
export type LaunchGroup = "drives" | "background";

export interface PendingRepository {
  apply(group: LaunchGroup): Promise<void>;
  finish(): Promise<void>;
}

/** Let each background stage lead after all repositories have led both launch groups. */
export function backgroundOrder<T>(
  items: T[],
  tick: number,
  repos: number,
): T[] {
  if (items.length < 2) return items;
  const start = Math.floor(tick / (2 * Math.max(1, repos))) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

/** Turn the repository order after both groups have led and finish notifications after all launches. */
export async function applyInTurns(
  repositories: PendingRepository[],
  tick: number,
): Promise<void> {
  const groups: LaunchGroup[] =
    tick % 2 === 0 ? ["drives", "background"] : ["background", "drives"];
  const start = Math.floor(tick / 2) % Math.max(1, repositories.length);
  const ordered = [
    ...repositories.slice(start),
    ...repositories.slice(0, start),
  ];
  for (const group of groups)
    for (const repository of ordered) await repository.apply(group);
  for (const repository of repositories) await repository.finish();
}

/** The launch callbacks belonging to this global group. */
export function launchStageOrder<T>(
  stages: T[],
  group: LaunchGroup | "finish",
  tick: number,
  repos: number,
): T[] {
  if (group === "finish") return [];
  return group === "drives"
    ? stages.slice(0, 1)
    : backgroundOrder(stages.slice(1), tick, repos);
}
