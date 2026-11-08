/** Shared helpers of the e-invoice tests. */
import { readFileSync } from "node:fs";

import { expect } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";

/** Bytes of a file below `test/fixtures/einvoice/`. */
export function einvoiceFixture(path: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`../../../fixtures/einvoice/${path}`, import.meta.url)),
  );
}

/** The text of a file below `test/fixtures/einvoice/`. */
export function einvoiceText(path: string): string {
  return new TextDecoder().decode(einvoiceFixture(path));
}

/** UTF-8 bytes of a string. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The message of the local `validation` error a promise rejects with. */
export async function validationMessage(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  return (error as SevdeskError).message;
}
