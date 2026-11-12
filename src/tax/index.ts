// The engine for a tax residence: France and the United States have one, each
// reading every parameter from the rules the agent researched. A new engine is
// a TaxRegime subclass plus its keys in tax/rules.ts.
import { UsageError } from "../engine.js";
import { FranceRegime } from "./fr.js";
import type { TaxRegime } from "./regime.js";
import { ENGINE_COUNTRIES, isEngineCountry } from "./rules.js";
import { UsRegime } from "./us.js";

export const REGIMES = ["fr", "us"] as const;
export type RegimeId = (typeof REGIMES)[number];
export { isEngineCountry };

/** The engine of a country (FR, US); refuses without researched rules for the exact year. */
export function regimeFor(country: string, year: number): TaxRegime {
  const c = country.toUpperCase();
  if (c === "FR") return new FranceRegime(year);
  if (c === "US") return new UsRegime(year);
  throw new UsageError(
    `no tax engine for "${country}" — ultrastock has engines for ${ENGINE_COUNTRIES.join(", ")}; for another country the research can still be stored and shown (\`tax rules template|set|show\`)`,
  );
}
