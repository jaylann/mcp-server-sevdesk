import { describe, expect, it } from "vitest";

import { fileAccessFor } from "../../../src/tools/registry.js";
import { allEnabledConfig, TEST_TOKEN } from "../../helpers/config.js";
import {
  filesConfig,
  filesDeployment,
  filesOffDeployment,
  useTransfer,
} from "../../helpers/transfer.js";
import { grantAuthInfo } from "../../helpers/write-flow.js";

const openTransfer = useTransfer();
const PDF = new TextEncoder().encode("%PDF-1.7\n%%EOF");

describe("fileAccessFor", () => {
  it("uses the local folders over stdio", () => {
    const none = fileAccessFor({}, { config: allEnabledConfig() });
    expect([none.canRead, none.canDeliver]).toEqual([false, false]);

    const both = fileAccessFor(
      {},
      { config: allEnabledConfig({ fileDirs: ["/in"], outputDir: "/out" }) },
    );
    expect([both.canRead, both.canDeliver]).toEqual([true, true]);
    expect(both.describeDelivery()).toBe("a new file in SEVDESK_OUTPUT_DIR (/out)");
  });

  it("uses the local folders over HTTP when file transfer is off or has no store", async () => {
    const { store } = await openTransfer();
    const off = fileAccessFor(
      {},
      { config: allEnabledConfig({ deployment: filesOffDeployment() }), transfer: store },
    );
    expect(off.canRead).toBe(false);

    const noStore = fileAccessFor({}, { config: filesConfig() });
    expect(noStore.canRead).toBe(false);
  });

  it("uses uploads and links of the request's grant when file transfer is on", async () => {
    const transfer = await openTransfer();
    const request = {
      http: { authInfo: grantAuthInfo({ accountId: "4711", token: TEST_TOKEN, grantId: "g-7" }) },
    };
    const files = fileAccessFor(request, { config: filesConfig(), transfer: transfer.store });

    expect([files.canRead, files.canDeliver]).toEqual([true, true]);
    const upload = files.requestUpload("receipt");
    const id = upload.uploadId.slice("upload:".length);
    await transfer.store.receive(id, "4711", { name: "Beleg.pdf", kind: "pdf", bytes: PDF });

    const read = await files.read(upload.uploadId, { maxBytes: 1_000, kinds: ["pdf"] });
    expect(read.source).toBe("upload");
    expect(await transfer.store.readUpload({ grantKey: "g-7", accountScope: "4711" }, id)).toEqual(
      read,
    );
    expect(
      await transfer.store.readUpload({ grantKey: "g-8", accountScope: "4711" }, id),
    ).toBeUndefined();
  });

  it("scopes bearer mode to the server's account", async () => {
    const transfer = await openTransfer();
    const config = filesConfig({ deployment: filesDeployment("bearer"), account: { id: "99" } });
    const files = fileAccessFor({}, { config, transfer: transfer.store });

    const id = files.requestUpload("einvoice").uploadId.slice("upload:".length);
    expect(transfer.store.ticketFor(id, "99")).toMatchObject({ purpose: "einvoice" });
  });
});
