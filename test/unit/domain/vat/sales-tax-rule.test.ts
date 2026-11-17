import { describe, expect, it } from "vitest";

import type { TaxRegime } from "../../../../src/domain/account-settings.js";
import { EU_STANDARD_RATES_AS_OF } from "../../../../src/domain/vat/eu.js";
import {
  customerAreaOf,
  type CustomerType,
  decideSalesTaxRule,
  DISCLAIMER,
  expectedSalesRuleIds,
  type SaleFacts,
  SUPPLY_KINDS,
  type SupplyKind,
  taxRuleMismatchWarning,
  vatIdShowsBusiness,
} from "../../../../src/domain/vat/sales-tax-rule.js";
import { checkVatIdFormat } from "../../../../src/domain/vat/vat-id.js";

const AT_VAT = checkVatIdFormat("ATU12345678");
const DE_VAT = checkVatIdFormat("DE123456789");
const BAD_VAT = checkVatIdFormat("ATU1234");
const XI_VAT = checkVatIdFormat("XI123456789");
const FR_VAT = checkVatIdFormat("FRXX123456789");
const ES_VAT = checkVatIdFormat("ESX1234567X");

/** The exception for a part of the state outside the EU VAT area: export or not taxable here. */
const outside = (supply: SupplyKind): number => (supply === "goods" ? 2 : 17);

function facts(
  regime: TaxRegime | undefined,
  country: string,
  customerType: CustomerType,
  supply: SupplyKind,
  vatId?: ReturnType<typeof checkVatIdFormat>,
): SaleFacts {
  return { regime, country, customerType, supply, vatId };
}

const REVERSE_CHARGE = "Steuerschuldnerschaft des Leistungsempfängers";

/**
 * Every combination on a regular-VAT account: customer place × type (with or without a VAT ID)
 * × supply → suggested rule ids (several when a fact decides that is not known here),
 * exceptions, the invoice note of the first suggestion, and a piece of its legal basis.
 */
const REGULAR: readonly {
  readonly label: string;
  readonly facts: SaleFacts;
  readonly suggestions: readonly number[];
  readonly exceptions: readonly number[];
  readonly note?: string;
  readonly basis: string;
}[] = [
  // Domestic (Inland); Heligoland and Büsingen are outside it
  ...SUPPLY_KINDS.map((supply) => ({
    label: `domestic business ${supply}`,
    facts: facts("regular", "DE", "business", supply, DE_VAT),
    suggestions: [1],
    exceptions: [4, 5, outside(supply)],
    basis: "§ 1 Abs. 1 Nr. 1",
  })),
  ...SUPPLY_KINDS.map((supply) => ({
    label: `domestic consumer ${supply}`,
    facts: facts("regular", "DE", "consumer", supply),
    suggestions: [1],
    exceptions: [4, outside(supply)],
    basis: "§ 12 UStG",
  })),
  // Intra-EU B2B: goods (innergemeinschaftliche Lieferung) and services (§ 13b / reverse charge)
  {
    label: "EU business goods with a VAT ID",
    facts: facts("regular", "AT", "business", "goods", AT_VAT),
    suggestions: [3],
    exceptions: [],
    note: "Steuerfreie innergemeinschaftliche Lieferung",
    basis: "§ 4 Nr. 1 Buchst. b, § 6a UStG",
  },
  {
    label: "EU business goods without a VAT ID",
    facts: facts("regular", "AT", "business", "goods"),
    suggestions: [1],
    exceptions: [3],
    basis: "§ 6a Abs. 1 Satz 1 Nr. 4 UStG",
  },
  {
    label: "EU business goods with a VAT ID in the wrong format",
    facts: facts("regular", "AT", "business", "goods", BAD_VAT),
    suggestions: [1],
    exceptions: [3],
    basis: "§ 6a Abs. 1 Satz 1 Nr. 4 UStG",
  },
  {
    label: "EU business goods with a German VAT ID",
    facts: facts("regular", "AT", "business", "goods", DE_VAT),
    suggestions: [1],
    exceptions: [3],
    basis: "§ 6a Abs. 1 Satz 1 Nr. 4 UStG",
  },
  ...(["services", "digital_services"] as const).map((supply) => ({
    label: `EU business ${supply} with a VAT ID`,
    facts: facts("regular", "AT", "business", supply, AT_VAT),
    suggestions: [21],
    exceptions: [1],
    note: REVERSE_CHARGE,
    basis: "§ 3a Abs. 2 UStG",
  })),
  {
    label: "EU business services without a VAT ID",
    facts: facts("regular", "AT", "business", "services"),
    suggestions: [21],
    exceptions: [1],
    note: REVERSE_CHARGE,
    basis: "§ 3a Abs. 2 UStG",
  },
  // EU consumers: OSS or German VAT, by the threshold
  {
    label: "EU consumer goods (distance sale)",
    facts: facts("regular", "AT", "consumer", "goods"),
    suggestions: [18, 1],
    exceptions: [],
    basis: "§ 3c Abs. 1 and 4 UStG",
  },
  {
    label: "EU consumer digital services",
    facts: facts("regular", "AT", "consumer", "digital_services"),
    suggestions: [19, 1],
    exceptions: [],
    basis: "§ 3a Abs. 5 UStG",
  },
  {
    label: "EU consumer services",
    facts: facts("regular", "AT", "consumer", "services"),
    suggestions: [1],
    exceptions: [20],
    basis: "§ 3a Abs. 1 UStG",
  },
  // Outside the EU: exports and services not taxable in Germany
  ...(["business", "consumer"] as const).map((customerType) => ({
    label: `non-EU ${customerType} goods (export)`,
    facts: facts("regular", "CH", customerType, "goods"),
    suggestions: [2],
    exceptions: [1],
    note: "Steuerfreie Ausfuhrlieferung",
    basis: "§ 4 Nr. 1 Buchst. a, § 6 UStG",
  })),
  ...(["services", "digital_services"] as const).map((supply) => ({
    label: `non-EU business ${supply}`,
    facts: facts("regular", "CH", "business", supply),
    suggestions: [17],
    exceptions: [1],
    note: "Nicht im Inland steuerbare Leistung",
    basis: "§ 3a Abs. 2 UStG",
  })),
  {
    label: "non-EU consumer digital services",
    facts: facts("regular", "CH", "consumer", "digital_services"),
    suggestions: [17],
    exceptions: [],
    note: "Nicht im Inland steuerbare Leistung",
    basis: "§ 3a Abs. 5 UStG",
  },
  {
    label: "non-EU consumer services (§ 3a Abs. 4 catalogue or not)",
    facts: facts("regular", "CH", "consumer", "services"),
    suggestions: [17, 1],
    exceptions: [],
    note: "Nicht im Inland steuerbare Leistung",
    basis: "§ 3a Abs. 4 UStG",
  },
];

describe("decideSalesTaxRule: regular VAT, every combination", () => {
  it.each(REGULAR)("$label", (row) => {
    const decision = decideSalesTaxRule(row.facts);
    expect(decision.suggestions.map((outcome) => outcome.taxRuleId)).toEqual(row.suggestions);
    expect(decision.exceptions.map((outcome) => outcome.taxRuleId)).toEqual(row.exceptions);
    expect(decision.decided).toBe(row.suggestions.length === 1);
    const [first] = decision.suggestions;
    expect(first?.legalBasis).toContain(row.basis);
    expect(first?.invoiceNote?.de).toBe(row.note);
    // Every outcome carries its legal basis and reason; open cases and exceptions say when.
    for (const outcome of [...decision.suggestions, ...decision.exceptions]) {
      expect(outcome.legalBasis).toMatch(/UStG|MwStSystRL/);
      expect(outcome.reason.length).toBeGreaterThan(10);
    }
    for (const outcome of decision.exceptions) expect(outcome.when).toBeDefined();
    if (!decision.decided) {
      for (const outcome of decision.suggestions) expect(outcome.when).toBeDefined();
    }
    // Rates: rule 1 at the German standard rate, 0 % for exempt and reverse-charge rules.
    for (const outcome of decision.suggestions) {
      if (outcome.taxRuleId === 1) expect(outcome.rate).toBe("19");
      if ([2, 3, 4, 5, 17, 21].includes(outcome.taxRuleId)) expect(outcome.rate).toBe("0");
    }
    expect(decision.notes).toContainEqual(expect.stringContaining("Istversteuerung"));
  });
});

describe("decideSalesTaxRule: Kleinunternehmer (§ 19 UStG)", () => {
  const cases = ["DE", "AT", "CH"].flatMap((country) =>
    (["business", "consumer"] as const).flatMap((customerType) =>
      SUPPLY_KINDS.map((supply) => ({ country, customerType, supply })),
    ),
  );

  it.each(cases)("$customerType in $country, $supply: rule 11", (row) => {
    const decision = decideSalesTaxRule(
      facts("small_business", row.country, row.customerType, row.supply, undefined),
    );
    // Only distance sales and digital services to EU consumers depend on the EU threshold.
    const toEuConsumer =
      row.country === "AT" && row.customerType === "consumer" && row.supply !== "services";
    expect(decision.decided).toBe(!toEuConsumer);
    expect(decision.warnings).toHaveLength(toEuConsumer ? 1 : 0);
    expect(decision.suggestions).toHaveLength(1);
    const [only] = decision.suggestions;
    expect(only).toMatchObject({ taxRuleId: 11, rate: "0", invoiceNote: { required: true } });
    expect(only?.invoiceNote?.de).toContain("§ 19 UStG");
    expect(only?.legalBasis).toContain("§ 19 Abs. 1 UStG");
    expect(decision.exceptions).toEqual([]);
    expect(decision.notes).toContainEqual(expect.stringContaining("25,000 €"));
  });

  it("says where the place of supply leaves the § 19 exemption behind", () => {
    const services = decideSalesTaxRule(
      facts("small_business", "AT", "business", "services", AT_VAT),
    );
    expect(services.notes).toContainEqual(expect.stringContaining(REVERSE_CHARGE));
  });

  it("leaves distance sales and digital services to EU consumers to the threshold", () => {
    for (const supply of ["goods", "digital_services"] as const) {
      const decision = decideSalesTaxRule(facts("small_business", "AT", "consumer", supply));
      expect(decision.decided, supply).toBe(false);
      expect(
        decision.suggestions.map((outcome) => outcome.taxRuleId),
        supply,
      ).toEqual([11]);
      expect(decision.suggestions[0]?.when, supply).toContain("at or below 10,000 € net");
      expect(decision.warnings, supply).toEqual([
        expect.stringContaining("sevDesk offers no One-Stop-Shop rule on a Kleinunternehmer"),
      ]);
      expect(decision.warnings[0], supply).toContain("Steuerberater");
    }
    // Northern Ireland counts as the EU for goods here too; ordinary services stay decided.
    const ni = decideSalesTaxRule(facts("small_business", "XI", "consumer", "goods"));
    expect(ni.decided).toBe(false);
    const services = decideSalesTaxRule(facts("small_business", "AT", "consumer", "services"));
    expect(services.decided).toBe(true);
    expect(services.suggestions[0]?.when).toBeUndefined();
  });
});

describe("decideSalesTaxRule: unknown regime", () => {
  it("assumes regular VAT, warns, and offers rule 11 as an exception", () => {
    const decision = decideSalesTaxRule(facts(undefined, "DE", "business", "goods"));
    expect(decision.decided).toBe(false);
    expect(decision.suggestions.map((outcome) => outcome.taxRuleId)).toEqual([1]);
    expect(decision.exceptions.map((outcome) => outcome.taxRuleId)).toEqual([4, 5, 2, 11]);
    expect(decision.warnings[0]).toContain("regular VAT is assumed");
  });
});

describe("decideSalesTaxRule: rates and notes", () => {
  it("gives One-Stop-Shop sales the customer country's dated standard rate", () => {
    const decision = decideSalesTaxRule(facts("regular", "FI", "consumer", "digital_services"));
    const [oss] = decision.suggestions;
    expect(oss).toMatchObject({ taxRuleId: 19, rate: "25.5" });
    expect(oss?.rateNote).toContain(EU_STANDARD_RATES_AS_OF);
    expect(oss?.when).toContain("10,000 €");
    const greece = decideSalesTaxRule(facts("regular", "GR", "consumer", "goods"));
    expect(greece.suggestions[0]).toMatchObject({ taxRuleId: 18, rate: "24" });
    const special = decideSalesTaxRule(facts("regular", "FR", "consumer", "services"));
    expect(special.exceptions[0]).toMatchObject({ taxRuleId: 20, rate: "20" });
  });

  it("leaves a rate out and says so when the table has none for the country", () => {
    const decision = decideSalesTaxRule(facts("regular", "AT", "consumer", "goods"), () => {
      return undefined;
    });
    expect(decision.suggestions[0]?.rate).toBeUndefined();
    expect(decision.suggestions[0]?.rateNote).toContain("not in this server's verified table");
  });

  it("says what the threshold and the OSS registration depend on", () => {
    const decision = decideSalesTaxRule(facts("regular", "AT", "consumer", "goods"));
    expect(decision.notes).toContainEqual(expect.stringContaining("One-Stop-Shop (§ 18j UStG"));
    expect(decision.suggestions[1]?.when).toContain("at or below 10,000 €");
  });

  it("asks for the VAT ID of an EU business and checks where it was issued", () => {
    const missing = decideSalesTaxRule(facts("regular", "AT", "business", "goods"));
    expect(missing.warnings).toContainEqual(expect.stringContaining("Ask the customer"));
    const services = decideSalesTaxRule(facts("regular", "AT", "business", "services"));
    expect(services.warnings).toContainEqual(expect.stringContaining("Zusammenfassende Meldung"));
    const bad = decideSalesTaxRule(facts("regular", "AT", "business", "goods", BAD_VAT));
    expect(bad.warnings).toContainEqual(
      expect.stringContaining("does not fit the format of Austria"),
    );
    const german = decideSalesTaxRule(facts("regular", "AT", "business", "goods", DE_VAT));
    expect(german.warnings).toContainEqual(expect.stringContaining("issued by Germany"));
    const consumer = decideSalesTaxRule(facts("regular", "AT", "consumer", "goods", AT_VAT));
    expect(consumer.warnings).toContainEqual(expect.stringContaining("customerType business"));
    const swiss = decideSalesTaxRule(
      facts("regular", "CH", "business", "services", checkVatIdFormat("CHE123456789")),
    );
    expect(swiss.warnings).toEqual([]);
  });

  it("carries the disclaimer in English and German", () => {
    expect(DISCLAIMER.en).toMatch(/^Not tax advice/);
    expect(DISCLAIMER.de).toMatch(/^Keine Steuerberatung/);
  });

  it("knows where a customer is for VAT", () => {
    const area = (country: string, supply: SupplyKind = "goods", vatId?: VatId) =>
      customerAreaOf({ country, supply, vatId });
    expect(area("de")).toBe("germany");
    expect(area("AT")).toBe("eu");
    expect(area("GR")).toBe("eu");
    expect(area("CH")).toBe("non_eu");
    expect(area("GB")).toBe("non_eu");
    // Monaco counts as France.
    expect(area("mc")).toBe("eu");
    expect(area("MC", "services")).toBe("eu");
    // Northern Ireland: the EU for goods, outside it for services.
    expect(area("XI")).toBe("eu");
    expect(area("xi", "services")).toBe("non_eu");
    expect(area("XI", "digital_services")).toBe("non_eu");
    expect(area("GB", "goods", XI_VAT)).toBe("eu");
    expect(area("GB", "services", XI_VAT)).toBe("non_eu");
    expect(area("GB", "goods", checkVatIdFormat("XI12345"))).toBe("non_eu");
    // Places outside the EU VAT area under their own code.
    expect(area("AX")).toBe("non_eu");
    expect(area("GP")).toBe("non_eu");
  });
});

type VatId = ReturnType<typeof checkVatIdFormat> | undefined;

const ruleIds = (outcomes: readonly { readonly taxRuleId: number }[]): number[] =>
  outcomes.map((outcome) => outcome.taxRuleId);

describe("decideSalesTaxRule: Northern Ireland (Windsor Framework)", () => {
  it("makes goods to a business with an XI VAT ID an intra-Community supply, not an export", () => {
    for (const country of ["GB", "XI"]) {
      const decision = decideSalesTaxRule(facts("regular", country, "business", "goods", XI_VAT));
      expect(decision.decided, country).toBe(true);
      expect(ruleIds(decision.suggestions), country).toEqual([3]);
      expect(decision.suggestions[0]?.reason, country).toContain("Northern Ireland");
      expect(decision.warnings, country).toEqual([]);
      expect(decision.notes, country).toContainEqual(expect.stringContaining("Windsor Framework"));
    }
  });

  it("asks for the XI VAT ID and treats goods to a consumer as a distance sale", () => {
    const missing = decideSalesTaxRule(facts("regular", "XI", "business", "goods"));
    expect(ruleIds(missing.suggestions)).toEqual([1]);
    expect(ruleIds(missing.exceptions)).toEqual([3]);
    expect(missing.warnings).toContainEqual(expect.stringContaining("Ask the customer"));
    const consumer = decideSalesTaxRule(facts("regular", "XI", "consumer", "goods"));
    expect(consumer.decided).toBe(false);
    expect(ruleIds(consumer.suggestions)).toEqual([18, 1]);
    expect(consumer.suggestions[0]?.rate).toBeUndefined();
    expect(consumer.suggestions[0]?.rateNote).toContain(
      "The standard rate of Northern Ireland is not in this server's verified table",
    );
  });

  it("keeps services outside the EU, also with an XI VAT ID", () => {
    const business = decideSalesTaxRule(facts("regular", "XI", "business", "services", XI_VAT));
    expect(ruleIds(business.suggestions)).toEqual([17]);
    expect(business.notes).toContainEqual(expect.stringContaining("Windsor Framework"));
    const viaGb = decideSalesTaxRule(facts("regular", "GB", "business", "services", XI_VAT));
    expect(ruleIds(viaGb.suggestions)).toEqual([17]);
    expect(viaGb.warnings).toEqual([]);
    const consumer = decideSalesTaxRule(facts("regular", "XI", "consumer", "digital_services"));
    expect(ruleIds(consumer.suggestions)).toEqual([17]);
  });

  it("gives goods to another GB customer the Northern Ireland case as an exception", () => {
    const business = decideSalesTaxRule(facts("regular", "GB", "business", "goods"));
    expect(ruleIds(business.suggestions)).toEqual([2]);
    expect(ruleIds(business.exceptions)).toEqual([1, 3]);
    expect(business.exceptions[1]?.when).toContain("Northern Ireland (XI…)");
    expect(business.notes).toContainEqual(expect.stringContaining("Windsor Framework"));
    const consumer = decideSalesTaxRule(facts("regular", "GB", "consumer", "goods"));
    expect(ruleIds(consumer.exceptions)).toEqual([1, 18]);
    expect(consumer.exceptions[1]?.when).toContain("the goods go to Northern Ireland");
    const services = decideSalesTaxRule(facts("regular", "GB", "business", "services"));
    expect(services.notes.join(" ")).not.toContain("Windsor");
  });

  it("names a VAT ID of another state for a customer in Northern Ireland", () => {
    const decision = decideSalesTaxRule(facts("regular", "XI", "business", "goods", AT_VAT));
    expect(decision.warnings).toContainEqual(
      expect.stringContaining("issued by Austria, but the customer is in Northern Ireland"),
    );
  });

  it("expects rule 3 on a draft for goods to Northern Ireland", () => {
    const customer = {
      regime: "regular" as const,
      country: "GB",
      customerType: "business" as const,
      vatId: XI_VAT,
    };
    expect([...expectedSalesRuleIds(customer)].sort((a, b) => a - b)).toEqual([3, 17]);
    expect(taxRuleMismatchWarning(2, customer)).toContain(
      "(a business in Northern Ireland with a VAT ID): 3 for goods, 17 for services and " +
        "digital services.",
    );
  });
});

describe("decideSalesTaxRule: Monaco counts as France", () => {
  it("takes French VAT IDs and the French rate, and says why", () => {
    const goods = decideSalesTaxRule(facts("regular", "MC", "business", "goods", FR_VAT));
    expect(ruleIds(goods.suggestions)).toEqual([3]);
    expect(goods.warnings).toEqual([]);
    expect(goods.notes).toContainEqual(expect.stringContaining("Monaco counts as France"));
    const services = decideSalesTaxRule(facts("regular", "MC", "business", "services", FR_VAT));
    expect(ruleIds(services.suggestions)).toEqual([21]);
    const digital = decideSalesTaxRule(facts("regular", "MC", "consumer", "digital_services"));
    expect(digital.suggestions[0]).toMatchObject({ taxRuleId: 19, rate: "20" });
    expect(digital.suggestions[0]?.reason).toContain("consumer in Monaco");
    expect(digital.suggestions[0]?.reason).toContain("the VAT of France applies");
    expect(
      taxRuleMismatchWarning(2, {
        regime: "regular",
        country: "MC",
        customerType: "business",
        vatId: FR_VAT,
      }),
    ).toContain("(a business in Monaco with a VAT ID): 3 for goods, 21 for services");
  });
});

describe("decideSalesTaxRule: parts of member states outside the EU VAT area", () => {
  it.each([
    ["ES", "the Canary Islands, Ceuta or Melilla"],
    ["IT", "Livigno, Campione d'Italia"],
    ["GR", "Mount Athos"],
    ["DE", "Heligoland or Büsingen am Hochrhein"],
  ])("%s: export for goods, not taxable here for services, as exceptions", (country, places) => {
    for (const supply of SUPPLY_KINDS) {
      for (const customerType of ["business", "consumer"] as const) {
        const decision = decideSalesTaxRule(facts("regular", country, customerType, supply));
        const last = decision.exceptions.at(-1);
        expect(last?.taxRuleId, `${supply} ${customerType}`).toBe(outside(supply));
        expect(last?.when, `${supply} ${customerType}`).toContain(places);
        expect(last?.legalBasis, `${supply} ${customerType}`).toContain("MwStSystRL");
      }
    }
  });

  it("keeps the usual rule as the suggestion and hints at the exception on a draft", () => {
    const decision = decideSalesTaxRule(facts("regular", "ES", "business", "goods", ES_VAT));
    expect(decision.decided).toBe(true);
    expect(ruleIds(decision.suggestions)).toEqual([3]);
    expect(ruleIds(decision.exceptions)).toEqual([2]);
    const services = decideSalesTaxRule(facts("regular", "ES", "consumer", "services"));
    expect(ruleIds(services.exceptions)).toEqual([20, 17]);
    expect(services.exceptions[1]?.when).toContain("§ 3a Abs. 4 UStG");
    expect(
      taxRuleMismatchWarning(2, {
        regime: "regular",
        country: "ES",
        customerType: "business",
        vatId: ES_VAT,
      }),
    ).toContain("It can still be right in a special case");
  });

  it("adds nothing for a state whose outside places have their own code", () => {
    const france = decideSalesTaxRule(facts("regular", "FR", "business", "goods", FR_VAT));
    expect(france.exceptions).toEqual([]);
    const austria = decideSalesTaxRule(facts("regular", "AT", "consumer", "digital_services"));
    expect(austria.exceptions).toEqual([]);
  });
});

describe("vatIdShowsBusiness", () => {
  it("counts a valid format, and outside the EU another country's number with digits", () => {
    expect(vatIdShowsBusiness(AT_VAT, "AT")).toBe(true);
    expect(vatIdShowsBusiness(XI_VAT, "GB")).toBe(true);
    expect(vatIdShowsBusiness(checkVatIdFormat("CHE-123.456.789"), "CH")).toBe(true);
    expect(vatIdShowsBusiness(checkVatIdFormat("GB123456789"), "XI")).toBe(true);
  });

  it("never counts placeholders, a wrong EU format, or a foreign number inside the EU", () => {
    for (const text of ["n/a", "-", "none", "keine", "ATU1234", "GR123456789"]) {
      expect(vatIdShowsBusiness(checkVatIdFormat(text), "AT"), text).toBe(false);
    }
    expect(vatIdShowsBusiness(checkVatIdFormat("none"), "CH")).toBe(false);
    expect(vatIdShowsBusiness(checkVatIdFormat("CHE123456789"), "DE")).toBe(false);
    // Monaco counts as France, so a foreign number is no sign there either.
    expect(vatIdShowsBusiness(checkVatIdFormat("CHE123456789"), "MC")).toBe(false);
  });
});

describe("the draft check", () => {
  it("expects every suggestion and the routine exceptions, for any kind of supply", () => {
    const ids = (
      regime: TaxRegime | undefined,
      country: string,
      type: CustomerType,
      vat?: boolean,
    ) =>
      [
        ...expectedSalesRuleIds({
          regime,
          country,
          customerType: type,
          vatId: vat === true ? (country === "DE" ? DE_VAT : AT_VAT) : undefined,
        }),
      ].sort((a, b) => a - b);
    expect(ids("regular", "DE", "business", true)).toEqual([1, 4, 5]);
    expect(ids("regular", "DE", "consumer")).toEqual([1, 4]);
    expect(ids("regular", "AT", "business", true)).toEqual([3, 21]);
    expect(ids("regular", "AT", "business")).toEqual([1, 21]);
    expect(ids("regular", "AT", "consumer")).toEqual([1, 18, 19]);
    expect(ids("regular", "CH", "business")).toEqual([2, 17]);
    expect(ids("regular", "CH", "consumer")).toEqual([1, 2, 17]);
    expect(ids("small_business", "AT", "business", true)).toEqual([11]);
    expect(ids(undefined, "DE", "business")).toEqual([1, 4, 5, 11]);
  });

  it("words a hint with the usual rules per kind of supply", () => {
    const business = { regime: "regular" as const, customerType: "business" as const };
    expect(taxRuleMismatchWarning(1, { ...business, country: "AT", vatId: AT_VAT })).toBe(
      "Tax rule 1 (Umsatzsteuerpflichtige Umsätze) is not the usual rule for this customer (a " +
        "business in Austria with a VAT ID): 3 for goods, 21 for services and digital services. " +
        "It can still be right in a special case; sevdesk_tax_rule_suggest explains the choice. " +
        "A hint, not tax advice.",
    );
    expect(taxRuleMismatchWarning(21, { ...business, country: "DE", vatId: DE_VAT })).toContain(
      "(a business in Germany with a VAT ID): 1 for goods, services and digital services.",
    );
    expect(taxRuleMismatchWarning(3, { ...business, country: "AT" })).toContain(
      "(a business in Austria without a VAT ID in a valid format): 1 for goods, 21 for services " +
        "and digital services.",
    );
    expect(
      taxRuleMismatchWarning(3, { regime: "regular", customerType: "consumer", country: "FR" }),
    ).toContain(
      "(a consumer in France): 18 or 1 for goods, 1 for services, 19 or 1 for digital services.",
    );
    expect(
      taxRuleMismatchWarning(1, { regime: "regular", customerType: "consumer", country: "CH" }),
    ).toBeUndefined();
    expect(
      taxRuleMismatchWarning(3, { ...business, country: "AT", vatId: AT_VAT }),
    ).toBeUndefined();
    expect(taxRuleMismatchWarning(5, { ...business, country: "DE" })).toBeUndefined();
  });
});
