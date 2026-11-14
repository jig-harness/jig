/**
 * The name a person knows a repository's tracker by, from the adapter its
 * configuration names: the product (GitHub Issues, Linear, Jira), an adapter
 * Jig does not know by its own word, and "the issue service" where nothing
 * names one. The dispatcher's sentences and the dashboard both say it this
 * way, so neither shows a person the configuration's word "tracker".
 */

/** The trackers Jig has an adapter for, by the adapter's name. */
const PRODUCTS: Readonly<Record<string, string>> = {
  github: "GitHub Issues",
  linear: "Linear",
  jira: "Jira",
};

/** The product an adapter names; an unknown adapter by its own word; `null` when none is named. */
export function trackerProduct(
  adapter: string | null | undefined,
): string | null {
  if (adapter == null || adapter === "") return null;
  const known = adapter.toLowerCase();
  return Object.hasOwn(PRODUCTS, known)
    ? (PRODUCTS[known] ?? adapter)
    : adapter;
}

/** What a sentence calls the service an adapter names: its product, else "the issue service". */
export function issueService(adapter: string | null | undefined): string {
  return trackerProduct(adapter) ?? "the issue service";
}
