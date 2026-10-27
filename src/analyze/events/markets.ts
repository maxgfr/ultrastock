// Which market an event moves, and which of the user's holdings sit in it.
//
// A country's market is read through its benchmark index (Yahoo symbol), its
// currency (against the user's base currency, Yahoo `EURBRL=X`), and — when one
// exists — a US-listed country ETF whose option chain prices the move the
// market expects (EWZ for Brazil). A holding is attributed to a country by its
// ISIN prefix (where the issuer is incorporated), else its listing's suffix,
// else, for a single-country fund, the country its name or index names. A
// world or regional fund is reported as multi-country, never guessed: its
// exposure needs the look-through (`portfolio lookthrough`).

export interface CountryMarket {
  iso: string;
  name: string;
  /** Benchmark index on Yahoo. */
  index: string;
  indexName: string;
  currency: string;
  /** A US-listed country ETF with listed options. */
  usEtf?: string;
}

const M = (iso: string, name: string, index: string, indexName: string, currency: string, usEtf?: string): CountryMarket => ({
  iso,
  name,
  index,
  indexName,
  currency,
  ...(usEtf ? { usEtf } : {}),
});

export const COUNTRY_MARKETS: Record<string, CountryMarket> = Object.fromEntries(
  [
    M("US", "United States", "^GSPC", "S&P 500", "USD", "SPY"),
    M("CA", "Canada", "^GSPTSE", "S&P/TSX Composite", "CAD", "EWC"),
    M("MX", "Mexico", "^MXX", "IPC", "MXN", "EWW"),
    M("BR", "Brazil", "^BVSP", "Ibovespa", "BRL", "EWZ"),
    M("AR", "Argentina", "^MERV", "Merval", "ARS", "ARGT"),
    M("CL", "Chile", "^IPSA", "S&P IPSA", "CLP", "ECH"),
    M("CO", "Colombia", "^COLCAP", "COLCAP", "COP", "GXG"),
    M("PE", "Peru", "^SPBLPGPT", "S&P/BVL Peru General", "PEN", "EPU"),
    M("GB", "United Kingdom", "^FTSE", "FTSE 100", "GBP", "EWU"),
    M("FR", "France", "^FCHI", "CAC 40", "EUR", "EWQ"),
    M("DE", "Germany", "^GDAXI", "DAX", "EUR", "EWG"),
    M("IT", "Italy", "FTSEMIB.MI", "FTSE MIB", "EUR", "EWI"),
    M("ES", "Spain", "^IBEX", "IBEX 35", "EUR", "EWP"),
    M("NL", "Netherlands", "^AEX", "AEX", "EUR", "EWN"),
    M("BE", "Belgium", "^BFX", "BEL 20", "EUR"),
    M("PT", "Portugal", "PSI20.LS", "PSI", "EUR"),
    M("IE", "Ireland", "^ISEQ", "ISEQ", "EUR"),
    M("AT", "Austria", "^ATX", "ATX", "EUR"),
    M("FI", "Finland", "^OMXH25", "OMX Helsinki 25", "EUR"),
    M("GR", "Greece", "GD.AT", "Athens General", "EUR", "GREK"),
    M("CH", "Switzerland", "^SSMI", "SMI", "CHF", "EWL"),
    M("SE", "Sweden", "^OMX", "OMX Stockholm 30", "SEK", "EWD"),
    M("NO", "Norway", "OBX.OL", "OBX", "NOK", "NORW"),
    M("DK", "Denmark", "^OMXC25", "OMX Copenhagen 25", "DKK"),
    M("PL", "Poland", "WIG20.WA", "WIG20", "PLN", "EPOL"),
    M("CZ", "Czech Republic", "^PX", "PX", "CZK"),
    M("HU", "Hungary", "^BUX", "BUX", "HUF"),
    M("TR", "Turkey", "XU100.IS", "BIST 100", "TRY", "TUR"),
    M("IL", "Israel", "TA35.TA", "TA-35", "ILS", "EIS"),
    M("ZA", "South Africa", "^J203.JO", "FTSE/JSE All Share", "ZAR", "EZA"),
    M("SA", "Saudi Arabia", "^TASI.SR", "Tadawul All Share", "SAR", "KSA"),
    M("IN", "India", "^NSEI", "Nifty 50", "INR", "INDA"),
    M("CN", "China", "000001.SS", "SSE Composite", "CNY", "FXI"),
    M("HK", "Hong Kong", "^HSI", "Hang Seng", "HKD", "EWH"),
    M("JP", "Japan", "^N225", "Nikkei 225", "JPY", "EWJ"),
    M("KR", "South Korea", "^KS11", "KOSPI", "KRW", "EWY"),
    M("TW", "Taiwan", "^TWII", "TAIEX", "TWD", "EWT"),
    M("SG", "Singapore", "^STI", "Straits Times", "SGD", "EWS"),
    M("ID", "Indonesia", "^JKSE", "Jakarta Composite", "IDR", "EIDO"),
    M("MY", "Malaysia", "^KLSE", "FTSE Bursa Malaysia KLCI", "MYR", "EWM"),
    M("TH", "Thailand", "^SET.BK", "SET", "THB", "THD"),
    M("PH", "Philippines", "PSEI.PS", "PSEi", "PHP", "EPHE"),
    M("AU", "Australia", "^AXJO", "S&P/ASX 200", "AUD", "EWA"),
    M("NZ", "New Zealand", "^NZ50", "NZX 50", "NZD", "ENZL"),
  ].map((m) => [m.iso, m]),
);

/** The euro area, for an ECB decision. */
export const EURO_AREA = ["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"];

// Listing suffix → country (Yahoo-style symbols the ledger holds).
const SUFFIX_COUNTRY: Record<string, string> = {
  PA: "FR",
  AS: "NL",
  BR: "BE",
  LS: "PT",
  IR: "IE",
  MI: "IT",
  MC: "ES",
  DE: "DE",
  F: "DE",
  L: "GB",
  SW: "CH",
  ST: "SE",
  HE: "FI",
  CO: "DK",
  OL: "NO",
  VI: "AT",
  WA: "PL",
  AT: "GR",
  IS: "TR",
  SA: "BR",
  MX: "MX",
  TO: "CA",
  V: "CA",
  BA: "AR",
  SN: "CL",
  LM: "PE",
  T: "JP",
  HK: "HK",
  KS: "KR",
  KQ: "KR",
  SS: "CN",
  SZ: "CN",
  TW: "TW",
  TWO: "TW",
  SI: "SG",
  KL: "MY",
  JK: "ID",
  BK: "TH",
  NS: "IN",
  BO: "IN",
  AX: "AU",
  NZ: "NZ",
  JO: "ZA",
  TA: "IL",
  SR: "SA",
};

// Fund names that name one country — "iShares MSCI Brazil", "Amundi MSCI Brazil", "Lyxor MSCI India".
const FUND_COUNTRY: Array<[RegExp, string]> = Object.values(COUNTRY_MARKETS)
  .filter((m) => m.iso !== "US")
  .map((m) => [new RegExp(`\\b${m.name.replace(/ /g, "\\s+")}\\b`, "i"), m.iso] as [RegExp, string])
  .concat([
    [/\bS&P\s*500|\bNasdaq|\bDow Jones|\bRussell\s*\d/i, "US"],
    [/\bIbovespa\b/i, "BR"],
    [/\bCAC\s*40\b/i, "FR"],
    [/\bDAX\b/i, "DE"],
    [/\bNikkei|TOPIX/i, "JP"],
    [/\bFTSE\s*100\b/i, "GB"],
  ]);

const MULTI_FUND = /\bworld|global|all[\s-]?world|acwi|emerging|europe|euro\s?stoxx|stoxx|asia|pacific|latin|developed|international|ex[\s-]/i;

export interface CountryAttribution {
  iso?: string;
  /** How it was decided: "isin", "listing", "fund name", or why it could not be. */
  how: string;
  multi?: boolean;
}

/** The country a holding's value moves with. */
export function holdingCountry(h: { symbol: string; isin?: string; assetClass?: string; name?: string; market?: string }): CountryAttribution {
  if (h.assetClass === "crypto" || h.market === "crypto") return { how: "a crypto-asset: no country" };
  const fund = h.assetClass === "etf" || h.assetClass === "fund";
  if (fund) {
    const n = h.name ?? "";
    const one = FUND_COUNTRY.find(([re]) => re.test(n));
    if (one && !MULTI_FUND.test(n)) return { iso: one[1], how: "fund name" };
    return { how: "a multi-country fund — `portfolio lookthrough` breaks it down", multi: true };
  }
  const isin = h.isin?.toUpperCase();
  if (isin && /^[A-Z]{2}/.test(isin) && !/^(XS|EU|QS)/.test(isin)) return { iso: isin.slice(0, 2), how: "isin" };
  const suffix = /\.([A-Z]{1,3})$/.exec(h.symbol.toUpperCase())?.[1];
  if (suffix && SUFFIX_COUNTRY[suffix]) return { iso: SUFFIX_COUNTRY[suffix], how: "listing" };
  if (!suffix) return { iso: "US", how: "listing" };
  return { how: `no country known for the .${suffix} listing` };
}
