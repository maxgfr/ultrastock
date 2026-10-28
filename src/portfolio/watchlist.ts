// The watchlist: names the user follows without holding them, read by the
// morning brief next to the holdings, the open theses and the alerts. State
// lives in ULTRASTOCK_HOME/state/watchlist.json; a symbol is stored as the
// listing it resolves to, so `alstom` and `ALO.PA` are one entry.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "../core/paths.js";
import { writeFileAtomic } from "../engine.js";

export interface WatchItem {
  symbol: string;
  note?: string;
  addedAt: string;
}

const statePath = () => join(homeDir(), "state", "watchlist.json");

export function loadWatchlist(): WatchItem[] {
  return existsSync(statePath()) ? (JSON.parse(readFileSync(statePath(), "utf8")) as WatchItem[]) : [];
}

function saveWatchlist(items: WatchItem[]): void {
  mkdirSync(join(homeDir(), "state"), { recursive: true });
  writeFileAtomic(statePath(), `${JSON.stringify(items, null, 2)}\n`, 0o600);
}

/** Add symbols (already resolved); one already listed keeps its date and takes the new note if one is given. */
export function addToWatchlist(symbols: readonly string[], note: string | undefined, now = new Date()): WatchItem[] {
  const items = loadWatchlist();
  for (const raw of symbols) {
    const symbol = raw.toUpperCase();
    const old = items.find((x) => x.symbol === symbol);
    if (old) {
      if (note) old.note = note;
    } else items.push({ symbol, ...(note ? { note } : {}), addedAt: now.toISOString() });
  }
  saveWatchlist(items);
  return items;
}

export function removeFromWatchlist(symbol: string): boolean {
  const items = loadWatchlist();
  const kept = items.filter((x) => x.symbol !== symbol.toUpperCase());
  saveWatchlist(kept);
  return kept.length !== items.length;
}
