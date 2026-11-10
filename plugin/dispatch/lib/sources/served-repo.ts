/**
 * Whose repository a served item is. A served person's assignments are read
 * from the tracker team, which every repository of an organization may share,
 * so each repository's tick sees the same list: an item that carries another
 * repository's label belongs to that repository's checkout, not this one's.
 * The scope comes from the checkout's own `review.repo_label` and
 * `review.taxonomy.repos`; without both there is no scope and nothing is
 * left out.
 */
export interface RepoScope {
  /** This repository's label, as the checkout's configuration spells it. */
  own: string;
  /** Every other repository label the taxonomy lists. */
  others: readonly string[];
  /** Why a supplied scope cannot be trusted; set, the checkout starts no served item. */
  invalid?: string;
}

/** A scope that was supplied but cannot be validated: served pickups are refused, never widened. */
function refusedScope(why: string): RepoScope {
  return { own: "", others: [], invalid: why };
}

/** A label compared by its name alone: case folded, a group's `repo:` prefix dropped. */
function named(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/^repo:/, "");
}

/** The scope the merged configuration declares, or none where it names no repository label. */
export function repoScopeOf(
  values: Record<string, unknown>,
): RepoScope | undefined {
  const review = values.review as
    { repo_label?: unknown; taxonomy?: { repos?: unknown } } | undefined;
  const own = review?.repo_label;
  if (own === undefined || own === null) return undefined;
  if (typeof own !== "string" || own.trim() === "")
    return refusedScope("review.repo_label is not a non-empty text");
  const repos = review?.taxonomy?.repos;
  if (repos === undefined || repos === null) return undefined;
  if (
    !Array.isArray(repos) ||
    repos.some((v) => typeof v !== "string" || v.trim() === "")
  )
    return refusedScope(
      "review.taxonomy.repos is not a list of non-empty text",
    );
  const mine = named(own);
  const others = (repos as string[]).filter((label) => named(label) !== mine);
  return others.length === 0 ? undefined : { own, others };
}

/**
 * The other repository's label an item carries, when it carries one and not
 * this repository's own: an item labelled for two repositories, this one
 * among them, stays this repository's to start.
 */
export function otherRepoLabel(
  labels: readonly string[],
  scope: RepoScope | undefined,
): string | null {
  if (scope === undefined || scope.invalid !== undefined) return null;
  const carried = labels.map(named);
  if (carried.includes(named(scope.own))) return null;
  const other = scope.others.find((label) => carried.includes(named(label)));
  return other ?? null;
}
