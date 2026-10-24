// Files for the return and for the tools people already use: Form 8949 rows,
// the 2086 columns (one per taxable crypto disposal), the 2074 disposals
// detail, and Koinly's universal CSV (to cross-check crypto with Koinly).
import { toCsv } from "../core/csv.js";
import type { Transaction } from "../portfolio/ledger.js";
import { day, splitPair, type TaxEvent } from "./regime.js";

export const EXPORT_FORMATS = ["8949", "2086", "2074", "koinly"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function export8949(events: readonly TaxEvent[]): string {
  const rows = events
    .filter((e) => (e.kind === "securities-disposal" || e.kind === "crypto-disposal") && e.lines)
    .sort((a, b) => (a.term ?? "").localeCompare(b.term ?? "") || a.date.localeCompare(b.date))
    .map((e) => [e.term === "long" ? "II" : "I", e.lines!.a, e.lines!.b, e.lines!.c, e.lines!.d, e.lines!.e, e.lines!.f, e.lines!.g, e.lines!.h, e.account]);
  return toCsv([
    [
      "part",
      "(a) description",
      "(b) date acquired",
      "(c) date sold",
      "(d) proceeds",
      "(e) cost basis",
      "(f) code",
      "(g) adjustment",
      "(h) gain or loss",
      "account",
    ],
    ...rows,
  ]);
}

export function export2086(events: readonly TaxEvent[]): string {
  const cols = ["211", "212", "213", "214", "215", "217", "218", "220", "221", "223", "224"];
  const labels: Record<string, string> = {
    "211": "date de la cession",
    "212": "valeur globale du portefeuille",
    "213": "prix de cession",
    "214": "frais de cession",
    "215": "prix de cession net des frais",
    "217": "prix de cession net des soultes",
    "218": "prix de cession net des frais et soultes",
    "220": "prix total d'acquisition",
    "221": "fractions de capital initial",
    "223": "prix total d'acquisition net",
    "224": "plus-value ou moins-value",
  };
  const rows = events.filter((e) => e.kind === "crypto-disposal" && e.lines).map((e) => [e.account, e.symbol ?? "", ...cols.map((c) => e.lines![c] ?? "")]);
  return toCsv([["compte", "actif", ...cols.map((c) => `${c} ${labels[c]}`)], ...rows]);
}

export function export2074(events: readonly TaxEvent[]): string {
  const rows = events
    .filter((e) => e.kind === "securities-disposal")
    .map((e) => [e.date, e.account, e.symbol ?? "", e.quantity ?? "", e.proceeds ?? "", e.fees ?? "", e.cost ?? "", e.gain ?? "", e.formula ?? ""]);
  return toCsv([
    ["date", "compte", "titre", "quantité", "prix de cession net (€)", "frais (€)", "prix de revient PMP (€)", "plus ou moins-value (€)", "calcul"],
    ...rows,
  ]);
}

/** Koinly's universal format, one row per crypto transaction. */
export function exportKoinly(txs: readonly Transaction[], isCrypto: (t: Transaction) => boolean): string {
  const rows = txs.filter(isCrypto).map((t) => {
    const { base } = splitPair(t.symbol ?? t.currency, t.currency);
    const q = t.quantity ?? 0;
    const cash = q * (t.price ?? 0);
    const fee = t.fee ? [t.fee, t.currency] : ["", ""];
    const date = `${day(t.date)} 00:00 UTC`;
    switch (t.type) {
      case "buy":
        return [date, cash, t.currency, q, base, ...fee, "", "", "", t.note ?? "", t.id];
      case "sell":
        return [date, q, base, cash, t.currency, ...fee, "", "", "", t.note ?? "", t.id];
      case "transfer-in":
        return [date, "", "", q, base, ...fee, "", "", "", t.note ?? "", t.id];
      case "transfer-out":
        return [date, q, base, "", "", ...fee, "", "", "", t.note ?? "", t.id];
      case "interest":
      case "dividend":
        return [date, "", "", t.amount ?? q, t.symbol ? base : t.currency, "", "", "", "", "reward", t.note ?? "", t.id];
      case "deposit":
        return [date, "", "", t.amount ?? 0, t.currency, "", "", "", "", "", t.note ?? "", t.id];
      case "withdrawal":
        return [date, Math.abs(t.amount ?? 0), t.currency, "", "", "", "", "", "", "", t.note ?? "", t.id];
      default:
        return [date, "", "", "", "", ...fee, "", "", "", t.note ?? t.type, t.id];
    }
  });
  return toCsv([
    [
      "Date",
      "Sent Amount",
      "Sent Currency",
      "Received Amount",
      "Received Currency",
      "Fee Amount",
      "Fee Currency",
      "Net Worth Amount",
      "Net Worth Currency",
      "Label",
      "Description",
      "TxHash",
    ],
    ...rows,
  ]);
}
