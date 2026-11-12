// The benchmark is the profile's when it sets one; otherwise a stated convention, unchanged — so the requests a
// recorded replay holds are still the ones made — and every output says which was used and why.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { benchmarkNote, bookConvention, chooseBenchmark, listingConvention } from "../src/analyze/benchmark.js";
import { benchmarkFor as bookBenchmark } from "../src/analyze/portfolio/run-risk.js";
import { benchmarkFor as screenBenchmark } from "../src/analyze/screen/builtin.js";
import { benchmarkChoice, defaultBenchmark } from "../src/analyze/technicals.js";
import { defaultProfile, parseProfileValue, saveProfile } from "../src/core/profile.js";

const freshHome = () => {
  process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "bench-"));
};

describe("benchmarks", () => {
  beforeEach(() => freshHome());

  it("keeps the conventions when the profile sets none, and says they are conventions", () => {
    expect(defaultBenchmark("us")).toBe("SPY");
    expect(defaultBenchmark("euronext", "XPAR")).toBe("FR0003500008");
    expect(defaultBenchmark("euronext", "ETFP")).toBe("FR0003500008");
    expect(defaultBenchmark("euronext", "XAMS")).toBe("CW8.PA");
    expect(defaultBenchmark("crypto")).toBeUndefined();
    expect(bookBenchmark("EUR")).toBe("CW8.PA");
    expect(bookBenchmark("USD")).toBe("SPY");
    expect(screenBenchmark("CAC40", []).symbol).toBe("FR0003500008");
    expect(screenBenchmark(undefined, ["NVDA", "AAPL"]).symbol).toBe("SPY");
    const c = benchmarkChoice("us")!;
    expect(c.source).toBe("convention");
    expect(benchmarkNote(c)).toMatch(/^benchmark SPY: convention: a US listing .*profile set benchmark <symbol>/);
  });

  it("uses the profile's benchmark everywhere a convention would apply, crypto aside", () => {
    saveProfile({ ...defaultProfile("DE", "EUR"), benchmark: parseProfileValue("benchmark", "iwda.as") as string });
    expect(defaultBenchmark("us")).toBe("IWDA.AS");
    expect(defaultBenchmark("euronext", "XPAR")).toBe("IWDA.AS");
    expect(defaultBenchmark("crypto")).toBeUndefined();
    expect(bookBenchmark("USD")).toBe("IWDA.AS");
    expect(screenBenchmark("SPX", [])).toMatchObject({ symbol: "IWDA.AS", why: expect.stringMatching(/profile's benchmark/) });
    expect(benchmarkNote(chooseBenchmark(bookConvention("EUR"))!)).toBe("benchmark IWDA.AS: the profile's benchmark (`profile set benchmark`)");
    expect(chooseBenchmark(listingConvention("crypto"))).toBeUndefined();
  });

  it("validates the profile field, and clears it with default", () => {
    expect(parseProfileValue("benchmark", "^gspc")).toBe("^GSPC");
    expect(parseProfileValue("benchmark", "default")).toBeUndefined();
    expect(() => parseProfileValue("benchmark", "not a symbol")).toThrow(/a benchmark is a symbol/);
  });
});
