/** The site's own address: the build's `site`, and a link to it is a link within the site. */
export const SITE_ORIGIN = "https://jig-harness.dev";

const HEX_PAIR = /^[0-9a-fA-F]{2}$/;

/**
 * A part of an address percent-decoded the way a browser does it: each valid
 * `%XX` escape becomes its byte, a `%` that starts no escape stays as written,
 * and the bytes read as UTF-8 (an invalid sequence reads as U+FFFD, and a
 * leading byte-order mark is kept as a character). Escapes of
 * the characters in `keep` stay escaped. So `caf%C3%A9100%` reads `café100%`,
 * where `decodeURIComponent` would throw on the whole part.
 */
export function percentDecoded(part: string, keep = ""): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < part.length; i++) {
    const pair = part.slice(i + 1, i + 3);
    if (part[i] === "%" && HEX_PAIR.test(pair)) {
      const byte = Number.parseInt(pair, 16);
      if (byte < 0x80 && keep.includes(String.fromCharCode(byte))) {
        bytes.push(...encoder.encode(`%${pair}`));
      } else {
        bytes.push(byte);
      }
      i += 2;
      continue;
    }
    const point = part.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(point);
    bytes.push(...encoder.encode(char));
    i += char.length - 1;
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    new Uint8Array(bytes),
  );
}

/**
 * The page route an address's path names, the way the built files are named:
 * every escape decoded but `%2F`, since no route segment holds a `/`. Its
 * inverse is `encodedRoute`, so the two agree for every character, reserved
 * ones such as `&`, `@`, `?` and `#` included.
 */
export const routePath = (pathname: string): string =>
  percentDecoded(pathname, "/");

/** A route as the path of an address, each segment percent-encoded: what `routePath` reads back. */
export const encodedRoute = (route: string): string =>
  route.split("/").map(encodeURIComponent).join("/");

/**
 * The address of the page at `route`, which its relative links resolve
 * against: a `?` or `#` in the route is part of the path, not a query or a
 * fragment.
 */
export const routeAddress = (route: string, origin = SITE_ORIGIN): string =>
  `${origin}${encodedRoute(route)}`;
