/**
 * Input fields and output schema shared by `sevdesk_part_create` and `sevdesk_part_update`.
 * Amounts are exact decimals (`amountInput`); text is trimmed and never empty, so nothing is
 * cleared by accident.
 */
import { z } from "zod";

import { amountInput } from "../../domain/common.js";
import { compare } from "../../domain/money.js";
import { partDetailDtoSchema } from "../../domain/parts.js";

function textInput(max: number) {
  return z.string().trim().min(1).max(max);
}

/** Tax rate in percent, 0–100 with up to two decimals. */
export const taxRateInput = amountInput({ places: 2 }).refine((value) => compare(value, 100) <= 0, {
  message: "a tax rate is at most 100",
});

export const partFieldsShape = {
  name: textInput(255).describe("Part name (Artikelname) as printed on documents."),
  partNumber: textInput(100).describe("Artikelnummer; must not be used by another part."),
  price: amountInput({ places: 2 }).describe(
    "Sales price (Verkaufspreis) in EUR, net or gross per priceMode; the other one is computed " +
      "with the tax rate.",
  ),
  priceMode: z
    .enum(["net", "gross"])
    .default("net")
    .describe("Whether price is the net (netto, default) or gross (brutto) price."),
  unitId: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .describe("Unit (Einheit) id, see sevdesk_reference_lookup kind=units (1 = Stk)."),
  pricePurchase: amountInput({ places: 2 }).describe("Purchase price (Einkaufspreis), net, EUR."),
  stock: amountInput({ places: 4 }).describe("Stock (Bestand)."),
  stockEnabled: z.boolean().describe("Track stock (Lagerbestand) for the part."),
  description: textInput(2_000).describe("Description (Beschreibung) printed on documents."),
  internalComment: textInput(2_000).describe("Internal note, not printed."),
};

export const partWriteOutput = z.object({ part: partDetailDtoSchema });
