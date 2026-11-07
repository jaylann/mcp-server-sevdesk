import { z } from "zod";

import { getNextCustomerNumber } from "../../domain/contacts.js";
import { defineTool } from "../define-tool.js";

/** `sevdesk_contacts_next_customer_number`: the next Kundennummer of the number range. */
export const nextCustomerNumberTool = defineTool({
  name: "sevdesk_contacts_next_customer_number",
  title: "Next free sevDesk customer number",
  description:
    "Get the next free customer number (Kundennummer) from the sevDesk number range, to use " +
    "when creating a contact (Kontakt) so numbering stays consecutive and free of duplicates. " +
    "Reading it does not reserve it: create the contact right after, and read it again if some " +
    "time has passed.",
  toolset: "contacts",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({}),
  output: z.object({
    customerNumber: z.string().describe("Next free Kundennummer, e.g. '1001' or 'K-1001'."),
  }),
  handler: async (_args, ctx) => {
    const customerNumber = await getNextCustomerNumber(ctx.client, ctx.signal);
    return {
      data: { customerNumber },
      summary: "Next free customer number fetched; it is not reserved.",
    };
  },
});
