/**
 * An approval to finalize or send a draft must show the layout it makes binding (language,
 * template, letterhead), and must be asked again when the layout changed after the human was
 * asked.
 *
 * sevDesk keeps the layout in the rendered document, not in the record (D-113): the record's
 * `update` time does not move when it changes, so the record binding alone cannot see it. A
 * layout set between the question and the approval (by `sevdesk_document_set_layout`, by a
 * second assistant, or in the web app) would be finalized unseen: an invoice the human approved
 * in German could go out in Greek on another letterhead.
 *
 * Guard 1: finalize and send read a draft's layout with `render` without reload (a reading POST)
 * and bind its raw values next to the record, positions and discounts: any change asks again.
 *
 * Guard 2: the facts list language, template and letterhead in English and German, for invoice,
 * order and credit-note drafts; finalized documents are not rendered.
 *
 * Guard 3: a render that fails does not block the approval (no `write` tool can change the
 * layout) but says in both languages that the layout is not shown.
 */
import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../src/sevdesk/errors.js";
import { enshrineTool } from "../../src/tools/lifecycle/enshrine.js";
import { finalizeTool } from "../../src/tools/lifecycle/finalize.js";
import { sendEmailTool } from "../../src/tools/lifecycle/send-email.js";
import type { AnyWriteToolDefinition } from "../../src/tools/types.js";
import { approve } from "../helpers/confirm-client.js";
import { withCountryRoute } from "../helpers/country-route.js";
import { type FakeRoute, FakeSevdeskClient } from "../helpers/fake-client.js";
import {
  closeWriteHarnessesAfterEach,
  resultData,
  writeHarness,
  writesOf,
} from "../helpers/write-flow.js";
import { prepareWrite } from "../helpers/write-tools.js";
import {
  creditNoteRow,
  documentRoute,
  invoiceRow,
  layoutObjects,
  type LayoutValues,
  orderRow,
  positionRoutes,
  renderRoute,
  type Row,
  writeRoute,
} from "../unit/tools/lifecycle/helpers.js";

closeWriteHarnessesAfterEach();

const draft = invoiceRow({ status: "100", invoiceNumber: null, sendType: null, sendDate: null });
const email = { id: 1001, to: "kunde@example.com", subject: "Rechnung", text: "Anbei." };

/** `render` of invoice 1001 answering whatever `state.values` holds when it is asked. */
function liveRender(state: { values: LayoutValues }): FakeRoute {
  return {
    method: "POST",
    path: "/Invoice/1001/render",
    get response() {
      return { body: { objects: layoutObjects(state.values) } };
    },
  };
}

function client(row: Row, render: FakeRoute = renderRoute("invoice")): FakeSevdeskClient {
  return new FakeSevdeskClient(
    withCountryRoute([documentRoute("invoice", row), render, ...positionRoutes()]),
  );
}

describe("approval binds the layout of a draft", () => {
  const edits: readonly [string, LayoutValues][] = [
    ["the language changes", { language: "el_GR" }],
    ["the template changes", { template: "tpl-modern" }],
    ["the letterhead changes", { letterpaper: "lp-2" }],
    ["the letterhead is cleared", { letterpaper: "" }],
  ];

  it.each(edits)(
    "asks again when %s after the human was asked (finalize)",
    async (_label, edit) => {
      const state: { values: LayoutValues } = { values: {} };
      const {
        client: mcp,
        fake,
        prompts,
      } = await writeHarness({
        tools: [finalizeTool("invoice")],
        routes: [
          documentRoute("invoice", draft),
          liveRender(state),
          ...positionRoutes(),
          writeRoute("PUT", "/Invoice/1001/sendBy", "invoice-send-by.json"),
        ],
        connect: {
          era: "modern",
          transport: "http",
          answer: (params) => {
            // While the human reads the first prompt, the layout is changed.
            if (prompts.length === 1) state.values = edit;
            return approve(params);
          },
        },
      });

      const result = await mcp.callTool({
        name: "sevdesk_invoice_finalize",
        arguments: { id: 1001 },
      });

      expect(prompts).toHaveLength(2);
      expect(prompts[1]?.message).toMatch(/^The record changed after you were asked/);
      expect(resultData(result)).toMatchObject({ status: "done" });
      expect(writesOf(fake)).toEqual([{ method: "PUT", path: "/Invoice/1001/sendBy" }]);
    },
  );

  it("asks once when the layout did not change, and shows it", async () => {
    const {
      client: mcp,
      fake,
      prompts,
    } = await writeHarness({
      tools: [finalizeTool("invoice")],
      routes: [
        documentRoute("invoice", draft),
        renderRoute("invoice", { language: "en", letterpaper: "lp-2" }),
        ...positionRoutes(),
        writeRoute("PUT", "/Invoice/1001/sendBy", "invoice-send-by.json"),
      ],
      connect: { era: "modern", transport: "http", answer: approve },
    });

    const result = await mcp.callTool({
      name: "sevdesk_invoice_finalize",
      arguments: { id: 1001 },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.message).toContain("Language (Sprache): English (USA), en_US");
    expect(prompts[0]?.message).toContain(
      "Letterhead (Briefpapier): Zweites Briefpapier (id lp-2)",
    );
    expect(resultData(result)).toMatchObject({ status: "done" });
    // The render read is no write: the approved call made exactly one.
    expect(writesOf(fake)).toEqual([{ method: "PUT", path: "/Invoice/1001/sendBy" }]);
  });

  it("binds the raw values: a different stored value with the same display asks again", async () => {
    const tool = finalizeTool("invoice");
    // de and de_DE both read as German (D-140), so the facts are equal; the binding is not.
    const before = await prepareWrite(tool, { id: 1001 }, client(draft));
    const after = await prepareWrite(
      tool,
      { id: 1001 },
      client(
        draft,
        renderRoute(
          "invoice",
          { language: "de_DE" },
          {
            ...layoutObjects(),
            parameters: (layoutObjects()["parameters"] as Row[]).map((parameter) =>
              parameter["key"] === "language"
                ? {
                    ...parameter,
                    value: "de_DE",
                    values: [
                      { name: "deutsch", value: "de_DE", translationCode: "SEVDOC_LANG_DE_DE" },
                    ],
                  }
                : parameter,
            ),
          },
        ),
      ),
    );

    expect(after.preview).toEqual(before.preview);
    expect(after.binding).not.toBe(before.binding);
  });
});

describe("the approval shows the layout it makes binding", () => {
  it.each([
    ["finalize an invoice draft", finalizeTool("invoice"), { id: 1001 }],
    ["send an invoice draft", sendEmailTool("invoice"), email],
  ] as const)(
    "%s: language, template and letterhead in English and German",
    async (_n, tool, args) => {
      const plan = await prepareWrite(
        tool as AnyWriteToolDefinition,
        args,
        client(draft, renderRoute("invoice", { language: "fr_FR", template: "tpl-modern" })),
      );

      expect(plan.preview.facts.slice(-3)).toEqual([
        { label: "Language (Sprache)", value: "French (France), fr_FR" },
        { label: "Template (Vorlage)", value: "Modern (id tpl-modern)" },
        { label: "Letterhead (Briefpapier)", value: "Briefpapier 1 (id lp-1)" },
      ]);
      expect(plan.previewDe?.facts.slice(-3)).toEqual([
        { label: "Sprache", value: "Französisch (Frankreich), fr_FR" },
        { label: "Vorlage", value: "Modern (ID tpl-modern)" },
        { label: "Briefpapier", value: "Briefpapier 1 (ID lp-1)" },
      ]);
      expect(plan.previewDe?.facts).toHaveLength(plan.preview.facts.length);
    },
  );

  it.each([
    ["order", orderRow({ status: "100" }), "/Order/3002/render"],
    [
      "creditNote",
      creditNoteRow({ status: "100", creditNoteNumber: "GU-1101" }),
      "/CreditNote/2001/render",
    ],
  ] as const)("finalize of a %s draft reads and shows its layout too", async (kind, row, path) => {
    const fake = new FakeSevdeskClient(
      withCountryRoute([documentRoute(kind, row), ...positionRoutes()]),
    );

    const plan = await prepareWrite(finalizeTool(kind), { id: Number(row["id"]) }, fake);

    expect(fake.callsTo(path)).toEqual([
      expect.objectContaining({ method: "POST", body: { forceReload: false } }),
    ]);
    // Orders and credit notes list the locale form and an empty letterhead (D-140).
    expect(plan.preview.facts.slice(-3)).toEqual([
      { label: "Language (Sprache)", value: "German (Germany), de_DE" },
      { label: "Template (Vorlage)", value: "Standard (id tpl-standard)" },
      { label: "Letterhead (Briefpapier)", value: "none chosen (sevDesk's standard)" },
    ]);
    expect(plan.previewDe.facts.at(-1)).toEqual({
      label: "Briefpapier",
      value: "nicht gewählt (Standard von sevDesk)",
    });
    expect(plan.preview.warnings.join(" ")).toContain("the positions and the layout (language");
  });

  it.each([
    ["send an open invoice", sendEmailTool("invoice"), email],
    ["enshrine an open invoice", enshrineTool("invoice"), { id: 1001 }],
  ] as const)(
    "%s: renders nothing, the layout was approved when it was finalized",
    async (_n, tool, args) => {
      const fake = client(invoiceRow());

      const plan = await prepareWrite(tool as AnyWriteToolDefinition, args, fake);

      expect(fake.callsTo("/Invoice/1001/render")).toEqual([]);
      expect(plan.preview.facts.map((fact) => fact.label)).not.toContain("Language (Sprache)");
      expect(plan.preview.warnings.join(" ")).toContain("and the layout of the PDF");
    },
  );
});

describe("a layout that cannot be read", () => {
  it("is named in both languages, bound as unreadable, and does not block the approval", async () => {
    const failing = renderRoute("invoice");
    const unreadable: FakeRoute = {
      ...failing,
      response: { error: new SevdeskError({ kind: "server", status: 500, message: "Failed." }) },
    };
    const tool = finalizeTool("invoice");

    const plan = await prepareWrite(tool, { id: 1001 }, client(draft, unreadable));
    const again = await prepareWrite(tool, { id: 1001 }, client(draft, unreadable));
    const readable = await prepareWrite(tool, { id: 1001 }, client(draft));

    expect(plan.preview.warnings).toContain(
      "The layout (language, template, letterhead) could not be read from sevDesk, so it is not " +
        "shown here. Check it with sevdesk_invoice_pdf before you approve.",
    );
    expect(plan.previewDe.warnings).toContain(
      "Das Layout (Sprache, Vorlage, Briefpapier) ließ sich nicht aus sevDesk lesen und wird " +
        "hier nicht gezeigt. Prüfe es vor der Freigabe mit sevdesk_invoice_pdf.",
    );
    expect(plan.previewDe.warnings).toHaveLength(plan.preview.warnings.length);
    expect(plan.preview.facts.map((fact) => fact.label)).not.toContain("Language (Sprache)");
    expect(again.binding).toBe(plan.binding);
    expect(readable.binding).not.toBe(plan.binding);
  });

  it("stops a cancelled call instead of hiding it as unreadable", async () => {
    const aborted: FakeRoute = {
      ...renderRoute("invoice"),
      response: { error: new SevdeskError({ kind: "aborted", message: "Cancelled." }) },
    };
    await expect(
      prepareWrite(finalizeTool("invoice"), { id: 1001 }, client(draft, aborted)),
    ).rejects.toMatchObject({ kind: "aborted" });
  });
});
