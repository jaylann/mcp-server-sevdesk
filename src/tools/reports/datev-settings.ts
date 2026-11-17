/**
 * `sevdesk_datev_settings_update`: set sevDesk's DATEV export settings (Beraternummer,
 * Mandantennummer, Wirtschaftsjahresbeginn) with `PUT /SevClient/{id}/updateExportConfig`
 * (`src/domain/exports/datev-settings.ts`), then read them back.
 *
 * Tier `commit` with a human confirmation: the settings are account-wide, every later DATEV
 * export carries them and the tax adviser's DATEV import files the data under them, so a wrong
 * number sends booking data to the wrong client. The preview shows each current value next to
 * the new one, in English and German.
 */
import { z } from "zod";

import { isoDateInput } from "../../domain/common.js";
import { readDatevExportConfig } from "../../domain/exports/datev.js";
import {
  ACCOUNTANT_NUMBER_MAX,
  ACCOUNTANT_NUMBER_MIN,
  CLIENT_NUMBER_MAX,
  CLIENT_NUMBER_MIN,
  currentDatevSettings,
  DATEV_NUMBER_RANGES,
  DATEV_SETTING_KEYS,
  type DatevSettingChange,
  type DatevSettingKey,
  type DatevSettingsPlan,
  planDatevSettings,
  storedDifferently,
  updateDatevExportConfig,
} from "../../domain/exports/datev-settings.js";
import { bothPreviews, dateText, type PreviewLanguage } from "../../domain/preview-text.js";
import { readBackOrReport } from "../banking/reconcile-shared.js";
import { defineWriteTool } from "../define-tool.js";
import type { SevdeskObjectRef } from "../types.js";
import { dryRunInputShape } from "../write-input.js";

/**
 * Lock key for the account's DATEV settings: the tool compares the current values with the new
 * ones and then writes all three, so two calls at once must not interleave.
 */
const ACCOUNT_DATEV_SETTINGS: SevdeskObjectRef = { objectName: "DatevSettings", id: "account" };

const LABELS: Readonly<Record<DatevSettingKey, Readonly<Record<PreviewLanguage, string>>>> = {
  accountantNumber: { en: "Beraternummer (accountant number)", de: "Beraternummer" },
  accountantClientNumber: { en: "Mandantennummer (client number)", de: "Mandantennummer" },
  accountingYearBegin: {
    en: "Wirtschaftsjahresbeginn (fiscal-year start)",
    de: "Wirtschaftsjahresbeginn",
  },
};

const settingsShape = {
  accountantNumber: z.string().optional().describe("Beraternummer; absent when not set."),
  accountantClientNumber: z.string().optional().describe("Mandantennummer; absent when not set."),
  accountingYearBegin: z
    .string()
    .optional()
    .describe("Wirtschaftsjahresbeginn, YYYY-MM-DD; absent when not set."),
};

const settingsOutput = z.object({
  settings: z
    .object(settingsShape)
    .describe("The DATEV settings as sevDesk stored them (read back after the change)."),
  changed: z
    .array(z.enum(DATEV_SETTING_KEYS))
    .describe("The settings this call changed (the others were sent unchanged)."),
  storedAsSent: z
    .boolean()
    .describe("True when sevDesk read back exactly the values sent; see warnings otherwise."),
  warnings: z.array(z.string()).describe("Trusted caveats."),
});

/** A value as the preview shows it. */
function shown(key: DatevSettingKey, value: string | undefined, lang: PreviewLanguage): string {
  if (value === undefined) return lang === "de" ? "(nicht gesetzt)" : "(not set)";
  return key === "accountingYearBegin" ? dateText(value, lang) : value;
}

/**
 * A current number outside DATEV's range that the call sends again unchanged (the spec requires
 * all three settings). `value` is sevDesk's digits-only value (`readDatevExportConfig`).
 */
function keptOutOfRangeText(
  key: keyof typeof DATEV_NUMBER_RANGES,
  value: string,
  lang: PreviewLanguage,
): string {
  const [min, max] = DATEV_NUMBER_RANGES[key];
  const range = `${String(min)}–${String(max)}`;
  return lang === "de"
    ? `Die bisherige ${LABELS[key].de} ${value} liegt außerhalb des DATEV-Bereichs (${range}) ` +
        "und wird unverändert erneut gesendet: Der DATEV-Import kann den Export ablehnen. Gib " +
        "die richtige Nummer der Steuerkanzlei mit an."
    : `The current ${LABELS[key].en} ${value} lies outside DATEV's range (${range}) and is ` +
        "sent again unchanged: DATEV's import may refuse the export. Give the right number " +
        "from the tax adviser as well.";
}

/** "1001 → 1234567" or "1234567 (unchanged)". */
function changeText(change: DatevSettingChange, lang: PreviewLanguage): string {
  if (!change.changed) {
    return `${shown(change.key, change.next, lang)} (${lang === "de" ? "unverändert" : "unchanged"})`;
  }
  return `${shown(change.key, change.current, lang)} → ${shown(change.key, change.next, lang)}`;
}

export const datevSettingsUpdateTool = defineWriteTool({
  name: "sevdesk_datev_settings_update",
  title: "Set sevDesk's DATEV export settings",
  description:
    "DATEV-Einstellungen: set the accountant number (Beraternummer, " +
    `${String(ACCOUNTANT_NUMBER_MIN)}–${String(ACCOUNTANT_NUMBER_MAX)}), the client number ` +
    `(Mandantennummer, ${String(CLIENT_NUMBER_MIN)}–${String(CLIENT_NUMBER_MAX)}) and the ` +
    "start of the fiscal year (Wirtschaftsjahresbeginn) that sevDesk's DATEV export needs " +
    "(sevdesk_datev_export refuses without them). Give only what changes; the others keep " +
    "sevDesk's values. Take the numbers from the tax adviser (Steuerberater), never guess them: " +
    "the adviser's DATEV files every export under them. Account-wide; commit tier: a human " +
    "confirms a preview of the current and new values; dryRun only previews. Reads the " +
    "settings back and reports what sevDesk stored.",
  toolset: "reports",
  tier: "commit",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({
    accountantNumber: z
      .number()
      .int()
      .min(ACCOUNTANT_NUMBER_MIN)
      .max(ACCOUNTANT_NUMBER_MAX)
      .optional()
      .describe(
        `Beraternummer of the tax adviser, ${String(ACCOUNTANT_NUMBER_MIN)}–` +
          `${String(ACCOUNTANT_NUMBER_MAX)}.`,
      ),
    accountantClientNumber: z
      .number()
      .int()
      .min(CLIENT_NUMBER_MIN)
      .max(CLIENT_NUMBER_MAX)
      .optional()
      .describe(
        `Mandantennummer at the adviser, ${String(CLIENT_NUMBER_MIN)}–${String(CLIENT_NUMBER_MAX)}.`,
      ),
    accountingYearBegin: isoDateInput
      .optional()
      .describe(
        "First day of the current fiscal year (Wirtschaftsjahresbeginn), YYYY-MM-DD, usually " +
          "January 1st.",
      ),
    ...dryRunInputShape,
  }),
  output: settingsOutput,
  locks: () => [ACCOUNT_DATEV_SETTINGS],
  prepare: async (args, ctx) => {
    const config = await readDatevExportConfig(ctx.client, ctx.signal);
    const plan = planDatevSettings(config, args);
    const yearBegin = plan.sent.accountingYearBegin;
    const unusualStart =
      plan.changes.some((change) => change.key === "accountingYearBegin" && change.changed) &&
      !yearBegin.endsWith("-01");
    return {
      ...bothPreviews((lang) => ({
        action:
          lang === "de"
            ? "DATEV-Exporteinstellungen in sevDesk ändern (gilt für das ganze Konto)."
            : "Change sevDesk's DATEV export settings (account-wide).",
        facts: plan.changes.map((change) => ({
          label: LABELS[change.key][lang],
          value: changeText(change, lang),
        })),
        warnings: [
          lang === "de"
            ? "Jeder spätere DATEV-Export trägt diese Nummern, und der DATEV-Import der " +
              "Steuerkanzlei ordnet die Daten danach zu: Falsche Nummern führen dazu, dass die " +
              "Buchungsdaten beim falschen Mandanten landen oder der Import scheitert."
            : "Every later DATEV export carries these numbers, and the tax adviser's DATEV " +
              "import files the data under them: wrong numbers put the booking data under the " +
              "wrong client or make the import fail.",
          ...plan.keptOutOfRange.map((key) => keptOutOfRangeText(key, plan.sent[key], lang)),
          lang === "de"
            ? "Der Wirtschaftsjahresbeginn bestimmt, wie DATEV-Exporte nach Wirtschaftsjahren " +
              "getrennt werden."
            : "The fiscal-year start decides how DATEV exports are split by fiscal year.",
          ...(unusualStart
            ? [
                lang === "de"
                  ? `Der Wirtschaftsjahresbeginn ${dateText(yearBegin, lang)} ist nicht der ` +
                    "Erste eines Monats; das ist nur bei einem Rumpfwirtschaftsjahr üblich."
                  : `The fiscal-year start ${yearBegin} is not the first day of a month; that ` +
                    "is usual only for a short fiscal year (Rumpfwirtschaftsjahr).",
              ]
            : []),
        ],
        irreversible: false,
      })),
      state: plan satisfies DatevSettingsPlan,
    };
  },
  execute: async (_args, plan, ctx) => {
    const settings = plan.state;
    await updateDatevExportConfig(ctx.client, settings, ctx.signal);
    const affected: SevdeskObjectRef[] = [
      { objectName: "SevClient", id: String(settings.clientId) },
    ];
    const stored = currentDatevSettings(
      await readBackOrReport(() => readDatevExportConfig(ctx.client, ctx.signal), affected),
    );
    const differing = storedDifferently(settings.sent, stored);
    const changed = settings.changes.filter((change) => change.changed).map((change) => change.key);
    const warnings = differing.map(
      (key) =>
        `sevDesk reads back ${LABELS[key].en} as ${stored[key] ?? "(not set)"}, not as sent ` +
        `(${settings.sent[key]}); check the DATEV settings in sevDesk (Einstellungen → DATEV-Export).`,
    );
    return {
      data: { settings: stored, changed, storedAsSent: differing.length === 0, warnings },
      summary:
        differing.length === 0
          ? `DATEV settings updated (${changed.join(", ")}); sevDesk stored the values as sent.`
          : `DATEV settings sent (${changed.join(", ")}), but sevDesk reads back ` +
            `${String(differing.length)} of them differently (see warnings).`,
      affected,
    };
  },
});
