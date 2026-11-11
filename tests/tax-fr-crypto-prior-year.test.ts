// FR crypto, the command: a disposal of an earlier year must still take its share of the acquisition
// price out of the pool (CGI art. 150 VH bis III-B; form 2086 lines 221 and 223).
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { appendTransactions } from "../src/portfolio/ledger.js";

// A price source that answers for the days it is asked for, and only those — as a venue's klines endpoint does.
// BTCUSDT closes at 60 000 in 2025 and 80 000 in 2026.
const asked: Array<{ from: string; to: string }> = [];
vi.mock("../src/providers/router.js", async (original) => ({
  ...(await original<typeof import("../src/providers/router.js")>()),
  resolveSymbol: async (s: string) => ({ instrument: { symbol: s, market: "crypto" }, notes: [] }),
  getHistory: async (_r: unknown, req: { from: Date; to: Date }) => {
    asked.push({ from: req.from.toISOString().slice(0, 10), to: req.to.toISOString().slice(0, 10) });
    const bars: Array<{ date: string; close: number }> = [];
    for (let t = req.from.getTime(); t <= req.to.getTime(); t += 86_400_000) {
      const date = new Date(t).toISOString().slice(0, 10);
      bars.push({ date, close: date < "2026-01-01" ? 60_000 : 80_000 });
    }
    return { bars, notes: [] };
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FR: crypto sold for euros in two different years", () => {
  it("the second year's gain is computed on the acquisition price net of the first year's fraction", async () => {
    //   2023-01-10 buy 1 BTC for 20 000 €                                     line 220 = 20 000
    //   2025-06-03 sell 0.5 BTC for 30 000 €, portfolio 1 BTC = 60 000 €      fraction 20 000 × 30 000 / 60 000 = 10 000
    //   2026-06-02 sell 0.5 BTC for 40 000 €, portfolio 0.5 BTC = 40 000 €    221 = 10 000, 223 = 10 000
    //   2026 gain = 40 000 − 10 000 × 40 000 / 40 000 = 30 000 €   (in all: 70 000 € received − 20 000 € paid = 50 000 €,
    //   20 000 € of it taxed in 2025).
    // 1 $ = 1 € throughout, so the USDT closes are euro prices.
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      const [, start, end] = /\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(url) ?? [];
      const rates: Record<string, Record<string, number>> = {};
      for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000)
        rates[new Date(t).toISOString().slice(0, 10)] = { USD: 1 };
      return new Response(JSON.stringify({ base: "EUR", rates }), { headers: { "content-type": "application/json" } });
    });
    await appendTransactions(
      [
        { date: "2023-01-10", type: "buy", account: "kraken", symbol: "BTCEUR", quantity: 1, price: 20_000, currency: "EUR", origin: "import:kraken" },
        { date: "2025-06-03", type: "sell", account: "kraken", symbol: "BTCEUR", quantity: 0.5, price: 60_000, currency: "EUR", origin: "import:kraken" },
        { date: "2026-06-02", type: "sell", account: "kraken", symbol: "BTCEUR", quantity: 0.5, price: 80_000, currency: "EUR", origin: "import:kraken" },
      ],
      "zzprior",
    );
    const lots = async (year: string) => {
      let out = "";
      let err = "";
      vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
        out += String(c);
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
        err += String(c);
        return true;
      });
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}: ${err}`);
      }) as never);
      try {
        await main(["tax", "lots", "--regime", "fr", "--year", year, "--book", "zzprior", "--json"]);
      } finally {
        vi.restoreAllMocks();
      }
      return (JSON.parse(out) as Array<{ kind: string; gain?: number; lines?: Record<string, number> }>).filter((r) => r.kind === "crypto-disposal");
    };
    // The 2025 return, as filed: gain 20 000 €.
    expect((await lots("2025")).map((r) => [r.lines?.["223"], r.gain])).toEqual([[20_000, 20_000]]);
    // The 2026 return.
    const y26 = await lots("2026");
    expect(asked.length).toBeGreaterThan(0);
    expect(y26.map((r) => [r.lines?.["221"], r.lines?.["223"], r.gain])).toEqual([[10_000, 10_000, 30_000]]);
  });
});
