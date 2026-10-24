// Tax parameters, by regime and year. Every value carries the sources it was
// read from and the date it was verified: tax law changes every year (the 2026
// social security financing law raised the CSG on capital income mid-flight),
// so `tax verify` lists each parameter with a search query and its sources for
// the agent to re-check, and flags a year whose rules are missing or stale.
//
// Values verified 2026-10-24 by web search (secondary sources cross-checked;
// the official texts — BOFiP, Légifrance, IRS Rev. Proc. 2025-32 — are linked
// for the final word). A parameter marked `confidence: "medium"` rests on
// consistent secondary sources only.

export interface Param<T = number> {
  value: T;
  label: string;
  sources: string[];
  verifiedAt: string;
  confidence: "high" | "medium" | "low";
  note?: string;
}

export interface RuleSet {
  regime: "fr" | "us";
  year: number;
  params: Record<string, Param<number | string | Record<string, number>>>;
}

const V = "2026-10-24";
const LFSS2026 = [
  "https://www.legifrance.gouv.fr/ (LFSS 2026, loi n° 2025-1403, art. 12)",
  "https://www.actu-juridique.fr/fiscalite/fiscal-finances/la-csg-en-hausse-sur-les-revenus-du-capital/",
  "https://www.dlapiper.com/fr-fr/insights/publications/2026/01/loi-de-finance-de-la-securite-sociale-2026",
];
const PEA2026 = [
  "https://placement.meilleurtaux.com/bourse/actualites/2026-fevrier/pea-les-cotisations-sociales-passent-a-18-6-en-2026.html",
  "https://www.auguste-patrimoine.fr/blog/pea-et-hausse-de-la-csg-en-2026-impact-calcul-et-strategies-de-retrait",
  "https://www.lafinancepourtous.com/pratique/placements/pea/la-fiscalite-applicable-au-pea/",
];
const CRYPTO = [
  "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000041470773 (CGI art. 150 VH bis)",
  "https://selectra.info/finance/actualites/marche/cryptomonnaies-vente-305-euros-exoneration-impot",
];

const fr = (year: number, ps: number, psAv: number): RuleSet => ({
  regime: "fr",
  year,
  params: {
    "pfu.ir": {
      value: 0.128,
      label: "PFU — income-tax part",
      sources: ["https://www.service-public.fr/particuliers/vosdroits/F34913"],
      verifiedAt: V,
      confidence: "high",
    },
    "ps.capital": {
      value: ps,
      label: "prélèvements sociaux on capital gains and dividends (CTO, PEA withdrawals, crypto)",
      sources: year >= 2026 ? [...LFSS2026, ...PEA2026] : ["https://www.service-public.fr/particuliers/vosdroits/F2329"],
      verifiedAt: V,
      confidence: year >= 2026 ? "medium" : "high",
      note: year >= 2026 ? "CSG 10.6 % since 1 January 2026 on investment income (LFSS 2026)" : undefined,
    },
    "ps.assuranceVie": {
      value: psAv,
      label: "prélèvements sociaux on assurance-vie gains",
      sources: year >= 2026 ? PEA2026 : ["https://www.service-public.fr/particuliers/vosdroits/F15274"],
      verifiedAt: V,
      confidence: "medium",
    },
    "csg.deductible": { value: 0.068, label: "deductible CSG under the progressive-scale option", sources: LFSS2026, verifiedAt: V, confidence: "medium" },
    "dividend.abattement": {
      value: 0.4,
      label: "dividend allowance under the progressive-scale option (2OP)",
      sources: ["https://www.service-public.fr/particuliers/vosdroits/F34913"],
      verifiedAt: V,
      confidence: "high",
    },
    "losses.carryforwardYears": {
      value: 10,
      label: "years a net capital loss on securities can be carried forward",
      sources: ["https://bofip.impots.gouv.fr/ (BOI-RPPM-PVBMI-20-40-10)"],
      verifiedAt: V,
      confidence: "high",
    },
    "pea.ceiling": {
      value: 150_000,
      label: "PEA deposit ceiling",
      sources: ["https://www.service-public.fr/particuliers/vosdroits/F2385"],
      verifiedAt: V,
      confidence: "high",
    },
    "peaPme.ceilingCombined": {
      value: 225_000,
      label: "PEA + PEA-PME combined deposit ceiling",
      sources: ["https://www.service-public.fr/particuliers/vosdroits/F2385"],
      verifiedAt: V,
      confidence: "high",
    },
    "pea.minYears": {
      value: 5,
      label: "PEA age after which withdrawals are free of income tax",
      sources: ["https://www.service-public.fr/particuliers/vosdroits/F2385"],
      verifiedAt: V,
      confidence: "high",
    },
    "crypto.exemptionThreshold": {
      value: 305,
      label: "annual crypto disposals (gross proceeds) at or below which gains are exempt",
      sources: CRYPTO,
      verifiedAt: V,
      confidence: "high",
      note: 'CGI art. 150 VH bis II B: exempt when the year\'s total disposal prices do not exceed 305 € (the 2086 notice, line 51, says "inférieur à 305 €") — the total uses prices net of fees (line 218)',
    },
    "av.rate8y": {
      value: 0.075,
      label: "assurance-vie income tax after 8 years, premiums up to the threshold",
      sources: ["https://www.service-public.fr/particuliers/vosdroits/F22414", "https://www.ramify.fr/assurance-vie/fiscalite"],
      verifiedAt: V,
      confidence: "high",
    },
    "av.premiumThreshold": {
      value: 150_000,
      label: "assurance-vie premiums (all contracts, net of withdrawals) above which the 12.8 % rate applies after 8 years",
      sources: ["https://www.service-public.fr/particuliers/vosdroits/F22414"],
      verifiedAt: V,
      confidence: "high",
    },
    "av.minYears": {
      value: 8,
      label: "assurance-vie contract age for the reduced rate and the allowance",
      sources: ["https://www.service-public.fr/particuliers/vosdroits/F22414"],
      verifiedAt: V,
      confidence: "high",
    },
    "us.dividendWithholdingTreaty": {
      value: 0.15,
      label: "US dividend withholding with a W-8BEN (France–US treaty), creditable in France",
      sources: ["https://www.irs.gov/individuals/international-taxpayers/tax-treaties"],
      verifiedAt: V,
      confidence: "high",
    },
    "av.abattement.single": {
      value: 4600,
      label: "assurance-vie allowance after 8 years, single",
      sources: ["https://www.service-public.fr/particuliers/vosdroits/F22414"],
      verifiedAt: V,
      confidence: "high",
    },
    "av.abattement.couple": {
      value: 9200,
      label: "assurance-vie allowance after 8 years, couple",
      sources: ["https://www.service-public.fr/particuliers/vosdroits/F22414"],
      verifiedAt: V,
      confidence: "high",
    },
  },
});

const us = (year: number): RuleSet => ({
  regime: "us",
  year,
  params: {
    "ltcg.thresholds": {
      // Taxable income at which the 15 % and 20 % long-term rates start, by filing status (Rev. Proc. 2025-32 for 2026).
      value:
        year >= 2026
          ? { single0: 49_450, single15: 545_500, joint0: 98_900, joint15: 613_700, separate15: 306_850, head15: 579_600 }
          : { single0: 48_350, single15: 533_400, joint0: 96_700, joint15: 600_050 },
      label: "long-term capital gains rate breakpoints (0 % / 15 % / 20 %)",
      sources: [
        "https://www.irs.gov/ (Rev. Proc. 2025-32 §3)",
        "https://www.kiplinger.com/taxes/irs-updates-capital-gains-tax-thresholds",
        "https://bradfordtaxinstitute.com/Free_Resources/2026-Capital-Gains-Rates.aspx",
      ],
      verifiedAt: V,
      confidence: year >= 2026 ? "medium" : "high",
    },
    "capitalLoss.separateLimit": {
      value: 1500,
      label: "net capital loss deductible per year, married filing separately",
      sources: ["https://www.irs.gov/taxtopics/tc409"],
      verifiedAt: V,
      confidence: "high",
    },
    "fbar.threshold": {
      value: 10_000,
      label: "aggregate maximum value of foreign financial accounts above which FinCEN 114 (FBAR) is due",
      sources: ["https://www.irs.gov/businesses/small-businesses-self-employed/report-of-foreign-bank-and-financial-accounts-fbar"],
      verifiedAt: V,
      confidence: "high",
    },
    "f8938.thresholds": {
      value: { singleEnd: 50_000, singleAny: 75_000, jointEnd: 100_000, jointAny: 150_000 },
      label: "Form 8938 thresholds for US residents (year-end / any time in the year)",
      sources: ["https://www.irs.gov/businesses/corporations/basic-questions-and-answers-on-form-8938"],
      verifiedAt: V,
      confidence: "high",
    },
    "qualifiedDividend.holdingDays": {
      value: 60,
      label: "days a share must be held (more than) within the 121-day window around the ex-date for a qualified dividend",
      sources: ["https://www.irs.gov/publications/p550"],
      verifiedAt: V,
      confidence: "high",
    },
    "niit.rate": {
      value: 0.038,
      label: "net investment income tax",
      sources: ["https://www.irs.gov/individuals/net-investment-income-tax"],
      verifiedAt: V,
      confidence: "high",
    },
    "niit.thresholds": {
      value: { single: 200_000, joint: 250_000, separate: 125_000 },
      label: "NIIT MAGI thresholds (not indexed)",
      sources: ["https://www.irs.gov/individuals/net-investment-income-tax"],
      verifiedAt: V,
      confidence: "high",
    },
    "capitalLoss.ordinaryLimit": {
      value: 3000,
      label: "net capital loss deductible against ordinary income per year ($1,500 married filing separately)",
      sources: ["https://www.irs.gov/taxtopics/tc409"],
      verifiedAt: V,
      confidence: "high",
    },
    "longTerm.holdingDays": {
      value: 365,
      label: "holding period beyond which a gain is long-term (more than one year)",
      sources: ["https://www.irs.gov/taxtopics/tc409"],
      verifiedAt: V,
      confidence: "high",
    },
    "washSale.windowDays": {
      value: 30,
      label: "wash-sale window before and after a loss sale (stocks and securities)",
      sources: ["https://www.irs.gov/publications/p550"],
      verifiedAt: V,
      confidence: "high",
    },
    "washSale.crypto": {
      value: "not applied",
      label: "wash-sale rule for crypto-assets",
      sources: ["https://www.irs.gov/publications/p550", "https://www.irs.gov/filing/digital-assets"],
      verifiedAt: V,
      confidence: "medium",
      note: "§1091 covers stocks and securities; extending it to digital assets has been proposed, not enacted as of the verification date — verify each year",
    },
  },
});

const RULES: RuleSet[] = [fr(2025, 0.172, 0.172), fr(2026, 0.186, 0.172), us(2025), us(2026)];

/** The rules for a regime and a tax year; the latest earlier year (with a staleness warning) when the year is not described. */
export function rulesFor(regime: "fr" | "us", year: number): { rules: RuleSet; stale?: string } {
  const exact = RULES.find((r) => r.regime === regime && r.year === year);
  if (exact) return { rules: exact };
  const earlier = RULES.filter((r) => r.regime === regime && r.year < year).sort((a, b) => b.year - a.year)[0];
  if (!earlier) throw new Error(`no ${regime.toUpperCase()} tax rules for ${year} or before`);
  return {
    rules: earlier,
    stale: `no ${regime.toUpperCase()} rules recorded for ${year}: the ${earlier.year} parameters are used — run \`ultrastock tax verify --regime ${regime} --year ${year}\` and confirm each one`,
  };
}

export function param<T = number>(r: RuleSet, key: string): T {
  const p = r.params[key];
  if (!p) throw new Error(`tax parameter ${key} is not defined for ${r.regime} ${r.year}`);
  return p.value as T;
}

/** What to re-check for a year: each parameter, its value, its sources, a search query. */
export function verifyChecklist(
  regime: "fr" | "us",
  year: number,
): Array<{ key: string; label: string; value: unknown; verifiedAt: string; confidence: string; query: string; sources: string[]; note?: string }> {
  const { rules, stale } = rulesFor(regime, year);
  const items = Object.entries(rules.params).map(([key, p]) => ({
    key,
    label: p.label,
    value: p.value,
    verifiedAt: p.verifiedAt,
    confidence: p.confidence,
    query: regime === "fr" ? `${p.label} ${year} impots.gouv BOFiP` : `${p.label} ${year} IRS`,
    sources: p.sources,
    note: p.note,
  }));
  return stale
    ? [
        {
          key: "_year",
          label: stale,
          value: rules.year,
          verifiedAt: "",
          confidence: "low",
          query: `${regime === "fr" ? "loi de finances" : "IRS Rev. Proc. inflation adjustments"} ${year}`,
          sources: [],
        },
        ...items,
      ]
    : items;
}
