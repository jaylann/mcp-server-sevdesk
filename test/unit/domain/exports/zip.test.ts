import { describe, expect, it } from "vitest";

import { listZipEntries } from "../../../../src/domain/exports/zip.js";
import { buildZip, pdfBytes } from "../../../helpers/zip.js";

describe("listZipEntries", () => {
  it("lists names and sizes in directory order", () => {
    const zip = buildZip([
      { name: "2026-11-16_Rechnung_RE-1000_0123.pdf", content: pdfBytes("a") },
      { name: "ordner/2026-11-16_Rechnung(Entwurf)__4567.pdf", content: pdfBytes("bb") },
      { name: "Grüße.txt", content: "äöü" },
    ]);
    expect(listZipEntries(zip)).toEqual([
      { name: "2026-11-16_Rechnung_RE-1000_0123.pdf", size: pdfBytes("a").length },
      { name: "ordner/2026-11-16_Rechnung(Entwurf)__4567.pdf", size: pdfBytes("bb").length },
      { name: "Grüße.txt", size: 6 },
    ]);
  });

  it("reads an empty archive and one with a comment", () => {
    expect(listZipEntries(buildZip([]))).toEqual([]);
    expect(listZipEntries(buildZip([{ name: "a.pdf", content: "x" }], "kommentar"))).toEqual([
      { name: "a.pdf", size: 1 },
    ]);
  });

  it("refuses what is not a whole archive", () => {
    const zip = buildZip([
      { name: "a.pdf", content: "x" },
      { name: "b.pdf", content: "y" },
    ]);
    expect(listZipEntries(new Uint8Array())).toBeUndefined();
    expect(listZipEntries(new TextEncoder().encode("<Error>no</Error>"))).toBeUndefined();
    // Cut off: the end record is missing.
    expect(listZipEntries(zip.subarray(0, zip.length - 10))).toBeUndefined();
    // A directory that points past the end record.
    const broken = zip.slice();
    new DataView(broken.buffer).setUint32(broken.length - 6, zip.length, true);
    expect(listZipEntries(broken)).toBeUndefined();
    // A damaged directory header.
    const damaged = zip.slice();
    const directoryOffset = new DataView(zip.buffer).getUint32(zip.length - 6, true);
    damaged[directoryOffset] = 0;
    expect(listZipEntries(damaged)).toBeUndefined();
  });

  it("does not follow ZIP64 archives", () => {
    const zip = buildZip([{ name: "a.pdf", content: "x" }]).slice();
    new DataView(zip.buffer).setUint32(zip.length - 6, 0xffffffff, true);
    expect(listZipEntries(zip)).toBeUndefined();
  });

  it("reads a ZIP that sits at an offset of a larger buffer", () => {
    const zip = buildZip([{ name: "inner.zip", content: buildZip([]) }]);
    const padded = new Uint8Array(zip.length + 8);
    padded.set(zip, 8);
    expect(listZipEntries(padded.subarray(8))).toEqual([{ name: "inner.zip", size: 22 }]);
  });
});
