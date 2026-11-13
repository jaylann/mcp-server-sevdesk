/** A supplier's real name may equal either language's missing-name placeholder. */
import { describe, expect, it } from "vitest";

import { previewPairSchema } from "../../src/safety/preview.js";
import { voucherUpdateDraftTool as tool } from "../../src/tools/vouchers/draft-update.js";
import { type FakeRoute, FakeSevdeskClient } from "../helpers/fake-client.js";
import {
  closeWriteHarnessesAfterEach,
  resultData,
  resultText,
  writeHarness,
} from "../helpers/write-flow.js";
import { prepareWrite } from "../helpers/write-tools.js";
import {
  CREATE_READ_ROUTES,
  draftRow,
  positionRow,
  positionsRoute,
  saveRoute,
  voucherRoute,
} from "../unit/tools/vouchers/routes.js";

closeWriteHarnessesAfterEach();

function routes(currency: string, supplierName?: string, supplierId?: number): FakeRoute[] {
  return [
    voucherRoute(
      draftRow({
        currency,
        supplier: supplierId === undefined ? null : { id: supplierId, objectName: "Contact" },
        supplierName,
      }),
    ),
    positionsRoute(2101, [positionRow()]),
    ...CREATE_READ_ROUTES,
    saveRoute(),
  ];
}

const placeholders = ["(unnamed)", "(ohne Namen)"];
const collisions = ["EUR", "USD"].flatMap((currency) =>
  placeholders.map((supplierName) => ({ currency, supplierName })),
);

describe("voucher supplier preview placeholder collisions", () => {
  it.each(collisions)(
    "accepts $supplierName on a $currency draft in both previews and write modes",
    async ({ currency, supplierName }) => {
      const args = {
        id: 2101,
        supplierName,
        ...(currency === "EUR"
          ? {}
          : {
              currency: "EUR",
              positions: [{ accountDatevId: 4266, amount: "119.00", taxRate: 19 }],
            }),
      };
      const plan = await prepareWrite(tool, args, new FakeSevdeskClient(routes(currency)));
      expect(previewPairSchema.safeParse(plan).success).toBe(true);
      expect(plan.preview.facts).toContainEqual({
        label: "Supplier (Lieferant)",
        value: `(unnamed) (no contact) → ${supplierName} (no contact)`,
      });
      expect(plan.previewDe?.facts).toContainEqual({
        label: "Lieferant",
        value: `(ohne Namen) (kein Kontakt) → ${supplierName} (kein Kontakt)`,
      });

      // Exercise the real write-flow preview validation, which rejects both modes on regression.
      const { client, fake } = await writeHarness({ tools: [tool], routes: routes(currency) });
      const dryRun = await client.callTool({
        name: tool.name,
        arguments: { ...args, dryRun: true },
      });
      expect(dryRun.isError, resultText(dryRun)).toBeFalsy();
      expect(resultData(dryRun)).toMatchObject({ status: "dry_run" });
      expect(fake.writes()).toEqual([]);
      const saved = await client.callTool({ name: tool.name, arguments: args });
      expect(saved.isError, resultText(saved)).toBeFalsy();
      expect(resultData(saved)).toMatchObject({ status: "done" });
      expect(fake.writes()).toHaveLength(1);
      expect(fake.writes()[0]?.body).toMatchObject({ voucher: { supplier: null, supplierName } });
    },
  );

  it.each(placeholders)(
    "omits an unchanged supplier named %s from both previews",
    async (supplierName) => {
      const plan = await prepareWrite(
        tool,
        { id: 2101, supplierName },
        new FakeSevdeskClient(routes("EUR", supplierName)),
      );
      expect(previewPairSchema.safeParse(plan).success).toBe(true);
      expect(plan.preview.facts.some((fact) => fact.label === "Supplier (Lieferant)")).toBe(false);
      expect(plan.previewDe?.facts.some((fact) => fact.label === "Lieferant")).toBe(false);
    },
  );

  it("includes a changed contact ID even when its name is unchanged", async () => {
    const plan = await prepareWrite(
      tool,
      { id: 2101, supplierId: 1001 },
      new FakeSevdeskClient(routes("EUR", "Musterfirma GmbH", 1002)),
    );
    expect(previewPairSchema.safeParse(plan).success).toBe(true);
    expect(plan.preview.facts).toContainEqual({
      label: "Supplier (Lieferant)",
      value: "Musterfirma GmbH (contact 1002) → Musterfirma GmbH (contact 1001)",
    });
    expect(plan.previewDe?.facts).toContainEqual({
      label: "Lieferant",
      value: "Musterfirma GmbH (Kontakt 1002) → Musterfirma GmbH (Kontakt 1001)",
    });
  });
});
