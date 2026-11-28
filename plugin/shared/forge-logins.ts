/** Forge identities are case-insensitive; keep the first display spelling. */
export function uniqueLogins(logins: readonly string[]): string[] {
  const identities = new Map<string, string>();
  for (const login of logins)
    if (!identities.has(login.toLowerCase()))
      identities.set(login.toLowerCase(), login);
  return [...identities.values()];
}

/**
 * A GitHub login without the managed form's short code, as a pattern source
 * without anchors: the login of an account that is not an Enterprise Managed
 * User, and the grammar a record shaped before managed logins were taken
 * still holds to.
 */
export const GITHUB_UNMANAGED_LOGIN_SOURCE = "[A-Za-z0-9][A-Za-z0-9-]{0,38}";

/**
 * A GitHub login, as a pattern source without anchors: a letter or digit,
 * then up to 38 letters, digits or hyphens, and optionally one underscore
 * and a three-to-eight character alphanumeric short code, the form of an
 * Enterprise Managed User's login (`<handle>_<shortcode>`, such as
 * `mona_acme`). No other underscore is taken. A schema that cannot import
 * this module (the audit's configuration schema) spells the same source out.
 */
export const GITHUB_LOGIN_SOURCE = `${GITHUB_UNMANAGED_LOGIN_SOURCE}(?:_[A-Za-z0-9]{3,8})?`;

/** An organization's name, with no leading or trailing hyphen. */
const ORG_SOURCE = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";

/** The suffix GitHub gives an App's bot account (`example-bot[bot]`). */
const BOT_SUFFIX_SOURCE = String.raw`(?:\[bot\])?`;

const USER_LOGIN = new RegExp(`^${GITHUB_LOGIN_SOURCE}$`);
const ANY_LOGIN = new RegExp(`^${GITHUB_LOGIN_SOURCE}${BOT_SUFFIX_SOURCE}$`);

/**
 * Whether `value` is a bare GitHub login: no `@`, whitespace, slash or other
 * character a login cannot hold. An App's `[bot]` suffix is accepted only
 * with `bot: true`, for a caller that takes bot accounts; a caller that
 * reads only a person's or an owner's login leaves it out. Compare logins
 * without case (`uniqueLogins`).
 */
export function isGithubLogin(
  value: unknown,
  options: { bot?: boolean } = {},
): value is string {
  return (
    typeof value === "string" &&
    (options.bot === true ? ANY_LOGIN : USER_LOGIN).test(value)
  );
}

/**
 * A reviewer to request: a login, or `org/team` with an organization's own
 * name (never a managed user's), with or without `@`.
 */
export const REVIEWER = new RegExp(
  `^@?(?:${GITHUB_LOGIN_SOURCE}|${ORG_SOURCE}/[A-Za-z0-9._-]+)$`,
);

/** A reviewer as `gh pr create --reviewer` takes it: without the `@`. */
export function reviewerArg(reviewer: string): string {
  return reviewer.replace(/^@/, "");
}
