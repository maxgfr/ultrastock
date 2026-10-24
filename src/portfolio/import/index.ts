// Broker statements → ledger transactions: one pure parser per format (text
// in, transactions + skipped rows + warnings out), chosen by name. Nothing
// here touches the disk; `portfolio import` reads the file, appends through
// the ledger (which dedupes by content id) and checks the book still replays.
import { parseBinance } from "./binance.js";
import { parseCoinbase } from "./coinbase.js";
import { type ColumnMap, checkColumnMap, GENERIC_PRESETS, parseGeneric } from "./generic.js";
import { parseIbkr } from "./ibkr.js";
import { parseKraken } from "./kraken.js";
import type { ImportOptions, ImportResult } from "./shared.js";

export const IMPORT_FORMATS = ["ibkr-flex", "binance", "kraken", "coinbase", "generic"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export interface StatementOptions extends ImportOptions {
  /** generic only: the column map (required). */
  map?: ColumnMap;
  /** generic only: the named map `map` came from, when it did. */
  presetName?: string;
}

/** Parse a statement of `format`. Throws only for whole-file problems (a generic map that does not fit the header). */
export function parseStatement(format: ImportFormat, text: string, opts: StatementOptions): ImportResult {
  switch (format) {
    case "ibkr-flex":
      return parseIbkr(text, opts);
    case "binance":
      return parseBinance(text, opts);
    case "kraken":
      return parseKraken(text, opts);
    case "coinbase":
      return parseCoinbase(text, opts);
    case "generic":
      if (!opts.map) throw new Error(`the generic format needs a column map (--map '{…}' or one of ${Object.keys(GENERIC_PRESETS).join(", ")})`);
      return parseGeneric(text, { ...opts, map: opts.map });
  }
}

/**
 * The --map value for `format`: a JSON object, or (generic) a named map.
 * Crypto formats take only {"quote": "EUR"}; ibkr-flex takes none.
 * Throws an Error with the reason when it does not fit.
 */
export function resolveMapOption(format: ImportFormat, raw: string | undefined): { map?: ColumnMap; presetName?: string; quote?: string } {
  if (raw === undefined) return {};
  const trimmed = raw.trim();
  if (format === "generic" && GENERIC_PRESETS[trimmed]) return { map: GENERIC_PRESETS[trimmed]!.map, presetName: trimmed };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      format === "generic"
        ? `--map is a JSON column map or one of ${Object.keys(GENERIC_PRESETS).join(", ")}, not "${trimmed.slice(0, 40)}"`
        : `--map is JSON, e.g. '{"quote":"EUR"}'`,
    );
  }
  if (format === "generic") return { map: checkColumnMap(parsed) };
  if (format === "ibkr-flex") throw new Error("--map does not apply to ibkr-flex (symbols come from the listing exchange)");
  const o = parsed as Record<string, unknown>;
  const keys = o && typeof o === "object" ? Object.keys(o) : [];
  if (keys.some((k) => k !== "quote") || typeof o.quote !== "string" || !/^[A-Za-z]{3,5}$/.test(o.quote))
    throw new Error(`for ${format}, --map takes only {"quote":"<currency>"} — the quote of the pair coin deposits and rewards are booked against`);
  return { quote: o.quote.toUpperCase() };
}

export { amountWithUnit } from "./binance.js";
export { type ColumnMap, GENERIC_PRESETS, typeFromWord } from "./generic.js";
export { ibkrSymbol, xmlElementAttrs } from "./ibkr.js";
export { krakenAsset, krakenPair } from "./kraken.js";
export type { ImportOptions, ImportResult, ImportTx } from "./shared.js";
