// Just enough XML for the regulators' flat, machine-made documents (SEC Form 4
// and 13F information tables, the House disclosure index): elements are found
// by local name, so `<ns1:infoTable>` and `<infoTable>` read the same. Not a
// general parser — no DTDs, no mixed content — and it does not need to be: the
// bundle has no dependencies, and these schemas are fixed.
import { decodeEntities } from "../../engine.js";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The inner XML of every `<tag>` element (any namespace prefix), in document order. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${esc(tag)}(?:\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${esc(tag)}\\s*>)`, "g");
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(m[1] ?? "");
  return out;
}

/**
 * The text of the first `<tag>` (a path of tags descends: `["transactionShares", "value"]`),
 * entities decoded and trimmed; undefined when absent or empty.
 */
export function xmlValue(xml: string, ...path: string[]): string | undefined {
  let cur: string | undefined = xml;
  for (const tag of path) {
    cur = xmlBlocks(cur, tag)[0];
    if (cur === undefined) return undefined;
  }
  const text = decodeEntities(cur.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")).trim();
  return text || undefined;
}

/** A numeric `<tag>` value, or undefined. */
export function xmlNumber(xml: string, ...path: string[]): number | undefined {
  const v = xmlValue(xml, ...path);
  if (v === undefined) return undefined;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}
