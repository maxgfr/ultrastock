// Tax rules: the schema only. ultrastock contains no tax law — no rate, no
// threshold, no ceiling, no holding period. Every value a tax engine reads comes
// from facts the agent researched on official sources for the user's country
// and tax year, stored with `tax rules set` through the researched-facts store
// (core/researched.ts) as its "tax" domain:
//
//   <home>/facts/tax/<CC>-<year>.json   (ISO 3166 alpha-2 country, tax year)
//
// This module registers what to research — for France and the United States
// the keys their engines read, for any other country a generic list — each with
// a label, a type, a unit, a search query and the kind of official source to
// prefer. Without a file for the exact year, or with a key an engine reads
// missing, the engines refuse: there is no fallback to an earlier year, because
// tax law changes every year.
import { UsageError } from "../engine.js";
import {
  type ChecklistItem,
  countryCode,
  defineDomain,
  type Fact,
  type FactSpec,
  factsChecklist,
  factsPath,
  factsTemplate,
  factValue,
  loadFacts,
  saveFacts,
  storedPeriods,
  type ValidatedFacts,
  validateFacts,
} from "../core/researched.js";

export type { ChecklistItem, Confidence, Fact } from "../core/researched.js";

export interface ParamSpec extends FactSpec {
  /** Who reads it: an engine's computation, or only the neutral report (shown beside the facts). */
  usedBy: "engine" | "report";
}

/** A country's researched tax rules for one tax year, as the engines read them (stale facts left out). */
export interface RuleSet {
  country: string;
  year: number;
  /** The currency amounts in the file are in (the country's tax currency). */
  currency: string;
  researchedAt: string;
  note?: string;
  facts: Record<string, Fact>;
}

/** A form line or box an engine writes to: engine structure, but numbered by the year's form — to check each year. */
export interface FormLineSpec {
  form: string;
  lines: string;
  usedFor: string;
}

const FR_OFFICIAL = "service-public.fr / impots.gouv.fr / BOFiP / Légifrance";
const US_OFFICIAL = "IRS publication / IRS topic page / Rev. Proc. / Internal Revenue Code";

const COST_METHOD = {
  key: "costMethod",
  label: "cost-basis method the law prescribes for individuals (fifo, average, or describe another)",
  type: "text",
  unit: 'text: "fifo", "average" or a description',
  query: "",
  prefer: "",
  usedBy: "report",
  note: "the neutral report shows the cost under FIFO and under the weighted average, and marks the one this names",
} as const;

/** What the French engine reads (FranceRegime). */
export const FR_SPEC = [
  {
    key: "pfu.ir",
    label: "flat tax (PFU) on investment income and gains — its income-tax part",
    type: "rate",
    unit: "fraction of 1",
    query: "prélèvement forfaitaire unique taux impôt sur le revenu revenus {period}",
    prefer: FR_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "ps.capital",
    label: "prélèvements sociaux on capital gains and dividends (ordinary account, PEA withdrawals, crypto)",
    type: "rate",
    unit: "fraction of 1",
    query: "prélèvements sociaux revenus du patrimoine et placements taux {period} CSG",
    prefer: `${FR_OFFICIAL} / loi de financement de la sécurité sociale`,
    usedBy: "engine",
  },
  {
    key: "ps.assuranceVie",
    label: "prélèvements sociaux on assurance-vie gains",
    type: "rate",
    unit: "fraction of 1",
    query: "prélèvements sociaux assurance-vie taux {period}",
    prefer: `${FR_OFFICIAL} / loi de financement de la sécurité sociale`,
    usedBy: "engine",
  },
  {
    key: "csg.deductible",
    label: "deductible CSG under the progressive-scale option",
    type: "rate",
    unit: "fraction of 1",
    query: "CSG déductible revenus du capital option barème {period}",
    prefer: FR_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "dividend.abattement",
    label: "dividend allowance under the progressive-scale option (2OP)",
    type: "rate",
    unit: "fraction of 1",
    query: "abattement dividendes option barème progressif {period}",
    prefer: FR_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "losses.carryforwardYears",
    label: "years a net capital loss on securities can be carried forward",
    type: "number",
    unit: "years",
    query: "moins-values mobilières report années imputation {period} BOI-RPPM-PVBMI",
    prefer: FR_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "securities.allowanceAcquiredBefore",
    label: "acquisition date before which shares may still get the holding-period allowance under the progressive-scale option",
    type: "date",
    unit: "ISO date",
    query: "abattement pour durée de détention titres acquis avant option barème {period}",
    prefer: FR_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "pea.ceiling",
    label: "PEA deposit ceiling",
    type: "amount",
    unit: "tax currency",
    query: "plafond versements PEA {period}",
    prefer: FR_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "peaPme.ceilingCombined",
    label: "PEA + PEA-PME combined deposit ceiling",
    type: "amount",
    unit: "tax currency",
    query: "plafond PEA-PME cumul PEA {period}",
    prefer: FR_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "pea.minYears",
    label: "PEA age after which withdrawals are free of income tax (and do not close the plan)",
    type: "number",
    unit: "years",
    query: "PEA retrait après combien d'années exonération impôt sur le revenu {period}",
    prefer: FR_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "crypto.exemptionThreshold",
    label: "annual total of crypto disposal prices (net of fees) at or below which the year's crypto gains are exempt",
    type: "amount",
    unit: "tax currency",
    query: "article 150 VH bis seuil exonération cessions actifs numériques {period} formulaire 2086",
    prefer: `${FR_OFFICIAL} (CGI art. 150 VH bis, notice 2086)`,
    usedBy: "engine",
    note: 'read whether the threshold is net of fees and whether the threshold itself is exempt ("n\'excède pas")',
  },
  {
    key: "av.reducedRate",
    label: "assurance-vie income tax on gains once the contract has reached the reduced-rate age, premiums up to the threshold",
    type: "rate",
    unit: "fraction of 1",
    query: "fiscalité assurance-vie rachat contrat ancien taux réduit {period}",
    prefer: FR_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "av.premiumThreshold",
    label: "assurance-vie premiums (all contracts, net of withdrawals) above which the flat-tax rate applies even after the reduced-rate age",
    type: "amount",
    unit: "tax currency",
    query: "assurance-vie seuil primes versées taux réduit {period}",
    prefer: FR_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "av.minYears",
    label: "assurance-vie contract age for the reduced rate and the allowance",
    type: "number",
    unit: "years",
    query: "assurance-vie durée du contrat abattement taux réduit {period}",
    prefer: FR_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "av.abattement.single",
    label: "assurance-vie yearly allowance on gains after the reduced-rate age, single person",
    type: "amount",
    unit: "tax currency",
    query: "abattement assurance-vie célibataire {period}",
    prefer: FR_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "av.abattement.couple",
    label: "assurance-vie yearly allowance on gains after the reduced-rate age, couple filing jointly",
    type: "amount",
    unit: "tax currency",
    query: "abattement assurance-vie couple {period}",
    prefer: FR_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "us.dividendWithholdingTreaty",
    label: "US withholding on dividends paid to a French resident with a W-8BEN (France–US treaty), creditable in France",
    type: "rate",
    unit: "fraction of 1",
    query: "convention fiscale France États-Unis retenue à la source dividendes W-8BEN {period}",
    prefer: `${FR_OFFICIAL} / irs.gov tax treaties`,
    usedBy: "engine",
  },
  {
    key: "us.dividendWithholdingStatutory",
    label: "US withholding on dividends paid to a nonresident without a treaty form",
    type: "rate",
    unit: "fraction of 1",
    query: "IRS withholding on dividends nonresident alien without W-8BEN {period}",
    prefer: "irs.gov (Publication 515)",
    usedBy: "engine",
  },
  {
    key: "div2778.dueDay",
    label: "day of the month after a payment by which form 2778-DIV and its payment are due",
    type: "number",
    unit: "day of the following month",
    query: "formulaire 2778-DIV date limite dépôt paiement {period}",
    prefer: FR_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "pfnl.exemptionDeadline",
    label: "deadline to ask the paying agent for an exemption from the flat-tax instalment (PFNL), below the income thresholds",
    type: "text",
    unit: "text (a date in the year before)",
    query: "dispense prélèvement forfaitaire non libératoire date limite demande {period}",
    prefer: FR_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "penalty.3916",
    label: "fine per foreign account not declared on form 3916",
    type: "amount",
    unit: "tax currency",
    query: "amende compte étranger non déclaré formulaire 3916 {period}",
    prefer: `${FR_OFFICIAL} (CGI art. 1736)`,
    usedBy: "engine",
  },
  {
    key: "penalty.3916bis",
    label:
      "fine per foreign crypto account not declared on form 3916-bis: the standard amount, the amount above the account-value threshold, and that threshold",
    type: "amounts",
    unit: "tax currency",
    fields: ["standard", "aboveThreshold", "threshold"],
    query: "amende compte d'actifs numériques étranger non déclaré 3916-bis {period}",
    prefer: `${FR_OFFICIAL} (CGI art. 1736)`,
    usedBy: "engine",
  },
  {
    ...COST_METHOD,
    query: "prix de revient moyen pondéré cession valeurs mobilières article 150-0 D {period}",
    prefer: FR_OFFICIAL,
  },
] as const satisfies readonly ParamSpec[];

/** What the US engine reads (UsRegime). */
export const US_SPEC = [
  {
    key: "ltcg.thresholds",
    label: "taxable income at which the middle and the top long-term capital gains rates start, by filing status",
    type: "amounts",
    unit: "USD of taxable income",
    fields: ["singleLow", "singleMid", "jointLow", "jointMid", "separateLow", "separateMid", "headLow", "headMid"],
    query: "IRS Rev. Proc. inflation adjustments {period} maximum zero rate amount long-term capital gains brackets",
    prefer: US_OFFICIAL,
    usedBy: "engine",
    note: "<status>Low is the taxable income where the lowest rate ends; <status>Mid is where the middle rate ends",
  },
  {
    key: "ltcg.rates",
    label: "the three long-term capital gains and qualified dividend rates, lowest to highest",
    type: "rates",
    unit: "fraction of 1",
    fields: ["low", "mid", "high"],
    query: "IRS topic 409 capital gains rates {period}",
    prefer: US_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "capitalLoss.ordinaryLimit",
    label: "net capital loss deductible against ordinary income per year",
    type: "amount",
    unit: "USD",
    query: "IRS capital loss deduction limit {period} topic 409",
    prefer: US_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "capitalLoss.separateLimit",
    label: "net capital loss deductible per year, married filing separately",
    type: "amount",
    unit: "USD",
    query: "IRS capital loss limit married filing separately {period}",
    prefer: US_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "longTerm.holdingYears",
    label: "holding period a sale must exceed (counted by anniversary) for a long-term gain",
    type: "number",
    unit: "years",
    query: "IRS holding period long-term capital gain more than {period} publication 550",
    prefer: US_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "washSale.windowDays",
    label: "days before and after a loss sale in which buying substantially identical stock makes it a wash sale",
    type: "number",
    unit: "days on each side",
    query: "IRC 1091 wash sale days before after publication 550 {period}",
    prefer: `${US_OFFICIAL} (§1091, Reg. 1.1091-1)`,
    usedBy: "engine",
  },
  {
    key: "washSale.appliesToCrypto",
    label: "whether the wash-sale rule covers crypto-assets (digital assets) for the year",
    type: "boolean",
    unit: "true or false",
    query: "wash sale rule digital assets crypto {period} enacted",
    prefer: `${US_OFFICIAL} / congress.gov (enacted law only)`,
    usedBy: "engine",
  },
  {
    key: "qualifiedDividend.holdingDays",
    label: "days a share must be held (more than) within the window around the ex-dividend date for a qualified dividend",
    type: "number",
    unit: "days",
    query: "qualified dividends holding period days publication 550 {period}",
    prefer: US_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "niit.rate",
    label: "net investment income tax rate",
    type: "rate",
    unit: "fraction of 1",
    query: "IRS net investment income tax rate {period}",
    prefer: US_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "niit.thresholds",
    label: "NIIT modified adjusted gross income thresholds by filing status",
    type: "amounts",
    unit: "USD of MAGI",
    fields: ["single", "joint", "separate", "head"],
    query: "IRS net investment income tax threshold amounts filing status {period}",
    prefer: US_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "ftc.directLimit",
    label: "foreign tax a filer may credit directly on Schedule 3 without Form 1116, single and joint",
    type: "amounts",
    unit: "USD",
    fields: ["single", "joint"],
    query: "foreign tax credit without form 1116 election limit {period}",
    prefer: US_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "backupWithholding.rate",
    label: "backup withholding rate when the W-9 is missing",
    type: "rate",
    unit: "fraction of 1",
    query: "IRS backup withholding rate {period}",
    prefer: US_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "fbar.threshold",
    label: "aggregate maximum value of foreign financial accounts above which FinCEN 114 (FBAR) is due",
    type: "amount",
    unit: "USD",
    query: "FBAR filing threshold aggregate value foreign accounts {period}",
    prefer: `${US_OFFICIAL} / fincen.gov`,
    usedBy: "engine",
  },
  {
    key: "fbar.deadline",
    label: "FBAR due date and automatic extension",
    type: "text",
    unit: "text",
    query: "FBAR due date automatic extension {period}",
    prefer: `${US_OFFICIAL} / fincen.gov`,
    usedBy: "engine",
  },
  {
    key: "fbar.cryptoOnlyAccounts",
    label: "whether a foreign account holding only crypto-assets is reportable on the FBAR for the year",
    type: "boolean",
    unit: "true or false",
    query: "FinCEN FBAR virtual currency account reportable {period} notice",
    prefer: "fincen.gov",
    usedBy: "engine",
  },
  {
    key: "f8938.thresholds",
    label: "Form 8938 thresholds for US residents (year-end value / value at any time), single and joint",
    type: "amounts",
    unit: "USD",
    fields: ["singleEnd", "singleAny", "jointEnd", "jointAny"],
    query: "Form 8938 reporting thresholds taxpayers living in the US {period}",
    prefer: US_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "ira.earlyWithdrawalPenalty",
    label: "additional tax on an early distribution from an IRA or a 401(k)",
    type: "rate",
    unit: "fraction of 1",
    query: "IRS additional tax early distributions IRA {period}",
    prefer: US_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "ira.penaltyFreeAge",
    label: "age from which IRA distributions bear no early-distribution tax",
    type: "number",
    unit: "years of age",
    query: "IRA early withdrawal age penalty free {period}",
    prefer: US_OFFICIAL,
    usedBy: "engine",
  },
  {
    key: "roth.qualifiedYears",
    label: "years since the first Roth IRA contribution before a distribution can be qualified",
    type: "number",
    unit: "years",
    query: "Roth IRA five-year rule qualified distribution {period}",
    prefer: US_OFFICIAL,
    usedBy: "engine",
  },
  {
    ...COST_METHOD,
    query: "IRS cost basis identification of shares FIFO specific identification publication 550 {period}",
    prefer: US_OFFICIAL,
  },
] as const satisfies readonly ParamSpec[];

/** What to research for a country ultrastock has no engine for: the facts report shows it beside the ledger's figures. */
export const GENERIC_SPEC: readonly ParamSpec[] = [
  {
    key: "capitalGains.rates",
    label: "capital gains tax rate(s) for an individual on securities and on crypto-assets",
    type: "any",
    unit: "a fraction of 1, or an object of named rates",
    query: "{country} capital gains tax rate individuals shares {period}",
    prefer: "the national tax administration's site, the tax code",
    usedBy: "report",
  },
  {
    key: "capitalGains.application",
    label: "how those rates apply: flat, added to income at the progressive scale, per asset class, social contributions on top",
    type: "text",
    unit: "text",
    query: "{country} how capital gains are taxed individuals progressive flat {period}",
    prefer: "the national tax administration's site, the tax code",
    usedBy: "report",
  },
  {
    key: "holdingPeriod.rules",
    label: "holding-period rules: an exemption or a reduced rate after a period, short- vs long-term",
    type: "text",
    unit: "text",
    query: "{country} holding period capital gains exemption reduced rate {period}",
    prefer: "the national tax administration's site, the tax code",
    usedBy: "report",
  },
  { ...COST_METHOD, query: "{country} cost basis method shares FIFO average {period}", prefer: "the national tax administration's site, the tax code" },
  {
    key: "crypto.treatment",
    label: "crypto-assets: private disposal or capital gain, whether crypto-to-crypto trades are taxable, staking and rewards",
    type: "text",
    unit: "text",
    query: "{country} cryptocurrency taxation individuals crypto to crypto staking {period}",
    prefer: "the national tax administration's site, its crypto guidance",
    usedBy: "report",
  },
  {
    key: "allowances.annual",
    label: "annual exemptions or allowances on gains, dividends or interest",
    type: "any",
    unit: "an amount in the tax currency, or an object of named amounts",
    query: "{country} annual tax-free allowance capital gains dividends {period}",
    prefer: "the national tax administration's site, the tax code",
    usedBy: "report",
  },
  {
    key: "dividends.taxation",
    label: "how dividends are taxed: rate, allowance, credit for foreign withholding",
    type: "text",
    unit: "text",
    query: "{country} dividend tax individuals foreign withholding credit {period}",
    prefer: "the national tax administration's site, the tax code",
    usedBy: "report",
  },
  {
    key: "interest.taxation",
    label: "how interest is taxed",
    type: "text",
    unit: "text",
    query: "{country} interest income tax individuals {period}",
    prefer: "the national tax administration's site, the tax code",
    usedBy: "report",
  },
  {
    key: "losses.carryForward",
    label: "capital losses: what they offset, whether and how long they carry forward",
    type: "text",
    unit: "text",
    query: "{country} capital losses offset carry forward years {period}",
    prefer: "the national tax administration's site, the tax code",
    usedBy: "report",
  },
  {
    key: "washSale.rule",
    label: "a wash-sale-like rule (a loss disallowed when the same asset is bought back within a period), or none",
    type: "text",
    unit: "text",
    query: "{country} wash sale rule repurchase loss disallowed {period}",
    prefer: "the national tax administration's site, the tax code",
    usedBy: "report",
  },
  {
    key: "reporting.forms",
    label: "the return forms and lines for gains, dividends, interest, foreign accounts and crypto, with their due dates",
    type: "text",
    unit: "text",
    query: "{country} tax return form capital gains foreign accounts declaration {period}",
    prefer: "the national tax administration's site",
    usedBy: "report",
  },
];

/** Form lines the engines write, numbered by the year's form: check their numbering each year. */
export const FORM_LINES: Readonly<Record<EngineCountry, readonly FormLineSpec[]>> = {
  FR: [
    { form: "2042-C", lines: "3VG, 3VH", usedFor: "net securities gain / loss" },
    { form: "2042-C", lines: "2DC, 2TR, 2CK, 2AB, 2OP", usedFor: "dividends, interest, instalment withheld, foreign tax credit, scale option" },
    { form: "2042-C", lines: "3AN, 3BN", usedFor: "net crypto gain / loss" },
    { form: "2042", lines: "2CH (and 2VV / 2WW)", usedFor: "assurance-vie gains after the reduced-rate age" },
    {
      form: "2086",
      lines: "211, 212, 213, 214, 215, 217, 218, 220, 221, 223, 224",
      usedFor: "one column per taxable crypto disposal (`tax export --format 2086`)",
    },
    { form: "2074", lines: "disposal detail", usedFor: "securities disposals (`tax export --format 2074`)" },
    { form: "2047", lines: "foreign-source income", usedFor: "dividends and interest from abroad" },
    { form: "2778-DIV", lines: "monthly instalment", usedFor: "income paid at a foreign broker" },
    { form: "3916 / 3916-bis", lines: "one per account", usedFor: "accounts and crypto accounts held abroad" },
  ],
  US: [
    { form: "8949", lines: "Part I / Part II, columns (a)–(h), code W, boxes A / D", usedFor: "each disposal (`tax export --format 8949`)" },
    { form: "Schedule D", lines: "lines 7, 15, 16, 21", usedFor: "net short-term, net long-term, net gain or loss, loss deducted" },
    { form: "1116 / Schedule 3", lines: "foreign tax credit", usedFor: "foreign tax withheld on dividends" },
    { form: "8960", lines: "NIIT", usedFor: "net investment income tax" },
    { form: "1040", lines: "digital-asset question", usedFor: "any crypto disposal" },
    { form: "FinCEN 114 / 8938 / 8621", lines: "foreign accounts and funds", usedFor: "FBAR, foreign financial assets, PFICs" },
  ],
};

export const ENGINE_COUNTRIES = ["FR", "US"] as const;
export type EngineCountry = (typeof ENGINE_COUNTRIES)[number];
export type FrKey = (typeof FR_SPEC)[number]["key"];
export type UsKey = (typeof US_SPEC)[number]["key"];

/** The tax currency each engine computes in: engine structure (the return is filed in it), not a rule value. */
export const ENGINE_CURRENCY: Readonly<Record<EngineCountry, string>> = { FR: "EUR", US: "USD" };

export const isEngineCountry = (c: string): c is EngineCountry => (ENGINE_COUNTRIES as readonly string[]).includes(c.toUpperCase());

/** The keys to research for a country: an engine's full list, or the generic one. */
export function specFor(country: string): readonly ParamSpec[] {
  const c = country.toUpperCase();
  return c === "FR" ? FR_SPEC : c === "US" ? US_SPEC : GENERIC_SPEC;
}

export { countryCode };
export const templateCommand = (country: string, year: number | string) => `ultrastock tax rules template --country ${countryCode(country)} --year ${year}`;

/** The tax domain of the researched-facts store. */
export const TAX = defineDomain<ParamSpec>({
  name: "tax",
  period: "year",
  keysFor: specFor,
  // An engine reads a fixed list: a key it does not know is a typo, refused. Elsewhere the research is free.
  strict: isEngineCountry,
  meta: {
    currency: {
      check: (v, country) => {
        const c = typeof v === "string" ? v.trim().toUpperCase() : "";
        if (!/^[A-Z]{3}$/.test(c)) return 'the ISO 4217 code amounts are in, such as "EUR"';
        if (isEngineCountry(country) && c !== ENGINE_CURRENCY[country]) return `the ${country} engine computes in ${ENGINE_CURRENCY[country]}, not ${c}`;
        return undefined;
      },
      template: (country) => (isEngineCountry(country) ? ENGINE_CURRENCY[country] : null),
    },
  },
  templateCommand,
  setCommand: "ultrastock tax rules set --file <file.json>",
  about: (c, year) =>
    `TEMPLATE to fill by research. ultrastock contains no tax law: every value must come from an official source for ${c} and the tax year ${year}. For each key fill "value", "sources" (at least one URL), "verifiedAt" and "confidence"; set "researchedAt"${isEngineCountry(c) ? "" : ' and "currency"'}; then run \`ultrastock tax rules set --file <this file>\`. ${isEngineCountry(c) ? `The ${c} engine refuses until every key is researched.` : "No engine computes tax for this country: `tax report` shows the ledger's facts beside these rules, and the agent applies them. Add any other key the research finds."} The user should have a professional confirm the result.`,
  templateExtras: (c, year) => (isEngineCountry(c) ? { formLines: FORM_LINES[c].map((f) => ({ ...f, check: `the numbering on the ${year} form` })) } : {}),
});

const ruleSet = (v: ValidatedFacts): RuleSet => ({
  country: v.file.country,
  year: v.file.period as number,
  currency: v.file.meta.currency ?? "",
  researchedAt: v.file.researchedAt,
  ...(v.file.note ? { note: v.file.note } : {}),
  facts: v.current,
});

export const rulesPath = (country: string, year: number): string => factsPath(TAX, country, year);
export const storedYears = (country: string): number[] => storedPeriods(TAX, country) as number[];

/** The researched rules for a country and a tax year — a usage error naming the file and what to research when there are none. */
export function loadRules(country: string, year: number): { rules: RuleSet; missing: string[]; stale: ValidatedFacts["stale"]; path: string } {
  const v = loadFacts(TAX, country, year);
  return { rules: ruleSet(v), missing: v.missing, stale: v.stale, path: v.path };
}

/** The rules an engine computes with: every key it reads present and current, else a usage error naming the file and the keys. */
export function engineRules(country: EngineCountry, year: number): RuleSet {
  const { rules, missing, stale, path } = loadRules(country, year);
  const engineKeys = new Set<string>(
    specFor(country)
      .filter((s) => s.usedBy === "engine")
      .map((s) => s.key),
  );
  const lacking = missing.filter((k) => engineKeys.has(k));
  if (lacking.length)
    throw new UsageError(
      `${path} lacks ${lacking.length} key(s) the ${country} engine reads: ${lacking.join(", ")}${stale.length ? ` (stale: ${stale.map((s) => `${s.key} ${s.reason}`).join("; ")})` : ""} — research them (\`${templateCommand(country, year)}\` lists each with a search query) and store the file again with \`${TAX.setCommand}\``,
    );
  return rules;
}

/** A rules file checked strictly (see core/researched.ts validateFacts), pinned to a country and a year when given. */
export function validateRules(raw: unknown, expect: { country?: string; year?: number } = {}) {
  const v = validateFacts(TAX, raw, { country: expect.country, period: expect.year });
  return { rules: ruleSet(v), missing: v.missing, stale: v.stale };
}

/** Validate and store a rules file; returns where it went and which registered keys it still lacks. */
export function saveRules(raw: unknown, expect: { country?: string; year?: number } = {}) {
  const v = saveFacts(TAX, raw, { country: expect.country, period: expect.year });
  return { rules: ruleSet(v), missing: v.missing, stale: v.stale, path: v.path };
}

export const param = <T = number>(r: RuleSet, key: string): T =>
  factValue<T>(TAX, { domain: "tax", country: r.country, period: r.year, researchedAt: r.researchedAt, meta: {}, facts: r.facts }, key);

/** The JSON skeleton to research and fill for a country and a tax year. */
export const rulesTemplate = (country: string, year: number) => factsTemplate(TAX, country, year);

/** What to (re-)research for a country and a year, with the stored file's status on each key and the form lines to check. */
export function researchChecklist(
  country: string,
  year: number,
): { path: string; stored: boolean; items: ChecklistItem[]; formLines: readonly FormLineSpec[] } {
  const c = countryCode(country);
  return { ...factsChecklist(TAX, c, year), formLines: isEngineCountry(c) ? FORM_LINES[c] : [] };
}
