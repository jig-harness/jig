function localPartCharacter(char: string): boolean {
  return /[A-Za-z0-9._%+-]/.test(char);
}

function domainCharacter(char: string): boolean {
  return /[A-Za-z0-9-]/.test(char);
}

function topLevelDomain(label: string): boolean {
  return /^[A-Za-z]{2,}$/.test(label);
}

/** Whether an at-sign has local-part characters before it. */
function hasLocalPart(text: string, at: number): boolean {
  return at > 0 && localPartCharacter(text[at - 1] ?? "");
}

/** Read the dot-separated domain labels after an at-sign and where they end. */
function domainAfter(
  text: string,
  at: number,
): { labels: string[]; end: number } {
  let end = at + 1;
  const labels: string[] = [];
  while (end < text.length) {
    const labelStart = end;
    while (end < text.length && domainCharacter(text[end] ?? "")) end += 1;
    if (end === labelStart) break;
    labels.push(text.slice(labelStart, end));
    if (text[end] !== "." || !domainCharacter(text[end + 1] ?? "")) break;
    end += 1;
  }
  return { labels, end };
}

/** Return the end of an email-shaped address beginning at an at-sign. */
function emailEnd(text: string, at: number): number | null {
  if (!hasLocalPart(text, at)) return null;
  const { labels, end } = domainAfter(text, at);
  return labels.length > 1 && topLevelDomain(labels.at(-1) ?? "") ? end : null;
}

/** An account hash or credential fingerprint as the identity reader writes it. */
const ACCOUNT_ID = /\b(?:acct-[0-9a-f]{16}|(?:token|api-key):[0-9a-f]{12})\b/g;

/** Public records replace email addresses and account identifiers in prose. */
export function redact(text: string): string {
  let cursor = 0;
  let out = "";
  while (true) {
    const at = text.indexOf("@", cursor);
    if (at < 0)
      return `${out}${text.slice(cursor)}`.replace(ACCOUNT_ID, "<redacted>");
    const end = emailEnd(text, at);
    if (end === null) {
      out += text.slice(cursor, at + 1);
      cursor = at + 1;
      continue;
    }
    let start = at;
    while (start > cursor && localPartCharacter(text[start - 1] ?? ""))
      start -= 1;
    out += `${text.slice(cursor, start)}<redacted>`;
    cursor = end;
  }
}

/**
 * Redact string values without changing keys, booleans or array shape; `also`
 * runs on each redacted string, for a record that masks more than this does.
 */
export function redactStrings<T>(
  value: T,
  also: (text: string) => string = (text) => text,
): T {
  if (typeof value === "string") return also(redact(value)) as T;
  if (Array.isArray(value))
    return value.map((v: unknown) => redactStrings(v, also)) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        redactStrings(field, also),
      ]),
    ) as T;
  return value;
}
