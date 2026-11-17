/**
 * Coverage of the recording session 2026-11-16 (the endpoints behind issues #86 to #96).
 *
 * The session's fixtures are checked in three contract tests, one per area
 * (`recorded-gaps-contacts`, `recorded-gaps-banking`, `recorded-gaps-documents`). This file holds
 * what must be true of the session as a whole: every recorded file is named by one of the three,
 * so a file added to the folder without a contract fails here, as it does for the earlier sessions
 * in `recorded-fixtures.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SESSION = "2026-11-16";
const SESSION_DIR = fileURLToPath(new URL(`../fixtures/recorded/${SESSION}/`, import.meta.url));

/**
 * The area tests of this session; each names the fixture files it covers as string literals. They
 * are read as text on purpose: the three keep their own lists, each in its own shape.
 */
const AREA_TESTS = [
  "recorded-gaps-contacts.test.ts",
  "recorded-gaps-banking.test.ts",
  "recorded-gaps-documents.test.ts",
] as const;

function filesBelow(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

const FILES_ON_DISK = filesBelow(SESSION_DIR)
  .map((path) => relative(SESSION_DIR, path).split("\\").join("/"))
  .sort();

const AREA_SOURCES = AREA_TESTS.map((name) => readFileSync(new URL(name, import.meta.url), "utf8"));

describe(`recorded fixtures ${SESSION}: coverage`, () => {
  it("recorded something", () => {
    expect(FILES_ON_DISK.length).toBeGreaterThan(0);
  });

  it.each(FILES_ON_DISK)("%s is covered by exactly one area test", (file) => {
    // An area test names a file either from the fixture root or from the session folder.
    const literals = [`"recorded/${SESSION}/${file}"`, `"${file}"`];
    const covering = AREA_SOURCES.filter((source) =>
      literals.some((literal) => source.includes(literal)),
    );
    expect(covering).toHaveLength(1);
  });

  it.each(FILES_ON_DISK)("%s says it was recorded in this session on Update 2.0", (file) => {
    const parsed: unknown = JSON.parse(readFileSync(join(SESSION_DIR, file), "utf8"));
    expect(parsed).toMatchObject({
      _provenance: { source: "recorded", date: SESSION, systemVersion: "2.0" },
      status: 200,
    });
  });
});
