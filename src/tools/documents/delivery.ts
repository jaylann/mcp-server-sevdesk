/**
 * The output fields and wording of the tools that hand files out (`sevdesk_document_save`,
 * `sevdesk_csv_export`, `sevdesk_datev_export`) through `ToolContext.files`: a new file in
 * `SEVDESK_OUTPUT_DIR` (`savedTo`) or, over HTTP with file transfer, a download link
 * (`download`). Exactly one of the two is set.
 */
import { z } from "zod";

import type { Delivery } from "../../safety/file-access.js";

/** Output fields of a delivery; spread into the tool's output object. */
export const deliveryOutputShape = {
  savedTo: z
    .string()
    .optional()
    .describe("Absolute path of the new file inside SEVDESK_OUTPUT_DIR, when saved to a folder."),
  download: z
    .object({
      url: z
        .string()
        .describe(
          "Give this link to the user: it opens in their browser and needs them signed in to " +
            "this sevDesk account on this server.",
        ),
      reference: z.string().describe("Short code the download page shows, to match the file."),
      expiresAt: z.string().describe("ISO 8601; the link stops working then."),
    })
    .optional()
    .describe("On a remote server: the download link for the user, instead of savedTo."),
};

/** The delivery fields of a tool's output data. */
export function deliveryData(delivery: Delivery): {
  savedTo?: string;
  download?: { url: string; reference: string; expiresAt: string };
} {
  return "savedTo" in delivery
    ? { savedTo: delivery.savedTo }
    : { download: { ...delivery.download } };
}

/**
 * "a download link (reference K7M2QX, valid until …): give the user the link in download.url…"
 * Trusted text: our reference code and timestamp only, never the URL.
 */
export function downloadText(download: { reference: string; expiresAt: string }): string {
  return (
    `a download link (reference ${download.reference}, valid until ${download.expiresAt}): ` +
    "give the user the link in download.url; they open it in the browser, signed in to this " +
    "sevDesk account"
  );
}
