import { describe, expect, it } from "vitest";

import type { Tier } from "../../../../src/safety/tiers.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { DOCUMENT_TAG_TOOLS } from "../../../../src/tools/documents/index.js";
import { documentTagTool as tool } from "../../../../src/tools/documents/tag-tool.js";
import { selectTools } from "../../../../src/tools/registry.js";
import type { ToolsetName } from "../../../../src/tools/toolsets.js";
import { ACCOUNT_TAGS } from "../../../../src/tools/types.js";
import { testConfig } from "../../../helpers/config.js";
import { withCountryRoute } from "../../../helpers/country-route.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { documentRoute, invoiceRow } from "../lifecycle/helpers.js";
import { documentTagRoute, relationRow, tagRow, tagsRoute, tagUsesRoute } from "./tag-support.js";

const INVOICE = documentRoute("invoice", invoiceRow());
const CREATE: FakeRoute = {
  method: "POST",
  path: "/Tag/Factory/create",
  response: { fixture: "documents/tag-create-1001.json" },
};
const DELETE: FakeRoute = {
  method: "DELETE",
  path: "/TagRelation/8101",
  response: { fixture: "documents/tag-relation-delete.json" },
};
const TAGS = [tagRow(7001, "Projekt Y"), tagRow(7002, "Filiale München")];

function client(routes: readonly FakeRoute[]): FakeSevdeskClient {
  return new FakeSevdeskClient(withCountryRoute(routes));
}

const add = { action: "add", document: "invoice", id: 1001, tag: "Projekt Y" };
const remove = { ...add, action: "remove" };

describe("sevdesk_document_tag: metadata and registration", () => {
  it("is a write tool in meta, destructive (a last use takes the tag along), idempotent", () => {
    expect(tool).toMatchObject({
      name: "sevdesk_document_tag",
      toolset: "meta",
      tier: "write",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(tool.locks?.(tool.input.parse(add))).toEqual([ACCOUNT_TAGS]);
  });

  it("needs one of the four document toolsets, and the write tier for the write tool", () => {
    const selected = (toolsets: ToolsetName[], tiers: Tier[]) =>
      selectTools(
        DOCUMENT_TAG_TOOLS,
        testConfig({ toolsets: new Set(toolsets), allowedTiers: new Set(tiers) }),
      ).map((entry) => entry.name);
    expect(selected(["meta", "contacts"], ["read", "write"])).toEqual([]);
    expect(selected(["meta", "vouchers"], ["read"])).toEqual(["sevdesk_tags_list"]);
    expect(selected(["meta", "vouchers"], ["read", "write"])).toEqual([
      "sevdesk_document_tag",
      "sevdesk_tags_list",
    ]);
  });

  it("refuses a document kind whose toolset is disabled before any request", async () => {
    const fake = client([INVOICE, tagsRoute(TAGS)]);
    const config = { toolsets: new Set<ToolsetName>(["meta", "vouchers"]) };
    await expect(prepareWrite(tool, add, fake, config)).rejects.toThrow(
      "Tagging this document kind needs the invoices toolset, which is not enabled",
    );
    expect(fake.calls).toEqual([]);
  });
});

describe("sevdesk_document_tag: add", () => {
  it("previews a new tag as created by sevDesk and creates it with the factory", async () => {
    const fake = client([INVOICE, tagsRoute([tagRow(7002, "Filiale München")]), CREATE]);
    const { plan, output } = await executeWrite(tool, add, fake);
    expect(plan.preview.action).toBe("Tag invoice RE-1001 with the tag Projekt Y.");
    expect(plan.preview.facts).toContainEqual({ label: "Tag", value: "Projekt Y" });
    expect(plan.preview.facts).toContainEqual({
      label: "Tag status",
      value: "new: sevDesk creates it",
    });
    expect(plan.preview.warnings).toEqual([
      "No tag has this name yet (compared ignoring case, as sevDesk does): sevDesk creates the tag.",
    ]);
    expect(fake.writes().map((call) => [call.method, call.path, call.tier, call.body])).toEqual([
      [
        "POST",
        "/Tag/Factory/create",
        "write",
        { name: "Projekt Y", object: { id: 1001, objectName: "Invoice" } },
      ],
    ]);
    expect(output.data).toEqual({
      action: "added",
      document: { kind: "invoice", id: 1001 },
      tag: { id: 7001, name: "Projekt Y" },
      relationId: 8101,
      tagCreated: true,
    });
    expect(output.affected).toEqual([
      { objectName: "Invoice", id: "1001" },
      { objectName: "TagRelation", id: "8101" },
      { objectName: "Tag", id: "7001" },
    ]);
    expect(output.summary).toBe("Tagged invoice 1001 with tag 7001, which sevDesk created.");
  });

  it("reuses an existing tag in another letter case with its own spelling", async () => {
    const fake = client([
      INVOICE,
      tagsRoute(TAGS),
      documentTagRoute(7001, "Invoice", 1001, []),
      CREATE,
    ]);
    const { plan, output } = await executeWrite(tool, { ...add, tag: "PROJEKT y" }, fake);
    expect(plan.preview.action).toBe("Tag invoice RE-1001 with the tag Projekt Y.");
    expect(plan.preview.facts).toContainEqual({
      label: "Tag status",
      value: "exists (id 7001), added to this document",
    });
    expect(plan.preview.warnings).toEqual([
      "sevDesk compares tag names ignoring case: the existing tag is used with its own spelling.",
    ]);
    expect(fake.writes()[0]?.body).toEqual({
      name: "Projekt Y",
      object: { id: 1001, objectName: "Invoice" },
    });
    expect(output.data.tagCreated).toBe(false);
    expect(output.affected).toEqual([
      { objectName: "Invoice", id: "1001" },
      { objectName: "TagRelation", id: "8101" },
    ]);
  });

  it("refuses when the document carries the tag already", async () => {
    const fake = client([
      INVOICE,
      tagsRoute(TAGS),
      documentTagRoute(7001, "Invoice", 1001, [relationRow(8101, 7001, "Invoice", 1001)]),
    ]);
    const error = await prepareWrite(tool, add, fake).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SevdeskError);
    expect(error).toMatchObject({
      kind: "validation",
      message: "Invoice 1001 already carries this tag; nothing to change.",
    });
    expect(fake.writes()).toEqual([]);
  });

  it("refuses a name two tags share, since sevDesk's pick is unknown, without naming it", async () => {
    const fake = client([
      INVOICE,
      tagsRoute([tagRow(7001, "Projekt Y"), tagRow(7003, "projekt y")]),
    ]);
    const error = await prepareWrite(tool, add, fake).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SevdeskError);
    const { kind, message } = error instanceof SevdeskError ? error : { kind: "", message: "" };
    expect(kind).toBe("validation");
    expect(message).toContain("Several tags have this name");
    expect(message).not.toContain("Projekt");
  });

  it("tags vouchers too (Beleg, by id)", async () => {
    const fake = client([
      { path: "/Voucher/2001", response: { fixture: "vouchers/voucher-2001.json" } },
      tagsRoute(TAGS),
      documentTagRoute(7001, "Voucher", 2001, []),
      CREATE,
    ]);
    const { plan } = await executeWrite(tool, { ...add, document: "voucher", id: 2001 }, fake);
    expect(plan.preview.action).toBe("Tag voucher 2001 with the tag Projekt Y.");
    expect(fake.writes()[0]?.body).toEqual({
      name: "Projekt Y",
      object: { id: 2001, objectName: "Voucher" },
    });
  });

  it("passes on sevDesk's not_found for an unknown document, writing nothing", async () => {
    const fake = client([
      {
        path: "/Invoice/1999",
        query: { embed: "contact" },
        response: { error: new SevdeskError({ kind: "not_found", message: "Not found." }) },
      },
      tagsRoute(TAGS),
    ]);
    await expect(prepareWrite(tool, { ...add, id: 1999 }, fake)).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(fake.writes()).toEqual([]);
  });
});

describe("sevdesk_document_tag: remove", () => {
  const carries = documentTagRoute(7001, "Invoice", 1001, [
    relationRow(8101, 7001, "Invoice", 1001),
  ]);

  it("removes the document's relation and keeps the tag when others use it", async () => {
    const fake = client([
      INVOICE,
      tagsRoute(TAGS),
      carries,
      tagUsesRoute(7001, [
        relationRow(8101, 7001, "Invoice", 1001),
        relationRow(8102, 7001, "Voucher", 2001),
      ]),
      DELETE,
    ]);
    const { plan, output } = await executeWrite(tool, remove, fake);
    expect(plan.preview.action).toBe("Remove the tag Projekt Y from invoice RE-1001.");
    expect(plan.preview.facts).toContainEqual({ label: "Tag uses", value: "2 documents" });
    expect(plan.preview.warnings).toEqual([]);
    expect(fake.writes().map((call) => [call.method, call.path, call.tier])).toEqual([
      ["DELETE", "/TagRelation/8101", "write"],
    ]);
    expect(output.data).toEqual({
      action: "removed",
      document: { kind: "invoice", id: 1001 },
      tag: { id: 7001, name: "Projekt Y" },
      relationId: 8101,
      tagDeleted: false,
    });
    expect(output.summary).toBe("Removed tag 7001 from invoice 1001.");
  });

  it("warns that removing the last use deletes the tag (D-089)", async () => {
    const fake = client([
      INVOICE,
      tagsRoute(TAGS),
      carries,
      tagUsesRoute(7001, [relationRow(8101, 7001, "Invoice", 1001)]),
      DELETE,
    ]);
    const { plan, output } = await executeWrite(tool, { ...remove, tag: "projekt y" }, fake);
    expect(plan.preview.facts).toContainEqual({ label: "Tag uses", value: "1 document" });
    expect(plan.preview.warnings).toEqual([
      "This document is the tag's only use: sevDesk deletes the tag itself when its last use is " +
        "removed. Tagging a document with this name again creates a new tag.",
    ]);
    expect(output.data.tagDeleted).toBe(true);
    expect(output.affected).toContainEqual({ objectName: "Tag", id: "7001" });
    expect(output.summary).toBe(
      "Removed tag 7001 from invoice 1001; it was its last use, so sevDesk deleted the tag.",
    );
  });

  it("refuses when the document does not carry the tag, or no tag has the name", async () => {
    const notCarried = client([
      INVOICE,
      tagsRoute(TAGS),
      documentTagRoute(7001, "Invoice", 1001, []),
    ]);
    await expect(prepareWrite(tool, remove, notCarried)).rejects.toMatchObject({
      kind: "validation",
      message:
        "Invoice 1001 does not carry this tag (compared ignoring case); nothing to remove. " +
        "sevdesk_tags_list lists the tags.",
    });
    const unknown = client([INVOICE, tagsRoute(TAGS)]);
    await expect(prepareWrite(tool, { ...remove, tag: "Unbekannt" }, unknown)).rejects.toThrow(
      "Invoice 1001 does not carry this tag (compared ignoring case); nothing to remove.",
    );
    expect([...notCarried.writes(), ...unknown.writes()]).toEqual([]);
  });

  it("picks the exactly spelled tag when two differ only in case", async () => {
    const fake = client([
      INVOICE,
      tagsRoute([tagRow(7003, "projekt y"), tagRow(7001, "Projekt Y")]),
      carries,
      tagUsesRoute(7001, [
        relationRow(8101, 7001, "Invoice", 1001),
        relationRow(8102, 7001, "Order", 3002),
      ]),
      DELETE,
    ]);
    const { output } = await executeWrite(tool, remove, fake);
    expect(output.data.tag).toEqual({ id: 7001, name: "Projekt Y" });
  });
});
