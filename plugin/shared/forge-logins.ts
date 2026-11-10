/** Forge identities are case-insensitive; keep the first display spelling. */
export function uniqueLogins(logins: readonly string[]): string[] {
  const identities = new Map<string, string>();
  for (const login of logins)
    if (!identities.has(login.toLowerCase()))
      identities.set(login.toLowerCase(), login);
  return [...identities.values()];
}

/** A reviewer to request: a login or `org/team`, with or without `@`. */
export const REVIEWER =
  /^@?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9._-]+)?$/;

/** A reviewer as `gh pr create --reviewer` takes it: without the `@`. */
export function reviewerArg(reviewer: string): string {
  return reviewer.replace(/^@/, "");
}
