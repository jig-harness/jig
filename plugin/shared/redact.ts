/** An email-shaped string anywhere in a text. */
const EMAIL_CANDIDATE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g;

function email(candidate: string): boolean {
  const [local, domain, extra] = candidate.split("@");
  if (extra !== undefined || local === "" || domain === undefined) return false;
  const labels = domain.split(".");
  return (
    labels.length > 1 &&
    labels.every((label) => /^[A-Za-z0-9-]+$/.test(label) && label !== "") &&
    /^[A-Za-z]{2,}$/.test(labels.at(-1) ?? "")
  );
}

/** An account hash or credential fingerprint as the identity reader writes it. */
const ACCOUNT_ID = /\b(?:acct-[0-9a-f]{16}|(?:token|api-key):[0-9a-f]{12})\b/g;

/** Public records replace email addresses and account identifiers in prose. */
export function redact(text: string): string {
  return text
    .replace(EMAIL_CANDIDATE, (candidate) =>
      email(candidate) ? "<redacted>" : candidate,
    )
    .replace(ACCOUNT_ID, "<redacted>");
}

/** Redact string values without changing keys, booleans or array shape. */
export function redactStrings<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactStrings) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, redactStrings(field)]),
    ) as T;
  return value;
}
