/**
 * Routes for the tag tools' tests: `Tag` and `TagRelation` rows with the recorded keys
 * (`test/fixtures/recorded/2026-11-16/tags/`, spec/deviations.md D-088), fake ids and names.
 *
 * The fake client does not filter by query, so each `/TagRelation` filter gets its own route;
 * the more specific ones (tag and object) must come before the tag-only ones.
 */
import type { FakeRoute } from "../../../helpers/fake-client.js";

type Row = Record<string, unknown>;

const SEV_CLIENT = { id: "9001", objectName: "SevClient" };

/** A `GET /Tag` row. */
export function tagRow(id: number, name: string): Row {
  return {
    id: String(id),
    objectName: "Tag",
    additionalInformation: null,
    create: "2026-11-16T21:40:45+01:00",
    name,
    objectType: null,
    sevClient: SEV_CLIENT,
  };
}

/** A `GET /TagRelation` row: tag `tagId` on the document `objectName` `objectId`. */
export function relationRow(id: number, tagId: number, objectName: string, objectId: number): Row {
  return {
    id: String(id),
    objectName: "TagRelation",
    additionalInformation: null,
    create: "2026-11-16T21:40:47+01:00",
    tag: { id: String(tagId), objectName: "Tag" },
    object: { id: String(objectId), objectName },
    sevClient: SEV_CLIENT,
  };
}

/** `GET /Tag` answering the whole collection `rows` (paged by the fake client). */
export function tagsRoute(rows: readonly Row[]): FakeRoute {
  return { path: "/Tag", response: { body: { objects: rows } } };
}

/** `GET /TagRelation` filtered by one tag. */
export function tagUsesRoute(tagId: number, rows: readonly Row[]): FakeRoute {
  return {
    path: "/TagRelation",
    query: { "tag[id]": tagId, "tag[objectName]": "Tag" },
    response: { body: { objects: rows } },
  };
}

/** `GET /TagRelation` filtered by one tag and one document. */
export function documentTagRoute(
  tagId: number,
  objectName: string,
  objectId: number,
  rows: readonly Row[],
): FakeRoute {
  return {
    path: "/TagRelation",
    query: {
      "tag[id]": tagId,
      "tag[objectName]": "Tag",
      "object[id]": objectId,
      "object[objectName]": objectName,
    },
    response: { body: { objects: rows } },
  };
}
