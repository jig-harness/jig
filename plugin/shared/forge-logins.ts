/** Forge identities are case-insensitive; keep the first display spelling. */
export function uniqueLogins(logins: readonly string[]): string[] {
  const identities = new Map<string, string>();
  for (const login of logins)
    if (!identities.has(login.toLowerCase()))
      identities.set(login.toLowerCase(), login);
  return [...identities.values()];
}
