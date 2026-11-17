/**
 * Custom field definitions (`/ContactCustomFieldSetting`) are only ever read (D-086).
 *
 * Deleting a setting deletes every value of it on every contact, without the 409 the spec
 * declares (recorded 2026-11-16). A setting renamed or created by the server would also change
 * what every contact shows. So the custom-field work of #86 reads settings to resolve names and
 * ids and never writes one; fields are defined in the sevDesk web app.
 *
 * Guard, two ways: every tool that touches custom fields is run through a client that answers
 * any request and records it, and no request to a setting path may be anything but a GET; and no
 * source file outside the custom-field module names the settings endpoint at all, so a new
 * caller cannot slip in without this test changing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../src/sevdesk/errors.js";
import type { SevdeskClient, SevdeskRequest } from "../../src/sevdesk/types.js";
import { contactCreateTool } from "../../src/tools/contacts/create.js";
import { contactDeleteTool } from "../../src/tools/contacts/delete.js";
import { contactGetTool } from "../../src/tools/contacts/get.js";
import { contactsSearchTool } from "../../src/tools/contacts/search.js";
import { contactUpdateTool } from "../../src/tools/contacts/update.js";
import { referenceLookupTool } from "../../src/tools/meta/reference-lookup.js";
import { withCountryRoute } from "../helpers/country-route.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../helpers/fake-client.js";
import { executeWrite } from "../helpers/write-tools.js";

const SETTINGS_PATH = /^\/ContactCustomFieldSetting(\/|$)/;
const DELETED: FakeRoute["response"] = { body: { objects: [null] } };
const GONE: FakeRoute["response"] = {
  error: new SevdeskError({ kind: "not_found", status: 404, message: "Not found." }),
};

function filter(id: number) {
  return { "contact[id]": String(id), "contact[objectName]": "Contact" };
}

/** sevDesk with contact 1001 and 1101, two values and the account's settings. */
function routes(): FakeRoute[] {
  return withCountryRoute([
    { method: "DELETE", path: "/Contact/1001", response: DELETED },
    { path: "/Contact/1001", response: { fixture: "contacts/contact-1001.json" } },
    { path: "/Contact/1101", response: { fixture: "masterdata/contact-1101.json" } },
    { path: "/Contact/1002", response: GONE },
    {
      path: "/ContactAddress",
      query: filter(1001),
      response: { fixture: "contacts/contact-addresses-1001.json" },
    },
    {
      path: "/CommunicationWay",
      query: filter(1001),
      response: { fixture: "contacts/communication-ways-1001.json" },
    },
    { path: "/ContactAddress", response: { body: { objects: [] } } },
    { path: "/CommunicationWay", response: { body: { objects: [] } } },
    {
      path: "/ContactCustomField",
      query: filter(1001),
      response: { fixture: "contacts/custom-fields-1001.json" },
    },
    { path: "/ContactCustomField", response: { body: { objects: [] } } },
    {
      path: "/ContactCustomFieldSetting",
      response: { fixture: "contacts/custom-field-settings.json" },
    },
    {
      path: "/Contact/Factory/findContactsByCustomFieldValue",
      response: { fixture: "contacts/contacts-list.json" },
    },
    {
      path: "/Contact/Factory/getNextCustomerNumber",
      response: { fixture: "contacts/next-customer-number.json" },
    },
    { path: "/Contact", query: { "parent[id]": "1001" }, response: { body: { objects: [] } } },
    { path: "/Contact", response: { body: { objects: [] } } },
    {
      method: "POST",
      path: "/Contact",
      response: { fixture: "masterdata/contact-create-1101.json" },
    },
    {
      method: "POST",
      path: "/ContactCustomField",
      response: { body: { objects: { id: "7003", objectName: "ContactCustomField" } } },
    },
    {
      method: "PUT",
      path: "/ContactCustomField/7001",
      response: { body: { objects: { id: "7001", objectName: "ContactCustomField" } } },
    },
    { method: "DELETE", path: "/ContactCustomField/7002", response: DELETED },
  ]);
}

/** Every request a tool sends, whatever the client operation. */
function recording(base: FakeSevdeskClient, seen: SevdeskRequest[]): SevdeskClient {
  return {
    request: (request) => {
      seen.push(request);
      return base.request(request);
    },
    list: (path, query, options) => {
      seen.push({ method: "GET", path });
      return base.list(path, query, options);
    },
    listAll: (path, query, options) => {
      seen.push({ method: "GET", path });
      return base.listAll(path, query, options);
    },
    download: (request) => {
      seen.push(request);
      return base.download(request);
    },
  };
}

describe("D-086: custom field settings are only read", () => {
  it("no tool that works with custom fields sends anything but a GET to a setting", async () => {
    const seen: SevdeskRequest[] = [];
    const client = () => recording(new FakeSevdeskClient(routes()), seen);

    await contactGetTool.handler({ id: 1001 }, testContext(client()));
    await contactsSearchTool.handler(
      contactsSearchTool.input.parse({ customField: { name: "Branche", value: "x" } }),
      testContext(client()),
    );
    await referenceLookupTool.handler(
      referenceLookupTool.input.parse({ kind: "contact_custom_fields" }),
      testContext(client()),
    );
    await executeWrite(
      contactCreateTool,
      {
        organisationName: "Beispiel Handel GmbH",
        customFields: [{ name: "Kundennr extern", value: "EXT-1" }],
      },
      client(),
    );
    await executeWrite(
      contactUpdateTool,
      {
        id: 1001,
        customFields: [{ settingId: 19498, value: "EXT-2" }],
        remove: [{ kind: "customField", id: 7002 }],
      },
      client(),
    );
    await executeWrite(contactDeleteTool, { id: 1001 }, client());

    const settings = seen.filter((request) => SETTINGS_PATH.test(request.path));
    expect(settings.length).toBeGreaterThan(0);
    expect(settings.every((request) => request.method === "GET")).toBe(true);
    // The writes of this run, for the record: values only, never a setting.
    expect(
      seen
        .filter((request) => request.method !== "GET")
        .map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "POST /Contact",
      "POST /ContactCustomField",
      "PUT /ContactCustomField/7001",
      "DELETE /ContactCustomField/7002",
      "DELETE /Contact/1001",
    ]);
  });

  it("names the settings endpoint in one source module only", () => {
    const root = new URL("../../src/", import.meta.url).pathname;
    const users = sourceFiles(root)
      .filter((file) => readFileSync(file, "utf8").includes("ContactCustomFieldSetting"))
      .map((file) => relative(root, file));
    expect(users).toEqual(["domain/contact-custom-fields.ts"]);
    const module = readFileSync(join(root, "domain/contact-custom-fields.ts"), "utf8");
    // The only request to it is the list read; ids appear only as references in value bodies.
    expect(module.match(/"\/ContactCustomFieldSetting"/g)).toHaveLength(1);
    expect(module).toContain('client.list("/ContactCustomFieldSetting"');
    expect(module).not.toMatch(/sevdeskPath\("ContactCustomFieldSetting"/);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}
