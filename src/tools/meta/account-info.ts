import { z } from "zod";

import type { Config } from "../../config.js";
import { loadAccountSettings, taxRegimeOf } from "../../domain/account-settings.js";
import { listUsers, userDtoSchema } from "../../domain/users.js";
import { type Tier, TIERS } from "../../safety/tiers.js";
import { getBookkeepingSystemVersion, type SystemVersion } from "../../sevdesk/system-version.js";
import { defineTool } from "../define-tool.js";
import { TOOLSETS } from "../toolsets.js";

const output = z.object({
  bookkeepingSystemVersion: z
    .enum(["1.0", "2.0"])
    .describe("2.0 = 'Update 2.0': documents use taxRule, positions use accountDatev."),
  taxRegime: z
    .enum(["regular", "small_business", "unknown"])
    .describe(
      "VAT regulation: regular (Regelbesteuerung, charges VAT) or small_business " +
        "(Kleinunternehmer, §19 UStG: no VAT, tax rule 11); unknown when sevDesk did not say.",
    ),
  chartOfAccounts: z
    .string()
    .optional()
    .describe("Chart of accounts (Kontenrahmen), e.g. skr03 or skr04."),
  users: z.array(userDtoSchema).describe("sevDesk users (SevUser)."),
  usersTotal: z.number().int(),
  server: z
    .object({
      allowedTiers: z.array(z.enum(TIERS)),
      enabledToolsets: z.array(z.enum(TOOLSETS)),
      readOnly: z.boolean(),
      dryRun: z.boolean(),
      confirmMode: z.enum(["elicit", "browser", "off"]),
    })
    .describe("What this MCP server is configured to allow."),
  notes: z.array(z.string()).describe("Guidance derived from the version and the configuration."),
});

/** `sevdesk_account_info`: orientation for the model, meant to be the first call. */
export const accountInfoTool = defineTool({
  name: "sevdesk_account_info",
  title: "sevDesk account overview",
  description:
    "Overview of the connected sevDesk account and of this server's permissions. Call it first " +
    "in a session to orient yourself: it returns the bookkeeping system version (1.0 or " +
    "'Update 2.0', which decides whether documents use taxRule or taxType), the VAT regulation " +
    "(regular or Kleinunternehmer, which decides the tax rules) and chart of accounts, the sevDesk users " +
    "(Benutzer; their ids are needed as contactPerson on invoices, orders and credit notes) and " +
    "which permission tiers (read, write, commit, external), toolsets, dry-run and confirmation " +
    "mode are active, so you know what you may do before you try.",
  toolset: "meta",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({}),
  output,
  handler: async (_args, ctx) => {
    const [version, users, settings] = await Promise.all([
      getBookkeepingSystemVersion(ctx.client, ctx.signal),
      listUsers(ctx.client, ctx.signal),
      loadAccountSettings(ctx.client, {
        cacheOwner: ctx.config,
        signal: ctx.signal,
        fresh: true,
      }),
    ]);
    const regime: RegimeInfo = taxRegimeOf(settings) ?? "unknown";
    const allowedTiers = TIERS.filter((tier) => ctx.config.allowedTiers.has(tier));
    const data = {
      bookkeepingSystemVersion: version,
      taxRegime: regime,
      ...(settings?.chartOfAccounts === undefined
        ? {}
        : { chartOfAccounts: settings.chartOfAccounts }),
      users: [...users.items],
      usersTotal: users.total,
      server: {
        allowedTiers,
        enabledToolsets: TOOLSETS.filter((toolset) => ctx.config.toolsets.has(toolset)),
        readOnly: ctx.config.readOnly,
        dryRun: ctx.config.dryRun,
        confirmMode: ctx.config.confirm,
      },
      notes: accountNotes(version, regime, allowedTiers, ctx.config),
    };
    return {
      data,
      summary:
        `sevDesk bookkeeping system ${version}, ${REGIME_SUMMARY[regime]}, ` +
        `${plural(users.total, "user")}; allowed tiers: ${allowedTiers.join(", ")}.`,
    };
  },
});

type RegimeInfo = "regular" | "small_business" | "unknown";

const REGIME_SUMMARY: Readonly<Record<RegimeInfo, string>> = {
  regular: "regular VAT",
  small_business: "Kleinunternehmer (§19 UStG)",
  unknown: "VAT regulation unknown",
};

const REGIME_NOTES: Readonly<Record<RegimeInfo, string>> = {
  regular:
    "Regular VAT (Regelbesteuerung): documents default to tax rule 1 (0, 7 or 19 %); tax rule " +
    "11 (Kleinunternehmer) is refused.",
  small_business:
    "Kleinunternehmer account (§19 UStG): documents show no VAT and use tax rule 11 with 0 % " +
    "(the draft tools' default); rules for regular VAT such as 1 are refused, because sevDesk " +
    "would not finalize such documents.",
  unknown:
    "The VAT regulation could not be read (GET /SevClient), so the draft tools cannot check " +
    "whether a tax rule fits the account; their previews say so.",
};

/** Trusted guidance sentences; no upstream text. */
function accountNotes(
  version: SystemVersion,
  regime: RegimeInfo,
  allowedTiers: readonly Tier[],
  config: Pick<Config, "readOnly" | "dryRun" | "confirm">,
): string[] {
  const notes: string[] = [
    version === "2.0"
      ? "Update 2.0 account: documents take a taxRule id (see sevdesk_reference_lookup " +
        "kind=tax_rules), positions an accountDatev."
      : "Bookkeeping system 1.0: documents use taxType (default, eu, noteu, ss) instead of " +
        "taxRule.",
    REGIME_NOTES[regime],
  ];
  if (allowedTiers.length === 1) {
    notes.push(
      config.readOnly
        ? "Read-only mode (SEVDESK_READ_ONLY): nothing in sevDesk can be changed through this " +
            "server."
        : "Only read tools are enabled. Changes need the user to allow more tiers via " +
            "SEVDESK_ALLOW.",
    );
  }
  if (config.dryRun) {
    notes.push("Dry-run is on: write tools report what they would send without changing sevDesk.");
  }
  if (allowedTiers.includes("commit") || allowedTiers.includes("external")) {
    notes.push(
      config.confirm === "off"
        ? "Human confirmation is switched off: binding actions run without asking the user."
        : "Binding actions (commit and external tiers) ask the user for confirmation first.",
    );
  }
  return notes;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
