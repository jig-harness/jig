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
}

/** A label compared by its name alone: case folded, a group's `repo:` prefix dropped. */
function named(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/^repo:/, "");
}

function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
}

/** The scope the merged configuration declares, or none where it names no repository label. */
export function repoScopeOf(
  values: Record<string, unknown>,
): RepoScope | undefined {
  const review = values.review as
    | { repo_label?: unknown; taxonomy?: { repos?: unknown } }
    | undefined;
  const own = review?.repo_label;
  if (typeof own !== "string" || own.trim() === "") return undefined;
  const mine = named(own);
  const others = textList(review?.taxonomy?.repos).filter(
    (label) => named(label) !== mine,
  );
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
  if (scope === undefined) return null;
  const carried = labels.map(named);
  if (carried.includes(named(scope.own))) return null;
  const other = scope.others.find((label) => carried.includes(named(label)));
  return other ?? null;
}
