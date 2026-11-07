/**
 * Part writes (Artikel anlegen und ändern): the checks, previews and requests behind
 * `sevdesk_part_create` and `sevdesk_part_update`.
 *
 * Prices: `Model_Part` has `price` (documented as net, but the recorded part holds the gross price
 * there, D-042), `priceNet` and `priceGross`. To leave no room for interpretation (B8) a write
 * always sends `priceNet` and `priceGross` together with the `taxRate` they were computed with,
 * and never `price`. The user gives one price, net or gross; the other is computed exactly with
 * the decimal module and rounded half-up to cents, like the recorded part (net 42.01 at 19 % is
 * gross 49.99). Amounts travel as JSON numbers, as the spec types them; each is checked to
 * convert back to exactly the same decimal, so no float rounding can creep in.
 *
 * Updates read the part first and send only what changes (`PUT /Part/{id}`, `Model_PartUpdate`
 * has no required fields). Changing the tax rate without a new price keeps the net price and
 * recomputes the gross price.
 */
import { z } from "zod";

import { expectSingle } from "../sevdesk/envelope.js";
import { type CompletedWrite, SevdeskError, withCompletedWrites } from "../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import { parseUpstream, zId } from "../sevdesk/schema.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import type { ConfirmationFact, ConfirmationPreview } from "../tools/types.js";
import { cleanText } from "./common.js";
import {
  add,
  compare,
  type Decimal,
  decimal,
  type DecimalLike,
  format,
  multiply,
  toDecimalString,
} from "./money.js";
import { getPartDetails, listParts, type PartDetailDto } from "./parts.js";
import { listUnits } from "./reference-data.js";

/** Part status (spec `Model_Part.status`): 100 active, 50 inactive. */
const ACTIVE = 100;
const INACTIVE = 50;
const DISPLAY_MAX = 200;
const CURRENCY = "EUR";

// ---------------------------------------------------------------------------------------------
// Outgoing payloads (strict)
// ---------------------------------------------------------------------------------------------

const text = z.string().min(1);
const unityRef = z.strictObject({
  id: z.number().int().positive(),
  objectName: z.literal("Unity"),
});

const partCreatePayloadSchema = z.strictObject({
  name: text,
  partNumber: text,
  text: text.optional(),
  stock: z.number(),
  stockEnabled: z.boolean(),
  unity: unityRef,
  priceNet: z.number().optional(),
  priceGross: z.number().optional(),
  pricePurchase: z.number().optional(),
  taxRate: z.number(),
  status: z.union([z.literal(ACTIVE), z.literal(INACTIVE)]),
  internalComment: text.optional(),
});

const partUpdatePayloadSchema = partCreatePayloadSchema.partial();

type PartCreatePayload = z.output<typeof partCreatePayloadSchema>;
type PartUpdatePayload = z.output<typeof partUpdatePayloadSchema>;

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** Which price the user gave. */
export type PriceKind = "net" | "gross";

/** Fields of `sevdesk_part_create`; amounts are exact decimal strings (see `amountInput`). */
export interface PartCreateInput {
  readonly name: string;
  readonly partNumber: string;
  readonly price?: string | undefined;
  readonly priceType: PriceKind;
  readonly taxRate: string;
  readonly unitId: number;
  readonly pricePurchase?: string | undefined;
  readonly stock: string;
  readonly stockEnabled: boolean;
  readonly description?: string | undefined;
  readonly internalComment?: string | undefined;
}

/** Fields of `sevdesk_part_update`: only those to change. */
export interface PartUpdateInput {
  readonly id: number;
  readonly name?: string | undefined;
  readonly partNumber?: string | undefined;
  readonly price?: string | undefined;
  readonly priceType: PriceKind;
  readonly taxRate?: string | undefined;
  readonly unitId?: number | undefined;
  readonly pricePurchase?: string | undefined;
  readonly stock?: string | undefined;
  readonly stockEnabled?: boolean | undefined;
  readonly active?: boolean | undefined;
  readonly description?: string | undefined;
  readonly internalComment?: string | undefined;
}

// ---------------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------------

/** Net and gross price (exact decimal strings with two places) for one tax rate. */
export interface PricePair {
  readonly net: string;
  readonly gross: string;
}

/**
 * The price pair for a price entered net or gross at `taxRate` percent: gross = net × (100 +
 * rate) / 100 and net = gross × 100 / (100 + rate), each rounded half-up to cents.
 */
export function pricePair(price: DecimalLike, kind: PriceKind, taxRate: DecimalLike): PricePair {
  const factor = add(100, taxRate);
  if (kind === "net") {
    const gross = shift(multiply(price, factor), 2);
    return { net: format(price, 2), gross: format(gross, 2) };
  }
  const net = divideRounded(multiply(price, 100), factor, 2);
  return { net: format(net, 2), gross: format(price, 2) };
}

/** `value / 10^places`, exactly. */
function shift(value: Decimal, places: number): Decimal {
  return decimal({ units: value.units, scale: value.scale + places });
}

/** `numerator / denominator` rounded half-up (away from zero) to `places` decimals. */
function divideRounded(numerator: DecimalLike, denominator: DecimalLike, places: number): Decimal {
  const n = decimal(numerator);
  const d = decimal(denominator);
  if (d.units === 0n) throw new RangeError("Division by zero.");
  let top = n.units * 10n ** BigInt(d.scale + places);
  let bottom = d.units * 10n ** BigInt(n.scale);
  if (bottom < 0n) {
    top = -top;
    bottom = -bottom;
  }
  let quotient = top / bottom;
  const remainder = top % bottom;
  const absRemainder = remainder < 0n ? -remainder : remainder;
  if (absRemainder * 2n >= bottom) quotient += top < 0n ? -1n : 1n;
  return decimal({ units: quotient, scale: places });
}

/**
 * An exact decimal string as a JSON number for sevDesk. Throws when the number would not convert
 * back to the same decimal (more than ~15 significant digits), so precision is never lost.
 */
export function jsonNumber(value: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || compare(String(result), value) !== 0) {
    throw new SevdeskError({
      kind: "validation",
      message: "An amount has too many digits to be sent to sevDesk exactly.",
    });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export interface PartCreateState {
  readonly payload: PartCreatePayload;
}

/**
 * Checks a new part (free part number, known unit) and builds the preview and payload. Reads
 * only; throws a `validation` SevdeskError when the part cannot be created.
 */
export async function planPartCreate(
  client: SevdeskClient,
  input: PartCreateInput,
  signal?: AbortSignal,
): Promise<{ preview: ConfirmationPreview; state: PartCreateState }> {
  const [owner, unitName] = await Promise.all([
    partNumberOwner(client, input.partNumber, signal),
    unitNameOf(client, input.unitId, signal),
  ]);
  if (owner !== undefined) {
    throw validation(
      `The part number is already used by part ${owner}. Choose another part number, or change ` +
        "that part with sevdesk_part_update.",
    );
  }
  const prices =
    input.price === undefined ? undefined : pricePair(input.price, input.priceType, input.taxRate);
  const payload = partCreatePayloadSchema.parse({
    name: input.name,
    partNumber: input.partNumber,
    text: input.description,
    stock: jsonNumber(input.stock),
    stockEnabled: input.stockEnabled,
    unity: { id: input.unitId, objectName: "Unity" },
    priceNet: prices === undefined ? undefined : jsonNumber(prices.net),
    priceGross: prices === undefined ? undefined : jsonNumber(prices.gross),
    pricePurchase: input.pricePurchase === undefined ? undefined : jsonNumber(input.pricePurchase),
    taxRate: jsonNumber(input.taxRate),
    status: ACTIVE,
    internalComment: input.internalComment,
  });

  const facts: ConfirmationFact[] = [
    { label: "Name", value: input.name },
    { label: "Part number (Artikelnummer)", value: input.partNumber },
  ];
  if (prices !== undefined) {
    facts.push(
      { label: "Price net", value: amountLabel(prices.net, input.priceType !== "net") },
      { label: "Price gross", value: amountLabel(prices.gross, input.priceType !== "gross") },
    );
  }
  facts.push(
    { label: "Tax rate", value: `${toDecimalString(input.taxRate)} %` },
    { label: "Unit (Einheit)", value: unitLabel(input.unitId, unitName) },
  );
  if (input.pricePurchase !== undefined) {
    facts.push({
      label: "Purchase price (Einkaufspreis)",
      value: amountLabel(format(input.pricePurchase, 2), false),
    });
  }
  facts.push({
    label: "Stock (Bestand)",
    value: `${toDecimalString(input.stock)}, stock tracking ${input.stockEnabled ? "on" : "off"}`,
  });
  pushFact(facts, "Description", input.description);
  pushFact(facts, "Internal note", input.internalComment);

  return {
    preview: {
      action: `Create the part ${display(input.name)} (${display(input.partNumber)}).`,
      facts,
      warnings:
        prices === undefined
          ? ["The part has no sales price; documents will need one per position."]
          : [],
      irreversible: false,
    },
    state: { payload },
  };
}

/** Creates the part (`POST /Part`, never retried) and reads it back. */
export async function executePartCreate(
  client: SevdeskClient,
  state: PartCreateState,
  signal?: AbortSignal,
): Promise<PartDetailDto> {
  const answer = await client.request({
    method: "POST",
    path: "/Part",
    body: state.payload,
    ...(signal === undefined ? {} : { signal }),
  });
  const id = parseUpstream(
    z.object({ id: zId }),
    expectSingle(answer, "created part"),
    "the created part",
  ).id;
  return readBack(client, id, signal);
}

// ---------------------------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------------------------

export interface PartUpdateState {
  readonly id: number;
  readonly payload: PartUpdatePayload;
}

/**
 * Reads the part and works out what changes. Prices: a new price (net or gross) or a new tax
 * rate sends `priceNet`, `priceGross` and `taxRate` together, recomputed for the resulting rate;
 * without a new price the current net price is kept. Throws a `validation` SevdeskError when the
 * part number is taken, the unit is unknown, a price cannot be recomputed or nothing changes.
 */
export async function planPartUpdate(
  client: SevdeskClient,
  input: PartUpdateInput,
  signal?: AbortSignal,
): Promise<{ preview: ConfirmationPreview; state: PartUpdateState }> {
  const id = toSevdeskId(input.id);
  const [part, owner, unitName] = await Promise.all([
    getPartDetails(client, id, signal),
    input.partNumber === undefined
      ? Promise.resolve(undefined)
      : partNumberOwner(client, input.partNumber, signal),
    input.unitId === undefined
      ? Promise.resolve(undefined)
      : unitNameOf(client, input.unitId, signal),
  ]);
  if (owner !== undefined && owner !== id) {
    throw validation(`The part number is already used by part ${owner}.`);
  }

  const payload: Record<string, unknown> = {};
  const facts: ConfirmationFact[] = [
    {
      label: "Part",
      value: `${part.name} (id ${id}${part.partNumber === undefined ? "" : `, ${part.partNumber}`})`,
    },
  ];
  const changed: string[] = [];
  const change = (
    key: keyof PartUpdatePayload,
    label: string,
    before: string,
    after: string,
    value: unknown,
  ): void => {
    payload[key] = value;
    facts.push({ label, value: `${before} → ${after}` });
    changed.push(label.toLowerCase());
  };

  if (input.name !== undefined && input.name !== part.name) {
    change("name", "Name", part.name, input.name, input.name);
  }
  if (input.partNumber !== undefined && input.partNumber !== part.partNumber) {
    change("partNumber", "Part number", show(part.partNumber), input.partNumber, input.partNumber);
  }

  const currentRate = part.taxRate === undefined ? undefined : String(part.taxRate);
  const rate = input.taxRate ?? currentRate;
  const rateChanged =
    input.taxRate !== undefined &&
    (currentRate === undefined || compare(input.taxRate, currentRate) !== 0);
  if (input.price !== undefined || rateChanged) {
    if (rate === undefined) {
      throw validation(
        `Part ${id} has no tax rate in sevDesk: give taxRate together with the price.`,
      );
    }
    const basis = input.price ?? part.priceNet?.amount;
    const prices =
      basis === undefined
        ? undefined
        : pricePair(basis, input.price === undefined ? "net" : input.priceType, rate);
    const netChanged = prices !== undefined && !sameAmount(prices.net, part.priceNet?.amount);
    const grossChanged = prices !== undefined && !sameAmount(prices.gross, part.priceGross?.amount);
    if (netChanged || grossChanged || rateChanged) {
      if (prices !== undefined) {
        payload["priceNet"] = jsonNumber(prices.net);
        payload["priceGross"] = jsonNumber(prices.gross);
        facts.push(
          {
            label: "Price net",
            value: `${showMoney(part.priceNet?.amount)} → ${amountLabel(prices.net, input.price === undefined || input.priceType !== "net")}`,
          },
          {
            label: "Price gross",
            value: `${showMoney(part.priceGross?.amount)} → ${amountLabel(prices.gross, input.price === undefined || input.priceType !== "gross")}`,
          },
        );
        changed.push("price");
      }
      payload["taxRate"] = jsonNumber(rate);
      if (rateChanged) {
        facts.push({
          label: "Tax rate",
          value: `${currentRate === undefined ? "(none)" : `${currentRate} %`} → ${toDecimalString(rate)} %`,
        });
        changed.push("tax rate");
      }
    }
  }

  if (input.unitId !== undefined && input.unitId !== part.unitId) {
    change("unity", "Unit", show(part.unitId), unitLabel(input.unitId, unitName), {
      id: input.unitId,
      objectName: "Unity",
    });
  }
  if (
    input.pricePurchase !== undefined &&
    !sameAmount(input.pricePurchase, part.pricePurchase?.amount)
  ) {
    change(
      "pricePurchase",
      "Purchase price",
      showMoney(part.pricePurchase?.amount),
      amountLabel(format(input.pricePurchase, 2), false),
      jsonNumber(input.pricePurchase),
    );
  }
  if (
    input.stock !== undefined &&
    (part.stock === undefined || compare(input.stock, String(part.stock)) !== 0)
  ) {
    change(
      "stock",
      "Stock",
      show(part.stock),
      toDecimalString(input.stock),
      jsonNumber(input.stock),
    );
  }
  if (input.stockEnabled !== undefined && input.stockEnabled !== part.stockEnabled) {
    change(
      "stockEnabled",
      "Stock tracking",
      onOff(part.stockEnabled),
      onOff(input.stockEnabled),
      input.stockEnabled,
    );
  }
  if (input.active !== undefined && input.active !== part.active) {
    change(
      "status",
      "Status",
      part.active === undefined ? "(unknown)" : activeLabel(part.active),
      activeLabel(input.active),
      input.active ? ACTIVE : INACTIVE,
    );
  }
  if (input.description !== undefined && input.description !== part.description) {
    change("text", "Description", show(part.description), input.description, input.description);
  }
  if (input.internalComment !== undefined && input.internalComment !== part.internalComment) {
    change(
      "internalComment",
      "Internal note",
      show(part.internalComment),
      input.internalComment,
      input.internalComment,
    );
  }

  if (changed.length === 0) {
    throw validation(`Nothing to change: part ${id} already has these values.`);
  }
  const warnings: string[] = [];
  if (rateChanged && input.price === undefined && part.priceNet !== undefined) {
    warnings.push(
      "The tax rate changes and no new price was given: the net price stays, the gross price is recomputed.",
    );
  }
  return {
    preview: {
      action: `Update part ${display(part.name)} (id ${id}): ${changed.join(", ")}.`,
      facts,
      warnings,
      irreversible: false,
    },
    state: { id, payload: partUpdatePayloadSchema.parse(payload) },
  };
}

/** Sends the change (`PUT /Part/{id}`, never retried) and reads the part back. */
export async function executePartUpdate(
  client: SevdeskClient,
  state: PartUpdateState,
  signal?: AbortSignal,
): Promise<PartDetailDto> {
  await client.request({
    method: "PUT",
    path: sevdeskPath("Part", state.id),
    body: state.payload,
    ...(signal === undefined ? {} : { signal }),
  });
  return readBack(client, state.id, signal);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** The id of the part that has this part number (`GET /Part?partNumber=…`, re-checked exactly). */
async function partNumberOwner(
  client: SevdeskClient,
  partNumber: string,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  const page = await listParts(client, { partNumber, limit: 100, offset: 0 }, signal);
  return page.items
    .filter((part) => part.partNumber === partNumber)
    .map((part) => part.id)
    .sort((a, b) => a - b)[0];
}

/** The unit's name, or a `validation` error when the account has no such unit (`GET /Unity`). */
async function unitNameOf(
  client: SevdeskClient,
  unitId: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const units = await listUnits(client, signal);
  const unit = units.items.find((entry) => entry.id === unitId);
  if (unit === undefined) {
    throw validation(
      `Unit ${unitId} does not exist in this sevDesk account. Look units up with ` +
        "sevdesk_reference_lookup kind=units (1 = Stk).",
    );
  }
  return unit.name;
}

/**
 * The part after a write (`GET /Part/{id}`). A failed read-back carries the written part as
 * `completedWrites`, so nobody repeats the write that already happened.
 */
async function readBack(
  client: SevdeskClient,
  id: number,
  signal: AbortSignal | undefined,
): Promise<PartDetailDto> {
  try {
    return await getPartDetails(client, id, signal);
  } catch (error) {
    const written: CompletedWrite[] = [{ objectName: "Part", id: String(id) }];
    if (error instanceof SevdeskError) throw withCompletedWrites(error, written);
    throw new SevdeskError({
      kind: "unexpected_response",
      message: "The part was saved, but reading it back failed unexpectedly.",
      cause: error,
      completedWrites: written,
    });
  }
}

function sameAmount(a: string, b: string | undefined): boolean {
  return b !== undefined && compare(a, b) === 0;
}

function amountLabel(amount: string, computed: boolean): string {
  return `${amount} ${CURRENCY}${computed ? " (computed)" : ""}`;
}

function showMoney(amount: string | undefined): string {
  return amount === undefined ? "(none)" : `${amount} ${CURRENCY}`;
}

function show(value: string | number | undefined): string {
  return value === undefined ? "(empty)" : String(value);
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

function activeLabel(active: boolean): string {
  return active ? "active" : "inactive";
}

function unitLabel(id: number, name: string | undefined): string {
  return name === undefined ? `id ${id}` : `${name} (id ${id})`;
}

function display(value: string): string {
  return cleanText(value, DISPLAY_MAX) ?? "";
}

function pushFact(facts: ConfirmationFact[], label: string, value: string | undefined): void {
  if (value !== undefined) facts.push({ label, value });
}

function validation(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message });
}
