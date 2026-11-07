import { z } from "zod";

import type { Config } from "../../config.js";
import { listUsers, userDtoSchema } from "../../domain/users.js";
import { type Tier, TIERS } from "../../safety/tiers.js";
import { getBookkeepingSystemVersion, type SystemVersion } from "../../sevdesk/system-version.js";
import { defineTool } from "../define-tool.js";
import { TOOLSETS } from "../toolsets.js";

const output = z.object({
  bookkeepingSystemVersion: z
    .enum(["1.0", "2.0"])
    .describe("2.0 = 'Update 2.0': documents use taxRule, positions use accountDatev."),
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
    "'Update 2.0', which decides whether documents use taxRule or taxType), the sevDesk users " +
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
    const [version, users] = await Promise.all([
      getBookkeepingSystemVersion(ctx.client, ctx.signal),
      listUsers(ctx.client, ctx.signal),
    ]);
    const allowedTiers = TIERS.filter((tier) => ctx.config.allowedTiers.has(tier));
    const data = {
      bookkeepingSystemVersion: version,
      users: [...users.items],
      usersTotal: users.total,
      server: {
        allowedTiers,
        enabledToolsets: TOOLSETS.filter((toolset) => ctx.config.toolsets.has(toolset)),
        readOnly: ctx.config.readOnly,
        dryRun: ctx.config.dryRun,
        confirmMode: ctx.config.confirm,
      },
      notes: accountNotes(version, allowedTiers, ctx.config),
    };
    return {
      data,
      summary:
        `sevDesk bookkeeping system ${version}, ${plural(users.total, "user")}; ` +
        `allowed tiers: ${allowedTiers.join(", ")}.`,
    };
  },
});

/** Trusted guidance sentences; no upstream text. */
function accountNotes(
  version: SystemVersion,
  allowedTiers: readonly Tier[],
  config: Pick<Config, "readOnly" | "dryRun" | "confirm">,
): string[] {
  const notes: string[] = [
    version === "2.0"
      ? "Update 2.0 account: documents take a taxRule id (see sevdesk_reference_lookup " +
        "kind=tax_rules), positions an accountDatev."
      : "Bookkeeping system 1.0: documents use taxType (default, eu, noteu, ss) instead of " +
        "taxRule.",
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
