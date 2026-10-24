// maxgfr/binance-historical — the owner's bulk kline exporter: years of spot,
// USD-M or COIN-M candles (and futures mark/index/premium klines), resumable,
// checkpointed, weight-budgeted. ultrastock shells out to the installed CLI
// (`--json` report on stdout, candles in files under --output) for windows the
// REST pager would take minutes over; small windows stay on the REST API.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { have, sh, shAsync } from "../../engine.js";
import type { Bar, Interval } from "../types.js";
import { ProviderError } from "../types.js";

export const SOURCE = "binance-historical";

export interface BinanceHistoricalInfo {
  installed: boolean;
  version?: string;
  schemaVersion?: number;
  /** The contract this adapter was written against still holds. */
  compatible: boolean;
}

/** Is the CLI installed, and does its machine contract (`describe --json`) match? */
export function binanceHistoricalInfo(): BinanceHistoricalInfo {
  if (!have("binance-historical")) return { installed: false, compatible: false };
  const r = sh("binance-historical", ["describe", "--json"], { timeoutMs: 15_000 });
  if (!r.ok) return { installed: true, compatible: false };
  try {
    const d = JSON.parse(r.stdout) as { schemaVersion?: number; version?: string; markets?: Record<string, { fields?: string[] }> };
    const fields = d.markets?.spot?.fields ?? [];
    return {
      installed: true,
      version: d.version,
      schemaVersion: d.schemaVersion,
      compatible: d.schemaVersion === 1 && ["openTime", "open", "high", "low", "close", "volume"].every((f) => fields.includes(f)),
    };
  } catch {
    return { installed: true, compatible: false };
  }
}

export interface BulkRequest {
  pair: string;
  market?: "spot" | "usd-m" | "coin-m";
  kind?: "trade" | "mark" | "index" | "premium";
  interval: Interval | "1m" | "5m" | "30m" | "2h" | "12h" | "3d" | "1M";
  start: Date;
  end: Date;
}

/** Download closed candles through the CLI and return them as bars, oldest first. */
export async function bulkKlines(req: BulkRequest): Promise<{ bars: Bar[]; report: unknown }> {
  const info = binanceHistoricalInfo();
  if (!info.installed)
    throw new ProviderError(
      SOURCE,
      "binance-historical is not installed — npm install -g binance-historical, or brew install maxgfr/tap/binance-historical",
      0,
    );
  if (!info.compatible)
    throw new ProviderError(SOURCE, `binance-historical ${info.version ?? "?"} does not speak the expected describe contract (schemaVersion 1)`, 0);
  const out = mkdtempSync(join(tmpdir(), "ultrastock-bh-"));
  try {
    const args = [
      "download",
      "--pair",
      req.pair,
      "--market",
      req.market ?? "spot",
      "--kind",
      req.kind ?? "trade",
      "--interval",
      req.interval,
      "--start",
      req.start.toISOString(),
      "--end",
      req.end.toISOString(),
      "--output",
      out,
      "--format",
      "jsonl",
      "--json",
    ];
    const r = await shAsync("binance-historical", args, { timeoutMs: 30 * 60_000 });
    let report: {
      status?: string;
      results?: Array<{ status?: string; outputPath?: string; error?: { code?: string; message?: string; httpStatus?: number } }>;
    };
    try {
      report = JSON.parse(r.stdout);
    } catch {
      throw new ProviderError(SOURCE, `no report from binance-historical: ${(r.stderr || r.stdout).slice(0, 300)}`, 0);
    }
    const res = report.results?.[0];
    if (!res || res.status === "failed" || res.error) {
      const e = res?.error;
      throw new ProviderError(SOURCE, `${req.pair}: ${e?.code ?? "FAILED"} ${e?.message ?? ""}`.trim(), e?.httpStatus ?? 0);
    }
    const file = res.outputPath ?? join(out, readdirSync(out).find((f) => f.endsWith(".jsonl")) ?? "");
    const bars: Bar[] = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const k = JSON.parse(line) as { openTime: number; open: string; high: string; low: string; close: string; volume: string; trades: number };
        const iso = new Date(k.openTime).toISOString();
        return {
          date: /^(1d|3d|1w|1M)$/.test(req.interval) ? iso.slice(0, 10) : iso,
          open: Number(k.open),
          high: Number(k.high),
          low: Number(k.low),
          close: Number(k.close),
          volume: Number(k.volume),
          trades: k.trades,
        };
      });
    return { bars, report };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
