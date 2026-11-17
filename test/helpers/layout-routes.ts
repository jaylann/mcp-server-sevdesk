/**
 * Fake answers of the layout lists (`GET /DocServer/getLetterpapersWithThumb`,
 * `getTemplatesWithThumb?type=…`) and of `GET /TextTemplate`, in the recorded shapes (D-114,
 * D-115; `test/fixtures/recorded/2026-11-16/layouts/letterpapers.json`,
 * `recorded/2026-11-10/advanced/text-templates.json`). The DocServer lists are served as raw
 * bytes, the way the server reads them (a capped download), with the base64 thumbnails, PDFs and
 * HTML a real row carries, so tests can check that none of it gets through. Ids and names are
 * made up.
 */
import type { FakeRoute } from "./fake-client.js";

type Row = Record<string, unknown>;

/** A long base64 run, like a thumbnail (`img`) or a letterhead PDF. */
export const THUMBNAIL = `iVBORw0KGgo${"A".repeat(2_000)}=`;

/** A template row of `type`: Standard (`tpl-standard`, the default) unless overridden. */
export function templateRow(type: string, overrides: Row = {}): Row {
  return {
    default: true,
    id: "tpl-standard",
    isCustom: false,
    name: "Standard",
    pdfreactorVersion: "12",
    premium: false,
    sevClient: "0",
    type,
    translationCode: "TEMPLATE_DYNAMIC",
    html: "<!-- invoice -->\n<html><head><style>@page { size: A4 }</style></head></html>",
    img: THUMBNAIL,
    ...overrides,
  };
}

/** Standard (default) and Modern of `type`. */
function templateRows(type: string): Row[] {
  return [
    templateRow(type),
    templateRow(type, { default: 0, id: "tpl-modern", name: "Modern", premium: true }),
  ];
}

/** A letterhead row: Briefpapier 1 (`lp-1`, the default) unless overridden. */
function letterpaperRow(overrides: Row = {}): Row {
  return {
    id: "lp-1",
    pdf: THUMBNAIL,
    sevClient: "0",
    name: "Briefpapier 1",
    default: 1,
    isCustom: false,
    img: THUMBNAIL,
    ...overrides,
  };
}

/** Briefpapier 1 (default) and an own upload, Zweites Briefpapier (`lp-2`). */
function letterpaperRows(): Row[] {
  return [
    letterpaperRow(),
    letterpaperRow({
      id: "lp-2",
      name: "Zweites Briefpapier",
      default: 0,
      isCustom: true,
      sevClient: "9001",
    }),
  ];
}

function json(body: unknown): { bytes: Uint8Array; contentType: string } {
  return {
    bytes: new TextEncoder().encode(JSON.stringify(body)),
    contentType: "application/json",
  };
}

/** `GET /DocServer/getTemplatesWithThumb?type=<type>` answering `rows` under `objects`. */
export function templatesRoute(type: string, rows: readonly Row[] = templateRows(type)): FakeRoute {
  return {
    path: "/DocServer/getTemplatesWithThumb",
    query: { type },
    response: json({ objects: { templates: rows } }),
  };
}

/** `GET /DocServer/getLetterpapersWithThumb` answering `rows` under `objects`, as recorded. */
export function letterpapersRoute(rows: readonly Row[] = letterpaperRows()): FakeRoute {
  return {
    path: "/DocServer/getLetterpapersWithThumb",
    response: json({ objects: { result: 1, letterpapers: rows } }),
  };
}

/** A text template row in the recorded shape: the invoice head text "Standard" unless overridden. */
export function textTemplateRow(overrides: Row = {}): Row {
  return {
    id: "9765942",
    objectName: "TextTemplate",
    additionalInformation: null,
    create: "2026-11-07T23:30:23+01:00",
    update: "2026-11-07T23:30:23+01:00",
    name: "Standard",
    text: "Sehr geehrte Damen und Herren,\nwir berechnen Ihnen:",
    objectType: "RE",
    textType: "HEAD",
    sevClient: { id: "9001", objectName: "SevClient" },
    main: "1",
    category: "DOCUMENT",
    ...overrides,
  };
}

/** The account's text templates as recorded: RE head and two RE foots, AN head and foot, a mail. */
function textTemplateRows(): Row[] {
  return [
    textTemplateRow(),
    textTemplateRow({
      id: "9765943",
      textType: "FOOT",
      text: "Bitte überweisen Sie den Betrag innerhalb von 14 Tagen.",
    }),
    textTemplateRow({
      id: "9765950",
      name: "English",
      textType: "FOOT",
      main: "0",
      text: "Please transfer the amount within 14 days.",
    }),
    textTemplateRow({ id: "9765944", objectType: "AN", text: "Wir bieten Ihnen an:" }),
    textTemplateRow({
      id: "9765945",
      objectType: "AN",
      textType: "FOOT",
      text: "Das Angebot gilt 30 Tage.",
    }),
    textTemplateRow({
      id: "9765948",
      objectType: "ALL",
      textType: "TEXT",
      category: "MAIL",
      text: "Anbei Ihre Unterlagen.",
    }),
  ];
}

/** `GET /TextTemplate` answering `rows` with `total` (sevDesk ignores limit and offset). */
export function textTemplatesRoute(rows: readonly Row[] = textTemplateRows()): FakeRoute {
  return { path: "/TextTemplate", response: { body: { objects: rows, total: rows.length } } };
}
