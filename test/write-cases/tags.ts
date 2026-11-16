import { documentTagTool } from "../../src/tools/documents/tag-tool.js";
import type { WriteToolCase } from "../helpers/write-cases.js";
import {
  documentTagRoute,
  relationRow,
  tagRow,
  tagsRoute,
  tagUsesRoute,
} from "../unit/tools/documents/tag-support.js";
import { documentRoute, invoiceRow } from "../unit/tools/lifecycle/helpers.js";

/** Write-tool cases of the tag work (#87, see test/helpers/write-cases.ts). */
export const TAGS_CASES: readonly WriteToolCase[] = [
  {
    label: "tag an invoice with a new tag",
    tool: documentTagTool,
    args: { action: "add", document: "invoice", id: 1001, tag: "Projekt Y" },
    routes: [
      documentRoute("invoice", invoiceRow()),
      tagsRoute([tagRow(7002, "Filiale München")]),
      {
        method: "POST",
        path: "/Tag/Factory/create",
        response: { fixture: "documents/tag-create-1001.json" },
      },
    ],
    writes: [{ method: "POST", path: "/Tag/Factory/create" }],
  },
  {
    label: "remove a tag's last use from an invoice",
    tool: documentTagTool,
    args: { action: "remove", document: "invoice", id: 1001, tag: "Projekt Y" },
    routes: [
      documentRoute("invoice", invoiceRow()),
      tagsRoute([tagRow(7001, "Projekt Y")]),
      documentTagRoute(7001, "Invoice", 1001, [relationRow(8101, 7001, "Invoice", 1001)]),
      tagUsesRoute(7001, [relationRow(8101, 7001, "Invoice", 1001)]),
      {
        method: "DELETE",
        path: "/TagRelation/8101",
        response: { fixture: "documents/tag-relation-delete.json" },
      },
    ],
    writes: [{ method: "DELETE", path: "/TagRelation/8101" }],
  },
];
