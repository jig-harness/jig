/** Add durable registrations to the declared scratch inventory without widening its bounds. */
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { FixtureScope } from "../../shared/test-fixture-registry.ts";
import type { Resource } from "../types.ts";

export function withinFixtureRoot(root: string, scope: FixtureScope): boolean {
  const path = relative(root, scope.root);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}
function declaredRoot(
  root: string,
  repository: string,
  prefixes: string[],
): boolean {
  return prefixes.some((prefix) => {
    const absolute = resolve(repository, prefix);
    return (
      dirname(root) === dirname(absolute) &&
      basename(root).startsWith(basename(absolute))
    );
  });
}
/** A registered tree may be reaped only while all its scopes stay inside confirmed scratch bounds. */
export function fixtureScopeWithinBounds(
  root: string,
  repository: string,
  prefixes: string[],
): boolean {
  return prefixes.some((prefix) => {
    const absolute = resolve(repository, prefix);
    const path = relative(dirname(absolute), root);
    if (
      path === "" ||
      path === ".." ||
      path.startsWith(`..${sep}`) ||
      isAbsolute(path)
    )
      return false;
    return (path.split(sep)[0] ?? "").startsWith(basename(absolute));
  });
}
export function registeredFixtureResources(
  repository: string,
  prefixes: string[],
  registered: FixtureScope[],
  resources: Map<string, Resource>,
): {
  resources: Resource[];
  memberships: Map<string, FixtureScope[]>;
  processes: Map<string, FixtureScope>;
} {
  const memberships = new Map<string, FixtureScope[]>();
  const processes = new Map<string, FixtureScope>();
  for (const scope of registered)
    if (declaredRoot(scope.root, repository, prefixes))
      resources.set(scope.root, { id: scope.root });
  for (const resource of resources.values()) {
    const scopes = registered.filter((scope) =>
      withinFixtureRoot(resource.id, scope),
    );
    if (!scopes.some((scope) => scope.root === resource.id)) continue;
    memberships.set(resource.id, scopes);
    resource.details = {
      fixtureRegistrations: scopes.map((scope) => scope.registry),
    };
    for (const scope of scopes) {
      const id = `fixture-processes:${scope.registry}`;
      if (!processes.has(id)) processes.set(id, scope);
    }
  }
  return {
    memberships,
    processes,
    resources: [
      ...[...processes].map(([id, scope]) => ({
        id,
        details: {
          action: "reap registered fixture processes",
          root: scope.root,
          registry: scope.registry,
        },
      })),
      ...resources.values(),
    ],
  };
}
