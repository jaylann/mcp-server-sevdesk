/** Tool groups users can enable with `SEVDESK_TOOLSETS`. */
export const TOOLSETS = [
  "meta",
  "contacts",
  "invoices",
  "credit-notes",
  "orders",
  "vouchers",
  "banking",
  "parts",
  "reports",
  "advanced",
] as const;

export type ToolsetName = (typeof TOOLSETS)[number];

/** Enabled when `SEVDESK_TOOLSETS` is unset: everything except opt-in power tools. */
export const DEFAULT_TOOLSETS: readonly ToolsetName[] = TOOLSETS.filter(
  (toolset) => toolset !== "advanced",
);

export function isToolsetName(value: string): value is ToolsetName {
  return (TOOLSETS as readonly string[]).includes(value);
}
