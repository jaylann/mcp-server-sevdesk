/** Input/filter vocabularies shared with output keys; reverse lookups never guess unknown codes. */
export const INVOICE_STATUS_FILTERS = {
  draft: 100,
  open: 200,
  partially_paid: 750,
  paid: 1000,
} as const;

export const INVOICE_TYPE_FILTERS = {
  invoice: "RE",
  advance: "AR",
  partial: "TR",
  final: "ER",
  cancellation: "SR",
  reminder: "MA",
  recurring: "WKR",
} as const;

export const ORDER_STATUS_FILTERS = {
  draft: 100,
  sent: 200,
  rejected: 300,
  accepted: 500,
  partially_invoiced: 750,
  invoiced: 1000,
} as const;

export const ORDER_TYPE_FILTERS = {
  offer: "AN",
  order_confirmation: "AB",
  delivery_note: "LI",
} as const;

export const CREDIT_NOTE_STATUS_FILTERS = {
  draft: 100,
  open: 200,
  partially_paid: 750,
  paid: 1000,
} as const;

/** Spec tag `Voucher` statuses (see spec/deviations.md D-007). */
export const VOUCHER_STATUS_CODES = {
  draft: 50,
  open: 100,
  transferred: 150,
  partially_paid: 750,
  paid: 1000,
} as const;

/** Spec tag `Voucher`: VOU normal, RV recurring. */
export const VOUCHER_TYPE_CODES = {
  normal: "VOU",
  recurring: "RV",
} as const;

/** Spec `Model_CheckAccountTransactionResponse.status` (350 only there, D-031). */
export const TRANSACTION_STATUS_CODES = {
  created: 100,
  linked: 200,
  private: 300,
  auto_booked: 350,
  booked: 400,
} as const;

/** Credit note draft categories supported on Update 2.0; ACCOUNTING_TYPE is unsupported. */
export const BOOKING_CATEGORY_NAMES = {
  underachievement: "UNDERACHIEVEMENT",
  provision: "PROVISION",
  royalty_assigned: "ROYALTY_ASSIGNED",
  royalty_unassigned: "ROYALTY_UNASSIGNED",
} as const;

/** Returns the accepted input key for a code, or nothing when no input accepts it. */
export function keyForCode(
  mapping: Readonly<Record<string, string | number>>,
  code: string | number,
): string | undefined {
  return Object.entries(mapping).find(([, value]) => value === code)?.[0];
}

/** Status mappings for each record kind. Contacts have no status input/filter. */
export const STATUS_FILTERS = {
  invoice: INVOICE_STATUS_FILTERS,
  creditNote: CREDIT_NOTE_STATUS_FILTERS,
  order: ORDER_STATUS_FILTERS,
  voucher: VOUCHER_STATUS_CODES,
  transaction: TRANSACTION_STATUS_CODES,
  contact: {},
};
