/**
 * Static reference resources: built-in, verified reference data as JSON, the same lists
 * `sevdesk_reference_lookup` returns. No sevDesk request is made.
 */
import type { McpServer } from "@modelcontextprotocol/server";

import { STATUS_CODES, TAX_RULES } from "../domain/reference-data.js";

const JSON_MIME_TYPE = "application/json";
/** Built-in data changes only with a new server version. */
const CACHE_ONE_HOUR = { ttlMs: 60 * 60 * 1000, cacheScope: "private" } as const;

interface ReferenceResource {
  readonly name: string;
  readonly uri: string;
  readonly title: string;
  readonly description: string;
  readonly content: () => unknown;
}

/** The reference resources, in registration order. */
const REFERENCE_RESOURCES: readonly ReferenceResource[] = [
  {
    name: "reference-tax-rules",
    uri: "sevdesk://reference/tax-rules",
    title: "Tax rules (Steuerregeln)",
    description:
      "sevDesk Update 2.0 tax rules with ids, codes, allowed tax rates and unsupported use " +
      "cases (e.g. 1 = steuerpflichtig, 11 = Kleinunternehmer §19).",
    content: () => ({ taxRules: TAX_RULES }),
  },
  {
    name: "reference-status-codes",
    uri: "sevdesk://reference/status-codes",
    title: "Status codes",
    description:
      "Status codes per object type (invoice, credit note, order, voucher, transaction, " +
      "contact), e.g. 100 = Entwurf, 200 = offen, 1000 = bezahlt for invoices.",
    content: () => ({ statusCodes: STATUS_CODES }),
  },
];

/** Registers every {@link REFERENCE_RESOURCES} entry as a static JSON resource. */
export function registerReferenceResources(server: McpServer): void {
  for (const resource of REFERENCE_RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: JSON_MIME_TYPE,
        cacheHint: CACHE_ONE_HOUR,
      },
      (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: JSON_MIME_TYPE,
            text: JSON.stringify(resource.content()),
          },
        ],
      }),
    );
  }
}
