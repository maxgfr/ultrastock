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

  it("flags unusual attention — a Wikipedia spike, a Reddit jump or a new top-20 entry — and nothing ordinary", () => {
    const flags = morningFlags(
      facts({
        attention: [
          { symbol: "MC.PA", source: "wikipedia", ratio: 2.4, keys: ["MC.PA.social.wiki.ratio"] },
          { symbol: "ALO.PA", source: "wikipedia", ratio: 1.3, keys: ["ALO.PA.social.wiki.ratio"] },
          { symbol: "NVDA", source: "reddit", mentions: 90, mentionsPrev: 25, rank: 4, keys: ["NVDA.social.reddit.mentions"] },
          { symbol: "AMD", source: "reddit", mentions: 15, mentionsPrev: 2, rank: 30, keys: ["AMD.social.reddit.mentions"] }, // too few to mean anything
          { symbol: "SMCI", source: "reddit", mentions: 48, rank: 2, keys: ["SMCI.social.reddit.rank"] },
          { symbol: "TSLA", source: "reddit", mentions: 300, mentionsPrev: 250, rank: 1, keys: ["TSLA.social.reddit.mentions"] }, // always talked about
        ],
      }),
    ).filter((f) => f.kind === "attention");
    expect(flags.map((f) => [f.symbol, f.level])).toEqual([
      ["NVDA", "medium"],
      ["MC.PA", "info"],
      ["SMCI", "info"],
    ]);
    expect(flags[0]!.text).toMatch(/90 Reddit mentions in 24 hours, against 25 the day before/);
    expect(flags[1]!.text).toMatch(/2\.4× their 90-day baseline/);
    expect(flags[2]!.text).toMatch(/new in Reddit's 20 most discussed/);
    expect(flags.every((f) => /not a direction/.test(f.text))).toBe(true);
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
        {
          date: "2026-06-01",
          type: "buy",
          account: "pea",
          symbol: "ALO.PA",
          quantity: 100,
          price: 20,
          fee: 0,
          currency: "EUR",
          origin: "ticket:t-morning-test",
        },
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
      // The flagged results date: a calendar worklist for the web, not searched yet; the line's headlines.
      expect(r.confirmations.map((c) => `${c.symbol} ${c.status}`)).toEqual(["ALO.PA not-searched"]);
      const todo = JSON.parse(readFileSync(join(dir, "RESEARCH.ALO.PA.todo.json"), "utf8"));
      expect(todo.focus).toBe("calendar");
      expect(md).toMatch(/## Dates on the web\n\n<!-- web-dates -->\n- ALO\.PA earnings \d{4}-\d{2}-\d{2} \(tradingview\) \[E\d+\]: not searched yet/);
      expect(md).toMatch(/## Headlines — the last two days/);
      expect(store.items.some((i) => /^ALO\.PA\.news\.\d+$/.test(i.key) && /alstom/i.test(String(i.value)))).toBe(true);
      expect(readFileSync(join(homeDir(), "state", "alerts.json"), "utf8")).toBe(alertsBefore);

      // No profile, no book: the watchlist alone still gets its brief.
      process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "morning-bare-"));
      addToWatchlist(["MC.PA"], undefined, new Date("2026-10-01T00:00:00Z"));
      const bare = await morningRun(mkdtempSync(join(tmpdir(), "morning-bare-run-")), { markets: ["eu"] });
      expect(bare.universe).toEqual([{ symbol: "MC.PA", origins: ["watchlist"] }]);
      expect(bare.notes.some((n) => /^no real book read/.test(n))).toBe(true);
    });
  }, 120_000);

  it("shows no stop for a line closed and reopened since its ticket, and keeps the stop of a line only trimmed", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "morning-stale-stop-"));
    saveProfile(defaultProfile("FR", "EUR"));
    const buy = (account: string, date: string, quantity: number, origin: string) =>
      ({ date, type: "buy", account, symbol: "ALO.PA", quantity, price: 20, fee: 0, currency: "EUR", origin }) as const;
    const sell = (account: string, date: string, quantity: number) =>
      ({ date, type: "sell", account, symbol: "ALO.PA", quantity, price: 21, fee: 0, currency: "EUR", origin: "manual" }) as const;
    await appendTransactions(
      [
        { date: "2026-06-01", type: "deposit", account: "pea", amount: 10_000, currency: "EUR", origin: "manual" },
        { date: "2026-06-01", type: "deposit", account: "cto", amount: 5000, currency: "EUR", origin: "manual" },
        // pea: bought with a stop, sold out, bought again by a ticket that sets no stop.
        buy("pea", "2026-06-01T09:00:00", 100, "ticket:t-pea-first"),
        sell("pea", "2026-07-01", 100),
        buy("pea", "2026-08-03T09:00:00", 100, "ticket:t-pea-again"),
        // cto: bought with a stop, then only trimmed — never closed.
        buy("cto", "2026-06-01T09:00:00", 50, "ticket:t-cto-first"),
        sell("cto", "2026-07-01", 20),
      ],
      "real",
    );
    const ticket = (id: string, account: string, filledAt: string, stop?: number) => ({
      id,
      createdAt: filledAt.replace("T09", "T08"),
      updatedAt: filledAt,
      status: "filled",
      order: {
        account,
        symbol: "ALO.PA",
        side: "buy",
        quantity: 100,
        price: 20,
        orderType: "limit",
        currency: "EUR",
        stop,
        assetKind: "equity",
        venue: "paper",
      },
      fingerprint: "test",
      fills: [{ at: filledAt, quantity: 100, price: 20, fee: 0, venue: "paper", method: "test" }],
      history: [{ at: filledAt, from: "working", to: "filled", why: "test" }],
    });
    mkdirSync(join(homeDir(), "tickets"), { recursive: true });
    // The abandoned stop sits far above the price: read as current, it raises a HIGH "at or below its stop" flag.
    for (const t of [
      ticket("t-pea-first", "pea", "2026-06-01T09:00:00.000Z", 1000),
      ticket("t-pea-again", "pea", "2026-08-03T09:00:00.000Z"),
      ticket("t-cto-first", "cto", "2026-06-01T09:00:00.000Z", 16),
    ])
      writeFileSync(join(homeDir(), "tickets", `${t.id}.json`), JSON.stringify(t));

    await withFixture("morning-alo", async () => {
      const dir = mkdtempSync(join(tmpdir(), "morning-stale-stop-run-"));
      const r = await morningRun(dir, { markets: ["eu"] });
      const store = EvidenceStore.load(dir)!;
      expect(store.byKey("TICKET.t-pea-first.stop")).toBeUndefined();
      expect(store.byKey("TICKET.t-pea-first.stopDistance")).toBeUndefined();
      expect(r.flags.filter((f) => f.kind === "stop").map((f) => f.text)).not.toContainEqual(expect.stringMatching(/t-pea-first/));
      // The cto line was trimmed, never closed: its entry ticket's stop still holds.
      expect(store.byKey("TICKET.t-cto-first.stopDistance")).toBeDefined();
      const md = readFileSync(r.file, "utf8");
      expect(md).toMatch(/- ALO\.PA \(pea\): no stop on record since the line was last opened on 2026-08-03/);
      expect(md).not.toMatch(/stop 1000/);
    });
  }, 120_000);

  it("shows no stop for a line closed and reopened on the ticket's own day, in a statement's date-only rows", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "morning-same-day-"));
    saveProfile(defaultProfile("FR", "EUR"));
    const row = (type: "buy" | "sell", quantity: number, origin = "import:broker") =>
      ({ date: "2026-08-03", type, account: "pea", symbol: "ALO.PA", quantity, price: 20, fee: 0, currency: "EUR", origin }) as const;
    // Bought by the ticket (its fill at 09:00, booked date-only), sold out, bought again from a statement — all on 3 August.
    await appendTransactions(
      [
        { date: "2026-06-01", type: "deposit", account: "pea", amount: 10_000, currency: "EUR", origin: "manual" },
        row("buy", 100, "ticket:t-same-day-first"),
        row("sell", 100),
        row("buy", 80),
      ],
      "real",
    );
    mkdirSync(join(homeDir(), "tickets"), { recursive: true });
    const at = "2026-08-03T09:00:00.000Z";
    writeFileSync(
      join(homeDir(), "tickets", "t-same-day-first.json"),
      JSON.stringify({
        id: "t-same-day-first",
        createdAt: "2026-08-03T08:00:00.000Z",
        updatedAt: at,
        status: "filled",
        order: {
          account: "pea",
          symbol: "ALO.PA",
          side: "buy",
          quantity: 100,
          price: 20,
          orderType: "limit",
          currency: "EUR",
          stop: 1000,
          assetKind: "equity",
          venue: "paper",
        },
        fingerprint: "test",
        fills: [{ at, quantity: 100, price: 20, fee: 0, venue: "paper", method: "test" }],
        history: [{ at, from: "working", to: "filled", why: "test" }],
      }),
    );
    await withFixture("morning-alo", async () => {
      const dir = mkdtempSync(join(tmpdir(), "morning-same-day-run-"));
      const r = await morningRun(dir, { markets: ["eu"] });
      // "Opened on 2026-08-03" holds no hour: the 09:00 fill is not "since" it — the line it protected was sold that day.
      expect(EvidenceStore.load(dir)!.byKey("TICKET.t-same-day-first.stop")).toBeUndefined();
      expect(r.flags.filter((f) => f.kind === "stop")).toEqual([]);
      expect(readFileSync(r.file, "utf8")).toMatch(/- ALO\.PA \(pea\): no stop on record since the line was last opened on 2026-08-03/);
    });
  }, 120_000);

  it("reads a line's stop from the tickets booked to that book, the one filled last", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "morning-books-"));
    saveProfile(defaultProfile("FR", "EUR"));
    const buy = (account: string, date: string, origin: string) =>
      ({ date, type: "buy", account, symbol: "ALO.PA", quantity: 100, price: 20, fee: 0, currency: "EUR", origin }) as const;
    const deposit = (account: string) => ({ date: "2026-06-01", type: "deposit", account, amount: 10_000, currency: "EUR", origin: "manual" }) as const;
    // Real book: pea bought by hand; cto bought by two tickets.
    await appendTransactions(
      [
        deposit("pea"),
        deposit("cto"),
        buy("pea", "2026-06-01T09:00:00", "manual"),
        buy("cto", "2026-06-02T09:00:00", "ticket:t-market"),
        buy("cto", "2026-08-03T09:00:00", "ticket:t-limit"),
      ],
      "real",
    );
    // Paper book: the same account id and symbol, through a paper ticket whose stop sits far above the price.
    await appendTransactions([deposit("pea"), buy("pea", "2026-08-03T09:00:00", "ticket:t-paper")], "paper");
    const ticket = (id: string, account: string, createdAt: string, filledAt: string, stop: number) => ({
      id,
      createdAt,
      updatedAt: filledAt,
      status: "filled",
      order: {
        account,
        symbol: "ALO.PA",
        side: "buy",
        quantity: 100,
        price: 20,
        orderType: "limit",
        currency: "EUR",
        stop,
        assetKind: "equity",
        venue: "paper",
      },
      fingerprint: "test",
      fills: [{ at: filledAt, quantity: 100, price: 20, fee: 0, venue: "paper", method: "test" }],
      history: [{ at: filledAt, from: "working", to: "filled", why: "test" }],
    });
    mkdirSync(join(homeDir(), "tickets"), { recursive: true });
    for (const t of [
      ticket("t-paper", "pea", "2026-08-03T08:00:00.000Z", "2026-08-03T09:00:00.000Z", 1000),
      // A limit ticket created first and filled in August; a market ticket created a day later, filled at once in June.
      ticket("t-limit", "cto", "2026-06-01T08:00:00.000Z", "2026-08-03T09:00:00.000Z", 15),
      ticket("t-market", "cto", "2026-06-02T08:00:00.000Z", "2026-06-02T09:00:00.000Z", 16),
    ])
      writeFileSync(join(homeDir(), "tickets", `${t.id}.json`), JSON.stringify(t));
    await withFixture("morning-alo", async () => {
      const dir = mkdtempSync(join(tmpdir(), "morning-books-run-"));
      const r = await morningRun(dir, { markets: ["eu"] });
      const store = EvidenceStore.load(dir)!;
      // The paper ticket protects the paper line only: the real pea line has no stop, and is not called unprotected for it.
      expect(store.byKey("TICKET.t-paper.stop")).toBeUndefined();
      // The cto line's latest stop is the last FILL's, not the last-created ticket's.
      expect(store.byKey("TICKET.t-limit.stop")?.value).toBe(15);
      expect(store.byKey("TICKET.t-market.stop")).toBeUndefined();
      expect(store.byKey("TICKET.t-limit.stopDistance")).toBeDefined();
      expect(readFileSync(r.file, "utf8")).toMatch(/- ALO\.PA: stop 15 EUR \[E\d+\]/);
      expect(readFileSync(r.file, "utf8")).not.toMatch(/ALO\.PA \(pea\): no stop on record/);
    });
  }, 120_000);
});
