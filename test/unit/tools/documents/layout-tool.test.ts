/**
 * `sevdesk_document_set_layout` against scripted answers in the recorded shapes (D-113, D-114,
 * D-140; `test/unit/tools/lifecycle/helpers.ts` `layoutObjects`, `test/helpers/layout-routes.ts`).
 */
import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import type { SevdeskClient } from "../../../../src/sevdesk/types.js";
import { documentSetLayoutTool as tool } from "../../../../src/tools/documents/layout-tool.js";
import { withCountryRoute } from "../../../helpers/country-route.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { letterpapersRoute, templatesRoute } from "../../../helpers/layout-routes.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  changeParameterRoute,
  creditNoteRow,
  documentRoute,
  invoiceRow,
  layoutObjects,
  orderRow,
  renderRoute,
  type Row,
} from "../lifecycle/helpers.js";

const draftInvoice = invoiceRow({ status: "100", invoiceNumber: null, sendType: null });
const draftOrder = orderRow({ status: "100" });
const draftCreditNote = creditNoteRow({ status: "100", creditNoteNumber: "GU-1101" });

function client(routes: readonly FakeRoute[]): FakeSevdeskClient {
  return new FakeSevdeskClient(withCountryRoute(routes));
}

/** An invoice draft in German on Standard and Briefpapier 1, with the lists and a change answer. */
function invoiceClient(options: { draft?: Row; after?: Parameters<typeof layoutObjects>[0] } = {}) {
  return client([
    documentRoute("invoice", options.draft ?? draftInvoice),
    renderRoute("invoice"),
    templatesRoute("Invoice"),
    letterpapersRoute(),
    changeParameterRoute(
      "/Invoice/1001/changeParameter",
      "invoice",
      options.after ?? { language: "en", template: "tpl-modern", letterpaper: "lp-2" },
    ),
  ]);
}

const pdfRoute = (path: string, fixture: string): FakeRoute => ({
  path,
  query: { preventSendBy: true },
  response: { fixture },
});

describe("sevdesk_document_set_layout: metadata", () => {
  it("is a commit tool in the meta toolset with explicit annotations", () => {
    expect(tool.name).toBe("sevdesk_document_set_layout");
    expect(tool.tier).toBe("commit");
    expect(tool.toolset).toBe("meta");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("takes the eight languages sevDesk lists, and nothing unknown", () => {
    const parse = (args: object) => tool.input.safeParse({ kind: "invoice", id: 1, ...args });
    for (const language of [
      "de_DE",
      "de_AT",
      "de_CH",
      "en_US",
      "es_ES",
      "fr_FR",
      "it_IT",
      "el_GR",
    ]) {
      expect(parse({ language }).success).toBe(true);
    }
    expect(parse({ language: "en" }).success).toBe(false);
    expect(parse({ language: "xx_XX" }).success).toBe(false);
    expect(parse({ template: "" }).success).toBe(false);
    expect(parse({ payPal: "1" }).success).toBe(false);
    expect(tool.input.safeParse({ kind: "voucher", id: 1, language: "en_US" }).success).toBe(false);
  });
});

describe("sevdesk_document_set_layout on an invoice draft", () => {
  it("previews the current and the new choice in English and German without writing", async () => {
    const fake = invoiceClient();

    const plan = await prepareWrite(
      tool,
      { kind: "invoice", id: 1001, language: "en_US", template: "Modern", letterpaper: "lp-2" },
      fake,
    );

    expect(fake.writes()).toEqual([]);
    // The current layout came from render without reload, a reading POST (D-113).
    expect(fake.callsTo("/Invoice/1001/render")).toEqual([
      expect.objectContaining({ method: "POST", body: { forceReload: false } }),
    ]);
    expect(plan.preview.action).toBe(
      "Set the language, template and letterhead of invoice 1001 (no number yet).",
    );
    expect(plan.preview.facts.slice(-3)).toEqual([
      { label: "Language (Sprache)", value: "German (Germany), de_DE → English (USA), en_US" },
      {
        label: "Template (Vorlage)",
        value: "Standard (id tpl-standard) → Modern (id tpl-modern)",
      },
      {
        label: "Letterhead (Briefpapier)",
        value: "Briefpapier 1 (id lp-1) → Zweites Briefpapier (id lp-2)",
      },
    ]);
    expect(plan.previewDe.action).toBe(
      "Sprache, Vorlage und Briefpapier von Rechnung 1001 (noch ohne Nummer) ändern.",
    );
    expect(plan.previewDe.facts.slice(-3)).toEqual([
      { label: "Sprache", value: "Deutsch (Deutschland), de_DE → Englisch (USA), en_US" },
      { label: "Vorlage", value: "Standard (ID tpl-standard) → Modern (ID tpl-modern)" },
      {
        label: "Briefpapier",
        value: "Briefpapier 1 (ID lp-1) → Zweites Briefpapier (ID lp-2)",
      },
    ]);
    expect(plan.previewDe.facts).toHaveLength(plan.preview.facts.length);
    expect(plan.preview.warnings).toHaveLength(2);
    expect(plan.previewDe.warnings).toHaveLength(2);
    expect(plan.preview.irreversible).toBe(false);
  });

  it("sends one changeParameter per key, in order, as commit, the language in the locale form", async () => {
    const fake = invoiceClient();

    const { output } = await executeWrite(
      tool,
      { kind: "invoice", id: 1001, language: "en_US", template: "tpl-modern", letterpaper: "lp-2" },
      fake,
    );

    expect(fake.writes()).toEqual([
      expect.objectContaining({
        method: "PUT",
        path: "/Invoice/1001/changeParameter",
        body: { key: "language", value: "en_US" },
        tier: "commit",
      }),
      expect.objectContaining({ body: { key: "template", value: "tpl-modern" }, tier: "commit" }),
      expect.objectContaining({ body: { key: "letterpaper", value: "lp-2" }, tier: "commit" }),
    ]);
    // No PDF preview for invoices: they take changeParameter without one (D-113).
    expect(fake.callsTo("/Invoice/1001/getPdf")).toEqual([]);
    expect(output.data).toEqual({
      kind: "invoice",
      id: 1001,
      applied: ["language", "template", "letterpaper"],
      layout: {
        // Invoices store en for en_US (D-140).
        language: { code: "en_US", value: "en" },
        template: { id: "tpl-modern", name: "Modern" },
        letterpaper: { id: "lp-2", name: "Zweites Briefpapier" },
      },
    });
    expect(output.affected).toEqual([{ objectName: "Invoice", id: "1001" }]);
    expect(output.summary).toBe(
      "Set the language, template and letterhead of invoice 1001 (draft); sevDesk lists what " +
        "was sent.",
    );
    // Nothing of the PDF the answers carry reaches the output.
    expect(JSON.stringify(output.data)).not.toContain("JVBERi0");
  });

  it("leaves out what the draft already has and says so", async () => {
    const fake = invoiceClient({ after: { language: "en" } });

    const { plan } = await executeWrite(
      tool,
      { kind: "invoice", id: 1001, language: "en_US", template: "Standard" },
      fake,
    );

    expect(plan.preview.facts.at(-1)).toEqual({
      label: "Template (Vorlage)",
      value: "Standard (id tpl-standard) (unchanged)",
    });
    expect(plan.preview.action).toBe("Set the language of invoice 1001 (no number yet).");
    expect(fake.writes().map((call) => call.body)).toEqual([{ key: "language", value: "en_US" }]);
  });

  it("refuses a call that changes nothing", async () => {
    const fake = invoiceClient();

    await expect(
      prepareWrite(
        tool,
        { kind: "invoice", id: 1001, language: "de_DE", letterpaper: "lp-1" },
        fake,
      ),
    ).rejects.toMatchObject({
      kind: "validation",
      message: "Invoice 1001 already has the language and letterhead asked for; nothing to change.",
    });
    expect(fake.writes()).toEqual([]);
  });

  it.each([
    [{ template: "Klassisch" }, "sevDesk offers no template with this id or name"],
    [{ letterpaper: "lp-9" }, "sevDesk offers no letterhead with this id or name"],
  ])(
    "refuses an unknown template or letterhead before anything is sent (%j)",
    async (args, text) => {
      const fake = invoiceClient();
      const error = await prepareWrite(tool, { kind: "invoice", id: 1001, ...args }, fake).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(SevdeskError);
      expect((error as SevdeskError).kind).toBe("validation");
      expect((error as SevdeskError).message).toContain(text);
      expect(fake.writes()).toEqual([]);
    },
  );

  it("refuses an ambiguous template name and asks for the id", async () => {
    const fake = client([
      documentRoute("invoice", draftInvoice),
      renderRoute("invoice"),
      templatesRoute("Invoice", [
        { id: "a1", name: "Modern", type: "Invoice", default: false },
        { id: "a2", name: "modern ", type: "Invoice", default: false },
      ]),
    ]);
    await expect(
      prepareWrite(tool, { kind: "invoice", id: 1001, template: "Modern" }, fake),
    ).rejects.toMatchObject({
      kind: "validation",
      message:
        "2 templates have this name; pass the id of the one you mean (sevdesk_reference_lookup " +
        "kind=templates lists them).",
    });
  });

  it("refuses a language the document does not list, naming the ones it does", async () => {
    const offered = layoutObjects();
    const parameters = (offered["parameters"] as Row[]).map((parameter) =>
      parameter["key"] === "language"
        ? {
            ...parameter,
            values: (parameter["values"] as Row[]).filter(
              (choice) => choice["translationCode"] !== "SEVDOC_LANG_EL_GR",
            ),
          }
        : parameter,
    );
    const fake = client([
      documentRoute("invoice", draftInvoice),
      renderRoute("invoice", {}, { ...offered, parameters }),
    ]);

    await expect(
      prepareWrite(tool, { kind: "invoice", id: 1001, language: "el_GR" }, fake),
    ).rejects.toMatchObject({
      kind: "validation",
      message:
        "sevDesk does not offer the language el_GR for invoice 1001. It offers: de_DE, de_AT, " +
        "de_CH, en_US, es_ES, fr_FR, it_IT. Nothing was changed.",
    });
  });

  it.each([
    ["an open invoice", invoiceRow(), "is not a draft (status 200, Open / due)"],
    ["a recurring template", { ...draftInvoice, invoiceType: "WKR" }, "recurring invoice template"],
  ])("refuses %s before reading its layout", async (_label, row, text) => {
    const fake = client([documentRoute("invoice", row)]);
    const error = await prepareWrite(
      tool,
      { kind: "invoice", id: 1001, language: "en_US" },
      fake,
    ).catch((thrown: unknown) => thrown);
    expect((error as SevdeskError).kind).toBe("validation");
    expect((error as SevdeskError).message).toContain(text);
    expect(fake.calls.map((call) => call.path)).not.toContain("/Invoice/1001/render");
  });

  it("refuses a document that does not exist", async () => {
    const fake = client([
      {
        path: "/Invoice/1001",
        query: { embed: "contact" },
        response: { error: new SevdeskError({ kind: "not_found", message: "Not found." }) },
      },
    ]);
    await expect(
      prepareWrite(tool, { kind: "invoice", id: 1001, language: "en_US" }, fake),
    ).rejects.toMatchObject({
      kind: "validation",
      message: "Invoice 1001 does not exist in sevDesk.",
    });
  });

  it("refuses an empty call and a disabled toolset before any request", async () => {
    const fake = client([]);
    await expect(prepareWrite(tool, { kind: "invoice", id: 1001 }, fake)).rejects.toMatchObject({
      kind: "validation",
      message: "Nothing to change: give language, template or letterpaper (or several).",
    });
    await expect(
      prepareWrite(tool, { kind: "order", id: 3002, language: "en_US" }, fake, {
        toolsets: new Set(["invoices"]),
      }),
    ).rejects.toMatchObject({
      kind: "validation",
      message:
        "Setting the layout of order drafts needs the orders toolset, which is not enabled " +
        "(SEVDESK_TOOLSETS).",
    });
    expect(fake.calls).toEqual([]);
  });

  it("names what was set when a later request fails, and never repeats one", async () => {
    const fake = client([
      documentRoute("invoice", draftInvoice),
      renderRoute("invoice"),
      letterpapersRoute(),
      changeParameterRoute("/Invoice/1001/changeParameter", "invoice", { language: "en" }),
    ]);
    // The second changeParameter fails; everything else answers from the routes.
    let calls = 0;
    const failing: SevdeskClient = {
      request: (request) => {
        if (request.method === "PUT") {
          calls += 1;
          if (calls === 2) {
            return Promise.reject(
              new SevdeskError({ kind: "server", status: 500, message: "sevDesk failed." }),
            );
          }
        }
        return fake.request(request);
      },
      list: (path, query, options) => fake.list(path, query, options),
      listAll: (path, query, options) => fake.listAll(path, query, options),
      download: (request) => fake.download(request),
    };

    const error = await executeWrite(
      tool,
      { kind: "invoice", id: 1001, language: "en_US", letterpaper: "lp-2" },
      failing,
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).message).toBe(
      "sevDesk failed. Already set on invoice 1001: language. Not set: letterhead. Do not repeat " +
        "the whole call; check the document (sevdesk_invoice_pdf) and set only what is missing.",
    );
    expect((error as SevdeskError).completedWrites).toEqual([
      { objectName: "Invoice", id: "1001" },
    ]);
    expect(calls).toBe(2);
  });

  it("fails without a completed write when the first request fails", async () => {
    const fake = client([
      documentRoute("invoice", draftInvoice),
      renderRoute("invoice"),
      {
        method: "PUT",
        path: "/Invoice/1001/changeParameter",
        response: {
          error: new SevdeskError({ kind: "validation", status: 500, message: "Refused." }),
        },
      },
    ]);
    await expect(
      executeWrite(tool, { kind: "invoice", id: 1001, language: "es_ES" }, fake),
    ).rejects.toMatchObject({ kind: "validation", message: "Refused.", completedWrites: [] });
    expect(fake.writes()).toHaveLength(1);
  });

  it("reads the layout with render when the answer lists none", async () => {
    const reads: Row[] = [layoutObjects(), layoutObjects({ language: "es_ES" })];
    const fake = client([
      documentRoute("invoice", draftInvoice),
      {
        method: "POST",
        path: "/Invoice/1001/render",
        get response() {
          return { body: { objects: reads.shift() } };
        },
      },
      { method: "PUT", path: "/Invoice/1001/changeParameter", response: { body: { objects: {} } } },
    ]);

    const { output } = await executeWrite(
      tool,
      { kind: "invoice", id: 1001, language: "es_ES" },
      fake,
    );

    expect(fake.callsTo("/Invoice/1001/render")).toHaveLength(2);
    expect(output.data["layout"]).toMatchObject({ language: { code: "es_ES", value: "es_ES" } });
  });
});

describe("sevdesk_document_set_layout on order and credit-note drafts", () => {
  it.each([
    ["order", "Order", 3002, draftOrder, "documents/order-pdf.json"],
    ["credit_note", "CreditNote", 2001, draftCreditNote, "documents/credit-note-pdf.json"],
  ] as const)(
    "%s: fetches the PDF preview with preventSendBy first, then changes the language",
    async (kind, objectName, id, row, pdf) => {
      const fake = client([
        documentRoute(kind === "order" ? "order" : "creditNote", row),
        renderRoute("order"),
        pdfRoute(`/${objectName}/${String(id)}/getPdf`, pdf),
        changeParameterRoute(`/${objectName}/${String(id)}/changeParameter`, "order", {
          language: "en_US",
        }),
      ]);

      const { plan, output } = await executeWrite(tool, { kind, id, language: "en_US" }, fake);

      expect(fake.calls.map((call) => `${call.method} ${call.path}`).slice(-3)).toEqual([
        `POST /${objectName}/${String(id)}/render`,
        `GET /${objectName}/${String(id)}/getPdf`,
        `PUT /${objectName}/${String(id)}/changeParameter`,
      ]);
      const preview = fake.callsTo(`/${objectName}/${String(id)}/getPdf`)[0];
      expect(preview?.query).toEqual({ preventSendBy: true });
      expect(preview?.sideEffect).toBe(false);
      expect(fake.writes()).toEqual([
        expect.objectContaining({ body: { key: "language", value: "en_US" }, tier: "commit" }),
      ]);
      expect(plan.preview.facts.at(-1)).toEqual({
        label: "Language (Sprache)",
        value: "German (Germany), de_DE → English (USA), en_US",
      });
      expect(plan.preview.warnings.at(-1)).toContain("getPdf with preventSendBy=true");
      expect(plan.previewDe.warnings.at(-1)).toContain("getPdf mit preventSendBy=true");
      expect(output.data["layout"]).toEqual({
        language: { code: "en_US", value: "en_US" },
        template: { id: "tpl-standard", name: "Standard" },
      });
    },
  );

  it("shows an empty letterhead as none chosen", async () => {
    const fake = client([
      documentRoute("order", draftOrder),
      renderRoute("order"),
      letterpapersRoute(),
    ]);
    const plan = await prepareWrite(tool, { kind: "order", id: 3002, letterpaper: "lp-2" }, fake);
    expect(plan.preview.facts.at(-1)).toEqual({
      label: "Letterhead (Briefpapier)",
      value: "none chosen (sevDesk's standard) → Zweites Briefpapier (id lp-2)",
    });
    expect(plan.previewDe.facts.at(-1)).toEqual({
      label: "Briefpapier",
      value: "nicht gewählt (Standard von sevDesk) → Zweites Briefpapier (ID lp-2)",
    });
  });

  it("fails when sevDesk stores German instead of the language sent (D-140)", async () => {
    const fake = client([
      documentRoute("order", draftOrder),
      renderRoute("order", { language: "fr_FR" }),
      pdfRoute("/Order/3002/getPdf", "documents/order-pdf.json"),
      // Orders answer 200 and fall back to German for a value they do not take.
      changeParameterRoute("/Order/3002/changeParameter", "order", { language: "de_DE" }),
    ]);

    const error = await executeWrite(
      tool,
      { kind: "order", id: 3002, language: "it_IT" },
      fake,
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).message).toBe(
      "sevDesk accepted the layout changes of order 3002, but it lists another language than " +
        "the one sent. The language stored is de_DE. Check the document with sevdesk_order_pdf " +
        "and set it again if needed.",
    );
    expect((error as SevdeskError).completedWrites).toEqual([{ objectName: "Order", id: "3002" }]);
  });
});
