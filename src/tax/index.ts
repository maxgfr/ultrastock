// The regime for a tax residence: France and the United States today; another
// country is a new TaxRegime subclass plus its parameters in rules.ts.
import { FranceRegime } from "./fr.js";
import type { TaxRegime } from "./regime.js";
import { UsRegime } from "./us.js";

export const REGIMES = ["fr", "us"] as const;
export type RegimeId = (typeof REGIMES)[number];

export function regimeFor(id: string, year: number): TaxRegime {
  const r = id.toLowerCase();
  if (r === "fr") return new FranceRegime(year);
  if (r === "us") return new UsRegime(year);
  throw new Error(`no tax regime for "${id}" — ultrastock knows ${REGIMES.join(", ")}; another residence needs its own rules (see tax/regime.ts)`);
}
