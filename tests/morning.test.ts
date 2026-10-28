import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addRule } from "../src/alerts/alerts.js";
import { type MorningFacts, morningFlags, morningRun, nextWeekday } from "../src/analyze/morning/run.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { addThesis } from "../src/journal/journal.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import { addToWatchlist, loadWatchlist, removeFromWatchlist } from "../src/portfolio/watchlist.js";
import { withFixture } from "./helpers/fixtures.js";

const facts = (over: Partial<MorningFacts> = {}): MorningFacts => ({
  today: "2026-10-28",
  end: "2026-11-11",
  origins: { "ALO.PA": ["held"], NVDA: ["held"], "MC.PA": ["watchlist"] },
  dates: [],
  moves: [],
  stops: [],
  alerts: [],
  theses: [],
  macro: [],
  events: [],
  closures: [],
  ...over,
});

describe("morning flags", () => {
  it("ranks earnings within three sessions high, later ones in the window medium, a held line's next results after the window info", () => {
    const flags = morningFlags(
      facts({
        dates: [
          {
            symbol: "MC.PA",
            kind: "earnings",
            date: "2026-10-30",
            timing: "before market open",
            source: "tradingview",
            key: "MC.PA.cat.earnings.date",
            sessionsAway: 2,
          },
          { symbol: "NVDA", kind: "earnings", date: "2026-11-10", projected: true, source: "nasdaq", key: "NVDA.cat.earnings.date", sessionsAway: 9 },
          {
            symbol: "ALO.PA",
            kind: "earnings",
            date: "2026-11-17",
            timing: "after market close",
            source: "tradingview",
            key: "ALO.PA.cat.earnings.date",
            sessionsAway: 14,
          },
          { symbol: "MC.PA", kind: "earnings", date: "2027-01-28", source: "tradingview", key: "MC.PA.cat.earnings.date2", sessionsAway: 60 },
        ],
      }),
    );
    expect(flags.map((f) => `${f.level} ${f.symbol} ${f.date}`)).toEqual(["high MC.PA 2026-10-30", "medium NVDA 2026-11-10", "info ALO.PA 2026-11-17"]);
    expect(flags[0]!.text).toMatch(/\(before market open\), in 2 sessions/);
    expect(flags[1]!.text).toMatch(/projected, not confirmed/);
    expect(flags[1]!.text).toMatch(/a stop does not protect against a gap/);
    expect(flags[2]!.text).toMatch(/after the window/);
  });

  it("flags a stop within 3 %, a crossed stop, a true alert, an overdue thesis, a large move and today's macro", () => {
    const flags = morningFlags(
      facts({
        stops: [
          { symbol: "ALO.PA", ticket: "t-aaaaaaaa", stop: 16, distancePct: 1.2, keys: ["TICKET.t-aaaaaaaa.stopDistance"] },
          { symbol: "NVDA", ticket: "t-bbbbbbbb", stop: 230, distancePct: -4, keys: ["TICKET.t-bbbbbbbb.stopDistance"] },
          { symbol: "NVDA", ticket: "t-cccccccc", stop: 100, distancePct: 50, keys: ["TICKET.t-cccccccc.stopDistance"] },
        ],
        alerts: [{ symbol: "ALO.PA", rule: "a-1", expr: "close < sma200", bar: "2026-10-27", key: "ALO.PA.watch.a-1" }],
        theses: [
          { id: "th-sap-1", symbol: "SAP.DE", state: "idea", reviewBy: "2026-10-01", key: "THESIS.th-sap-1.reviewBy" },
          { id: "th-mc-1", symbol: "MC.PA", state: "entry-ready", key: "THESIS.th-mc-1.state" },
        ],
        moves: [
          { symbol: "ALO.PA", changePct: -4.2, key: "ALO.PA.quote.changePct" },
          { symbol: "MC.PA", changePct: 3.5, key: "MC.PA.quote.changePct" },
          { symbol: "NVDA", changePct: 0.7, key: "NVDA.quote.changePct" },
        ],
        macro: [
          { date: "2026-10-28", currency: "USD", key: "M.1", text: "USD | FOMC Statement" },
          { date: "2026-10-29", currency: "EUR", key: "M.2", text: "EUR | Main Refinancing Rate" },
        ],
        closures: [{ market: "Euronext", date: "2026-10-29", name: "Test Day", early: false, key: "S.1" }],
      }),
    );
    const by = (kind: string) => flags.filter((f) => f.kind === kind).map((f) => `${f.level} ${f.symbol ?? f.date}`);
    expect(by("stop")).toEqual(["high ALO.PA", "high NVDA"]);
    expect(flags.find((f) => f.symbol === "NVDA" && f.kind === "stop")!.text).toMatch(/at or below its stop/);
    expect(by("alert")).toEqual(["medium ALO.PA"]);
    expect(by("thesis")).toEqual(["medium SAP.DE", "info MC.PA"]);
    expect(by("move")).toEqual(["medium ALO.PA", "info MC.PA"]);
    expect(by("macro")).toEqual(["medium 2026-10-28", "info 2026-10-29"]);
    expect(by("closure")).toEqual(["info 2026-10-29"]);
    expect(flags.map((f) => f.level)).toEqual(
      [...flags.map((f) => f.level)].sort((a, b) => ["high", "medium", "info"].indexOf(a) - ["high", "medium", "info"].indexOf(b)),
    );
  });

  it("flags an event by the book's weight, and the Fed and the ECB always", () => {
    const ev = (id: string, date: string, type: "election" | "central-bank") => ({
      id,
      date,
      type,
      kind: type === "election" ? ("legislative" as const) : ("rate-decision" as const),
      iso: "US",
      title: id,
      source: "x",
      url: "https://example.org",
    });
    const flags = morningFlags(
      facts({
        events: [
          { event: ev("fed", "2026-10-28", "central-bank"), key: "EVENT.fed", weightPct: 13, exposureKeys: ["X"] },
          { event: ev("vote", "2026-11-03", "election"), key: "EVENT.vote", weightPct: 1, exposureKeys: ["X"] },
          { event: ev("ecb", "2026-11-05", "central-bank"), key: "EVENT.ecb", exposureKeys: [] },
        ],
      }),
    );
    expect(flags.map((f) => `${f.level} ${f.date}`)).toEqual(["high 2026-10-28", "info 2026-11-05"]);
  });

  it("the next weekday skips the weekend", () => {
    expect(nextWeekday("2026-10-30")).toBe("2026-11-02");
    expect(nextWeekday("2026-10-28")).toBe("2026-10-29");
  });
});

describe("watchlist", () => {
  it("adds once, updates the note, removes", () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "wl-home-"));
    addToWatchlist(["alo.pa", "MC.PA"], undefined, new Date("2026-10-28T07:00:00Z"));
    addToWatchlist(["ALO.PA"], "results season", new Date("2026-10-29T07:00:00Z"));
    expect(loadWatchlist()).toEqual([
      { symbol: "ALO.PA", note: "results season", addedAt: "2026-10-28T07:00:00.000Z" },
      { symbol: "MC.PA", addedAt: "2026-10-28T07:00:00.000Z" },
    ]);
    expect(removeFromWatchlist("mc.pa")).toBe(true);
    expect(removeFromWatchlist("MC.PA")).toBe(false);
    expect(loadWatchlist().map((x) => x.symbol)).toEqual(["ALO.PA"]);
  });
});

describe("morning on a recorded fixture", () => {
  it("reads the book, the stop, the alert, the thesis and the watchlist — and leaves the alert state alone", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "morning-home-"));
    saveProfile(defaultProfile("FR", "EUR"));
    await appendTransactions(
      [
        { date: "2026-06-01", type: "deposit", account: "pea", amount: 10_000, currency: "EUR", origin: "manual" },
        { date: "2026-06-01", type: "buy", account: "pea", symbol: "ALO.PA", quantity: 100, price: 20, fee: 0, currency: "EUR", origin: "manual" },
      ],
      "real",
    );
    const ticket = {
      id: "t-morning-test",
      createdAt: "2026-06-01T08:00:00.000Z",
      updatedAt: "2026-06-01T09:00:00.000Z",
      status: "filled",
      order: {
        account: "pea",
        symbol: "ALO.PA",
        side: "buy",
        quantity: 100,
        price: 20,
        orderType: "limit",
        currency: "EUR",
        stop: 16,
        assetKind: "equity",
        venue: "paper",
      },
      fingerprint: "test",
      fills: [],
      history: [],
    };
    mkdirSync(join(homeDir(), "tickets"), { recursive: true });
    writeFileSync(join(homeDir(), "tickets", `${ticket.id}.json`), JSON.stringify(ticket));
    addRule({ kind: "expr", symbol: "ALO.PA", expr: "close > 0", message: "always true" }, new Date("2026-10-01T00:00:00Z"));
    addThesis(
      {
        symbol: "SAP.DE",
        thesis: "cloud backlog keeps compounding through the cycle",
        invalidation: "cloud backlog growth below 20 %",
        reviewBy: "2026-10-01",
      },
      new Date("2026-09-01T00:00:00Z"),
    );
    addToWatchlist(["MC.PA"], "luxury", new Date("2026-10-01T00:00:00Z"));
    const alertsBefore = readFileSync(join(homeDir(), "state", "alerts.json"), "utf8");

    await withFixture("morning-alo", async () => {
      const dir = mkdtempSync(join(tmpdir(), "morning-run-"));
      const r = await morningRun(dir, { markets: ["eu"] });
      expect(r.universe).toEqual([
        { symbol: "ALO.PA", origins: ["held", "alert"] },
        { symbol: "SAP.DE", origins: ["thesis"] },
        { symbol: "MC.PA", origins: ["watchlist"] },
      ]);
      const kinds = r.flags.map((f) => `${f.level} ${f.kind} ${f.symbol ?? ""}`.trim());
      expect(kinds).toContain("medium alert ALO.PA");
      expect(kinds).toContain("medium thesis SAP.DE");
      expect(kinds.some((k) => / earnings ALO\.PA$/.test(k))).toBe(true);

      const store = EvidenceStore.load(dir)!;
      expect(store.byKey("ALO.PA.cat.earnings.date")!.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(store.byKey("ALO.PA.quote.changePct")).toBeDefined();
      expect(store.byKey("TICKET.t-morning-test.stopDistance")!.derivedFrom!.length).toBe(2);
      expect(store.byKey("PORTFOLIO.real.ALO.PA.unrealizedPct")!.derivedFrom!.length).toBe(2);
      expect(store.items.some((i) => /^ALO\.PA\.watch\.a-[a-z0-9]+$/.test(i.key) && i.value === true)).toBe(true);

      const md = readFileSync(r.file, "utf8");
      expect(md).toMatch(/^# Morning brief — /);
      expect(md).toMatch(/## To watch/);
      expect(md).toMatch(/\| ALO\.PA \| [\d.]+ EUR \[E\d+\] \|/);
      expect(md).toMatch(/### Europe regime/);
      expect(readFileSync(join(homeDir(), "state", "alerts.json"), "utf8")).toBe(alertsBefore);

      // No profile, no book: the watchlist alone still gets its brief.
      process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "morning-bare-"));
      addToWatchlist(["MC.PA"], undefined, new Date("2026-10-01T00:00:00Z"));
      const bare = await morningRun(mkdtempSync(join(tmpdir(), "morning-bare-run-")), { markets: ["eu"] });
      expect(bare.universe).toEqual([{ symbol: "MC.PA", origins: ["watchlist"] }]);
      expect(bare.notes.some((n) => /^no real book read/.test(n))).toBe(true);
    });
  }, 120_000);
});
