/** Release tags are safe ref names with a version suffix. */
export const SHARED_RELEASE_LIMIT = 100;

const SAFE_REF_PREFIX = /^[A-Za-z0-9_./-]*$/;
const VERSION_SUFFIX =
  /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;

export function releaseTag(tag: string): boolean {
  const hasVersionSuffix = [...tag].some(
    (character, index) =>
      /^\d$/.test(character) &&
      SAFE_REF_PREFIX.test(tag.slice(0, index)) &&
      VERSION_SUFFIX.test(tag.slice(index)),
  );
  return (
    tag.length <= 128 &&
    hasVersionSuffix &&
    !tag.startsWith("-") &&
    !tag.includes("..") &&
    tag
      .split("/")
      .every(
        (segment) =>
          !segment.startsWith(".") &&
          !segment.endsWith(".lock") &&
          segment.length > 0,
      )
  );
}

/** Forward-compatible readers take only a complete, valid list. */
export function sharedReleaseTags(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > SHARED_RELEASE_LIMIT ||
    !value.every(
      (tag): tag is string => typeof tag === "string" && releaseTag(tag),
    )
  )
    return undefined;
  return [...new Set(value)];
}
