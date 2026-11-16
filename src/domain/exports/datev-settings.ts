/**
 * Setting sevDesk's DATEV export settings: Beraternummer (`accountantNumber`), Mandantennummer
 * (`accountantClientNumber`) and the start of the fiscal year (Wirtschaftsjahresbeginn,
 * `accountingYearBegin`) with `PUT /SevClient/{id}/updateExportConfig` (D-067).
 *
 * Recorded on 2026-11-08 (probe `write-export-datev-config`): the body
 * `{accountantNumber: 1001, accountantClientNumber: 1, accountingYearBegin: <Unix seconds of
 * Berlin midnight>}` (JSON numbers, as the spec types them) answered `{objects: null}`, and
 * `GET /SevClient` read the three back as numeric strings and a date-time. The spec requires all
 * three in every call, so a value the caller leaves out is sent as sevDesk holds it now; a call
 * that would change nothing is refused before anything is sent.
 *
 * The settings are account-wide: every later DATEV export carries them, and the tax adviser's
 * DATEV import files the data under them. Hence the tool is `commit` tier with a preview of the
 * current values next to the new ones, and reads the settings back afterwards.
 */
import { toUnixSeconds } from "../../sevdesk/dates.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import type { DatevExportConfig } from "./datev.js";

/**
 * Valid ranges of the two DATEV numbers. Source: DATEV's format description of the DATEV-Format
 * (EXTF) header, fields "Beraternummer" (1001–9999999) and "Mandantennummer" (1–99999), which is
 * where sevDesk's export writes them; the sevDesk spec only types them as numbers. A number
 * outside these ranges cannot be imported by the adviser's DATEV, so it is refused here.
 */
export const ACCOUNTANT_NUMBER_MIN = 1001;
export const ACCOUNTANT_NUMBER_MAX = 9_999_999;
export const CLIENT_NUMBER_MIN = 1;
export const CLIENT_NUMBER_MAX = 99_999;

/** The three settings, in the order previews and results list them. */
export const DATEV_SETTING_KEYS = [
  "accountantNumber",
  "accountantClientNumber",
  "accountingYearBegin",
] as const;
export type DatevSettingKey = (typeof DATEV_SETTING_KEYS)[number];

/** Values as this server shows them: digit strings and `YYYY-MM-DD`. */
export type DatevSettingValues = Readonly<Partial<Record<DatevSettingKey, string>>>;

/** What the caller asked for; absent keys keep sevDesk's current value. */
export interface DatevSettingsInput {
  readonly accountantNumber?: number | undefined;
  readonly accountantClientNumber?: number | undefined;
  /** `YYYY-MM-DD`. */
  readonly accountingYearBegin?: string | undefined;
}

/** One setting before and after. */
export interface DatevSettingChange {
  readonly key: DatevSettingKey;
  /** sevDesk's value now; absent when not set. */
  readonly current?: string | undefined;
  readonly next: string;
  readonly changed: boolean;
}

/** The body of `updateExportConfig` (the recorded form: JSON numbers, Unix seconds). */
interface UpdateExportConfigBody {
  readonly accountantNumber: number;
  readonly accountantClientNumber: number;
  readonly accountingYearBegin: number;
}

export interface DatevSettingsPlan {
  readonly clientId: number;
  readonly changes: readonly DatevSettingChange[];
  readonly body: UpdateExportConfigBody;
  /** The values sent, as this server shows them (for the read-back comparison). */
  readonly sent: Required<Record<DatevSettingKey, string>>;
}

/** Readable names, for errors. */
const NAMES: Readonly<Record<DatevSettingKey, string>> = {
  accountantNumber: "accountantNumber (Beraternummer)",
  accountantClientNumber: "accountantClientNumber (Mandantennummer)",
  accountingYearBegin: "accountingYearBegin (Wirtschaftsjahresbeginn)",
};

/** The current values of a `readDatevExportConfig` result. */
export function currentDatevSettings(config: DatevExportConfig): DatevSettingValues {
  return {
    ...(config.accountantNumber === undefined ? {} : { accountantNumber: config.accountantNumber }),
    ...(config.accountantClientNumber === undefined
      ? {}
      : { accountantClientNumber: config.accountantClientNumber }),
    ...(config.accountingYearBegin === undefined
      ? {}
      : { accountingYearBegin: config.accountingYearBegin }),
  };
}

/**
 * Plans the update: checks the formats, fills what the caller left out from the current values,
 * and refuses (local `validation` error, nothing sent) when nothing was given, a value is out of
 * range, a setting would stay unset, nothing would change, or the account id is unknown.
 */
export function planDatevSettings(
  config: DatevExportConfig,
  input: DatevSettingsInput,
): DatevSettingsPlan {
  const given = DATEV_SETTING_KEYS.filter((key) => input[key] !== undefined);
  if (given.length === 0) {
    throw invalid(
      "give at least one of accountantNumber, accountantClientNumber and accountingYearBegin.",
    );
  }
  checkRange(
    input.accountantNumber,
    ACCOUNTANT_NUMBER_MIN,
    ACCOUNTANT_NUMBER_MAX,
    "accountantNumber (Beraternummer)",
  );
  checkRange(
    input.accountantClientNumber,
    CLIENT_NUMBER_MIN,
    CLIENT_NUMBER_MAX,
    "accountantClientNumber (Mandantennummer)",
  );
  const current = currentDatevSettings(config);
  const asked: DatevSettingValues = {
    ...(input.accountantNumber === undefined
      ? {}
      : { accountantNumber: String(input.accountantNumber) }),
    ...(input.accountantClientNumber === undefined
      ? {}
      : { accountantClientNumber: String(input.accountantClientNumber) }),
    ...(input.accountingYearBegin === undefined
      ? {}
      : { accountingYearBegin: input.accountingYearBegin }),
  };
  const unset = DATEV_SETTING_KEYS.filter(
    (key) => asked[key] === undefined && current[key] === undefined,
  );
  if (unset.length > 0) {
    throw invalid(
      `sevDesk takes all three DATEV settings together, and ` +
        `${unset.map((key) => NAMES[key]).join(", ")} ${unset.length === 1 ? "is" : "are"} not ` +
        "set in sevDesk yet: give them as well.",
    );
  }
  const changes = DATEV_SETTING_KEYS.map((key): DatevSettingChange => {
    const next = asked[key] ?? current[key] ?? "";
    return { key, current: current[key], next, changed: next !== current[key] };
  });
  if (!changes.some((change) => change.changed)) {
    throw invalid("sevDesk already has these DATEV settings; nothing to change.");
  }
  if (config.clientId === undefined) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        "sevDesk's account settings (GET /SevClient) carry no readable account id, so the DATEV " +
        "settings cannot be addressed. Nothing was sent.",
    });
  }
  const nextOf = (key: DatevSettingKey): string =>
    changes.find((change) => change.key === key)?.next ?? "";
  const sent = {
    accountantNumber: nextOf("accountantNumber"),
    accountantClientNumber: nextOf("accountantClientNumber"),
    accountingYearBegin: nextOf("accountingYearBegin"),
  };
  return {
    clientId: config.clientId,
    changes,
    sent,
    body: {
      accountantNumber: Number(sent.accountantNumber),
      accountantClientNumber: Number(sent.accountantClientNumber),
      accountingYearBegin: toUnixSeconds(sent.accountingYearBegin, "start"),
    },
  };
}

/**
 * Sends `PUT /SevClient/{id}/updateExportConfig` (a write; the caller's client must be
 * tier-scoped; never retried). sevDesk answers `{objects: null}`, so the result is read back
 * separately.
 */
export async function updateDatevExportConfig(
  client: SevdeskClient,
  plan: Pick<DatevSettingsPlan, "clientId" | "body">,
  signal?: AbortSignal,
): Promise<void> {
  await client.request({
    method: "PUT",
    path: sevdeskPath("SevClient", plan.clientId, "updateExportConfig"),
    body: plan.body,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** The settings whose stored value differs from what was sent (none when sevDesk kept them all). */
export function storedDifferently(
  sent: Required<Record<DatevSettingKey, string>>,
  stored: DatevSettingValues,
): DatevSettingKey[] {
  return DATEV_SETTING_KEYS.filter((key) => stored[key] !== sent[key]);
}

function checkRange(value: number | undefined, min: number, max: number, name: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(
      `${name} must be a whole number from ${String(min)} to ${String(max)} (DATEV's range).`,
    );
  }
}

function invalid(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message: `Invalid request: ${message}` });
}
