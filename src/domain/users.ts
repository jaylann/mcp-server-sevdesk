/**
 * sevDesk users (`SevUser`). The endpoint is undocumented, but invoices, orders and credit notes
 * need a user as their `contactPerson`, so tools list users to pick one.
 *
 * Response shape: recorded `GET /SevUser` published by sevDesk.NET
 * (https://github.com/emuuu/sevDesk.NET/blob/main/docs/sevdesk-api-responses.txt) and
 * j-mastr's patched spec (`ModelSevUserResponse`).
 */
import { z } from "zod";

import { sanitizeUntrusted } from "../safety/fence.js";
import { parseUpstream, zId, zOptionalString } from "../sevdesk/schema.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { trimmedText } from "./common.js";

/** Compact user DTO (also the tools' output schema). */
export const userDtoSchema = z.object({
  id: z.number().int().describe("SevUser id, e.g. for an invoice's contactPerson."),
  name: z.string(),
  email: z.string().optional(),
});

type User = z.output<typeof userDtoSchema>;

export interface UserList {
  readonly items: readonly User[];
  /** sevDesk's `total` when it sent one, else the number of users received. */
  readonly total: number;
}

const USER_FIELD_MAX = 200;
/** More users than any account has; sevDesk's maximum page size. */
const USER_LIST_LIMIT = 1000;

/** Lenient schema of a `SevUser` row: only the fields the DTO needs. */
const sevUserSchema = z.object({
  id: zId,
  fullname: zOptionalString,
  firstName: zOptionalString,
  lastName: zOptionalString,
  username: zOptionalString,
  email: zOptionalString,
});

type SevUserRecord = z.output<typeof sevUserSchema>;

/**
 * Maps a parsed `SevUser` to the DTO. The name falls back from `fullname` to first + last name to
 * `username`; all text is sanitized (users can name themselves anything).
 */
function toUser(record: SevUserRecord): User {
  const parts = [trimmedText(record.firstName), trimmedText(record.lastName)].filter(
    (part): part is string => part !== undefined,
  );
  const name =
    trimmedText(record.fullname) ??
    (parts.length > 0 ? parts.join(" ") : undefined) ??
    trimmedText(record.username) ??
    `(unnamed user ${record.id})`;
  const email = trimmedText(record.email);
  return {
    id: record.id,
    name: sanitizeUntrusted(name, USER_FIELD_MAX),
    ...(email === undefined ? {} : { email: sanitizeUntrusted(email, USER_FIELD_MAX) }),
  };
}

/** Lists the users of the account (`GET /SevUser`). */
export async function listUsers(client: SevdeskClient, signal?: AbortSignal): Promise<UserList> {
  const page = await client.list("/SevUser", undefined, {
    limit: USER_LIST_LIMIT,
    ...(signal === undefined ? {} : { signal }),
  });
  const items = page.items.map((raw) => toUser(parseUpstream(sevUserSchema, raw, "users")));
  return { items, total: page.total ?? items.length };
}
