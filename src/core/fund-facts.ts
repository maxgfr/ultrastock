// What a fund's domicile means for the tax it suffers and passes on —
// researched, never built in.
//
// A fund domiciled in Ireland, Luxembourg, France or the United States does not
// suffer the same withholding tax on the dividends it receives, nor withhold
// the same on what it distributes to a non-resident: that is each domicile's
// law and treaties, and it changes. ultrastock holds none of it. The agent
// researches it on official sources (`facts research funds --country IE`),
// concludes in a sentence, and stores it in the researched-facts store as the
// "funds" domain, keyed by the DOMICILE: <home>/facts/funds/<CC>-<date>.json.
import { countryName } from "./jurisdiction.js";
import { clockNow } from "./net.js";
import { countryCode, defineDomain, type FactSpec, factsSetCommand, factsTemplateCommand, loadLatestFacts, researchCommand } from "./researched.js";

export function fundKeys(domicile: string): FactSpec[] {
  const n = countryName(domicile);
  const y = clockNow().getUTCFullYear();
  return [
    {
      key: "withholding",
      label: `Withholding tax a fund domiciled in ${n} suffers on foreign (US in particular) dividends, and what ${n} withholds on its distributions to non-resident investors`,
      type: "text",
      unit: "a sentence, no investor-level advice",
      query: `${n} domiciled UCITS fund withholding tax US dividends treaty distributions non-resident investors ${y}`,
      prefer: "the domicile's tax authority, the tax treaty text, or the fund's own prospectus",
      maxAgeDays: 365,
      note: "Shown next to a fund's domicile in `analyze` / `etf`: say what the sources state, with no rate you did not read in them.",
    },
  ];
}

/** The "funds" domain: facts about a fund DOMICILE, one file per domicile and research date. */
export const FUNDS = defineDomain<FactSpec>({
  name: "funds",
  period: "date",
  keysFor: fundKeys,
  strict: () => true,
  templateCommand: (country) => factsTemplateCommand("funds", countryCode(country)),
  setCommand: factsSetCommand("funds"),
  about: (c, date) =>
    `TEMPLATE to fill by research. "country" is a fund DOMICILE (${c}), not the investor's country. ultrastock holds no tax rule: fill each value with what official sources for ${c} state on ${date}, its "sources", "verifiedAt" and "confidence"; set "researchedAt"; then \`${factsSetCommand("funds").replace("<file.json>", "<this file>")}\`.`,
});

/** What the domicile means for withholding tax: the researched sentence, or what to research. Never a rule of ultrastock's own. */
export function withholdingNote(code: string | undefined): string {
  if (!code) return "domicile unknown: the withholding tax a fund suffers (and passes on) depends on its domicile — read it in the KID or prospectus.";
  const c = code.toUpperCase();
  const n = countryName(c);
  if (/^[A-Z]{2}$/.test(c))
    try {
      const f = loadLatestFacts(FUNDS, c).current.withholding;
      if (f && typeof f.value === "string") return `${n} (${c}), as researched on ${f.verifiedAt}: ${f.value}${f.sources[0] ? ` (${f.sources[0]})` : ""}`;
    } catch {
      // An unreadable file reads as not researched: the note says what to do.
    }
  return `domicile ${c}: the withholding tax a ${n}-domiciled fund suffers on foreign dividends, and passes on, is not researched here — \`${researchCommand("funds", c)}\`, or read the prospectus.`;
}
