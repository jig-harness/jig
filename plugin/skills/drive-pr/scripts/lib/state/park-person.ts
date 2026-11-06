/** A park routes a question; its named person does not restrict who may answer. */
import { resolve } from "node:path";
import { consumerRoot, layeredConfig } from "../../../../../shared/consumer.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import {
  areasOf,
  loadCatalogFile,
  type ChangeAreaCatalog,
} from "../change-areas-catalog.ts";
import { ghCall } from "../proc.ts";
import { isPerson } from "./park-frame.ts";
import { ExitError } from "../cli.ts";

function login(value: unknown, field: string): string {
  if (!isPerson(value))
    throw new ExitError(2, `${field}: expected a forge login`);
  return value;
}

/** Direct owners of the question's anchor; ambiguous ownership uses the repository fallback. */
export function personForPark(
  path: string | null,
  catalog: ChangeAreaCatalog | null,
  configured: unknown,
  author: unknown,
): string {
  return (
    recipientForPark(path, catalog, configured) ??
    login(author, "pull request author")
  );
}

function recipientForPark(
  path: string | null,
  catalog: ChangeAreaCatalog | null,
  configured: unknown,
): string | null {
  if (configured !== undefined) login(configured, "dispatch.person");
  const owners =
    path === null || catalog === null
      ? []
      : [
          ...new Set(
            areasOf(path, catalog).flatMap((area) => {
              const owner = catalog.get(area)?.fields.owner;
              return owner === undefined
                ? []
                : [login(owner, `catalog area ${area}.owner`)];
            }),
          ),
        ];
  const [owner] = owners;
  if (owners.length === 1 && owner !== undefined) return owner;
  return configured === undefined ? null : login(configured, "dispatch.person");
}

/** Resolve once before writing state; forge calls use the drive's bounded transport. */
export async function resolveParkPerson(
  pr: string,
  key: string,
  kind: string,
  path: string,
): Promise<string> {
  const values = layeredConfig().values;
  const dispatch = isRecord(values.dispatch) ? values.dispatch : {};
  const drive = isRecord(values.drive) ? values.drive : {};
  const catalog =
    typeof drive.change_areas_catalog === "string"
      ? loadCatalogFile(resolve(consumerRoot(), drive.change_areas_catalog))
      : null;
  let anchor: string | null = path || null;
  if (anchor === null && catalog !== null && kind === "thread") {
    const result = await ghCall([
      "api",
      "graphql",
      "-f",
      "query=query($id:ID!){node(id:$id){... on PullRequestReviewThread{path}}}",
      "-f",
      `id=${key}`,
    ]);
    if (result.code === 0) {
      try {
        const doc = JSON.parse(result.stdout);
        anchor =
          typeof doc?.data?.node?.path === "string" ? doc.data.node.path : null;
        if (anchor === null)
          console.error(
            `park: thread ${key} returned no path; using recipient fallback`,
          );
      } catch (error) {
        console.error(
          `park: cannot parse thread ${key}'s anchor; using recipient fallback: ${String(error)}`,
        );
      }
    } else
      console.error(
        `park: cannot read thread ${key}'s anchor; using recipient fallback (exit ${result.code}): ${result.stderr}`,
      );
  }
  const recipient = recipientForPark(anchor, catalog, dispatch.person);
  if (recipient !== null) return recipient;
  const result = await ghCall(["pr", "view", String(pr), "--json", "author"]);
  if (result.code !== 0)
    throw new ExitError(
      1,
      `park: cannot read pull request author: ${result.stderr}`,
    );
  const doc = JSON.parse(result.stdout);
  return personForPark(anchor, catalog, dispatch.person, doc?.author?.login);
}
