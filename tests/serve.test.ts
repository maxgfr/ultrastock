import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadMarkedBook } from "../src/analyze/portfolio/book.js";
import { Findings } from "../src/analyze/portfolio/findings.js";
import { setSqliteLoaderForTests, sqliteSupported, withStore } from "../src/core/db.js";
import { clockNow, setNetMode } from "../src/core/net.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { addThesis } from "../src/journal/journal.js";
import { appendTransactions, type Transaction } from "../src/portfolio/ledger.js";
import { writeSnapshots } from "../src/portfolio/tracking.js";
import { fmt } from "../src/serve/pages.js";
import { type Dashboard, serveToken, startDashboard } from "../src/serve/server.js";
import { createTicket } from "../src/trading/tickets.js";
import { withFixture } from "./helpers/fixtures.js";

const TOKEN = "test-token-0123456789abcdef";
const XSS = `<script>alert(1)</script>"'`;
const XSS_ESCAPED = "&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;";

/** The paper book of tests/portfolio-analytics.test.ts: its fixture holds every request these pages send. */
const PAPER: Array<Omit<Transaction, "id">> = [
  { date: "2026-09-01", type: "deposit", account: "pea", amount: 10_000, currency: "EUR", origin: "manual" },
  { date: "2026-09-01", type: "deposit", account: "cto", amount: 5000, currency: "USD", origin: "manual" },
  { date: "2026-09-02", type: "buy", account: "pea", symbol: "MC.PA", quantity: 5, price: 600, fee: 3, currency: "EUR", origin: "paper" },
  { date: "2026-09-02", type: "buy", account: "cto", symbol: "NVDA", quantity: 10, price: 180, fee: 1, currency: "USD", origin: "paper" },
  { date: "2026-09-03", type: "deposit", account: "cto", amount: 1000, currency: "EUR", origin: "manual" },
  { date: "2026-09-03", type: "buy", account: "cto", symbol: "MC.PA", quantity: 1, price: 590, fee: 2, currency: "EUR", origin: "paper" },
  { date: "2026-09-20", type: "dividend", account: "cto", symbol: "NVDA", amount: 0.1, currency: "USD", origin: "manual" },
];

/**
 * The real book carries the hostile text: an account, a symbol (bought and sold, so never priced — no request)
 * and notes. EUR only, no open position: marking it sends nothing.
 */
const REAL: Array<Omit<Transaction, "id">> = [
  { date: "2026-09-01", type: "deposit", account: XSS, amount: 2000, currency: "EUR", note: XSS, origin: "manual" },
  { date: "2026-09-02", type: "buy", account: XSS, symbol: XSS, quantity: 1, price: 100, currency: "EUR", note: XSS, origin: "manual" },
  { date: "2026-09-03", type: "sell", account: XSS, symbol: XSS, quantity: 1, price: 110, currency: "EUR", origin: "manual" },
];

const newHome = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `serve-${tag}-`));
  process.env.ULTRASTOCK_HOME = dir;
  return dir;
};

/** Every file under `dir` with the SHA-256 of its bytes. */
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let d: Dashboard;

function call(path: string, o: { method?: string; headers?: Record<string, string>; auth?: boolean } = {}): Promise<Reply> {
  const headers: Record<string, string> = { host: `127.0.0.1:${d.port}`, ...(o.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }), ...o.headers };
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: d.port, path, method: o.method ?? "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const ROUTES = [
  "/",
  "/analysis/risk",
  "/analysis/stress",
  "/analysis/income",
  "/analysis/location",
  "/analysis/lookthrough",
  "/ledger",
  "/journal",
  "/watch",
  "/tickets",
] as const;
const apiOf = (r: string) => (r === "/" ? "/api/portfolio" : `/api${r}`);

let home: string;

beforeAll(async () => {
  home = newHome("main");
  saveProfile(defaultProfile("FR", "EUR"));
  await appendTransactions(PAPER, "paper");
  await appendTransactions(REAL, "real");
  // The rest of the state, each carrying the hostile text where a page shows it.
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "state", "watchlist.json"), JSON.stringify([{ symbol: XSS, note: XSS, addedAt: "2026-09-01T00:00:00.000Z" }]));
  writeFileSync(
    join(home, "state", "alerts.json"),
    JSON.stringify([{ id: "a-1", kind: "expr", symbol: XSS, expr: `close < sma200 ${XSS}`, message: XSS, createdAt: "2026-09-01T00:00:00.000Z" }]),
  );
  mkdirSync(join(home, "journal"), { recursive: true });
  writeFileSync(
    join(home, "journal", "decisions.jsonl"),
    `${JSON.stringify({ id: "d-1", symbol: XSS, decidedAt: "2026-09-01T10:00:00.000Z", rating: "buy", horizon: 20, conviction: 3, thesis: XSS })}\n`,
  );
  mkdirSync(join(home, "knowledge"), { recursive: true });
  writeFileSync(join(home, "knowledge", "lessons.md"), `# Lessons\n\n- 2026-09-01: ${XSS}\n`);
  addThesis({ symbol: "MC.PA", thesis: `A long enough thesis ${XSS}`, invalidation: XSS, reviewBy: "2026-01-01" }, new Date("2026-09-01T00:00:00Z"));
  createTicket(
    { account: "pea", symbol: XSS, side: "buy", quantity: 1, price: 600, orderType: "limit", currency: "EUR", stop: 550, assetKind: "equity", venue: "paper" },
    { now: new Date("2026-09-01T00:00:00Z") },
  );
  d = await startDashboard({ port: 0, token: TOKEN, book: "paper" });
});

afterAll(async () => {
  await d?.close();
});

// tests/setup.ts points ULTRASTOCK_HOME at the suite's scratch home before each test: this file's is seeded once.
beforeEach(() => {
  process.env.ULTRASTOCK_HOME = home;
});

afterEach(() => {
  setNetMode({ kind: "live" });
  setSqliteLoaderForTests(undefined);
});

describe("serve: the HTTP guard", () => {
  it("refuses a request without the token, and says nothing about the data", async () => {
    for (const path of ["/", "/ledger?book=real", "/api/portfolio", "/nope"]) {
      const r = await call(path, { auth: false });
      expect(r.status).toBe(401);
      expect(r.body).not.toMatch(/MC\.PA|pea|EUR|script/);
    }
    expect((await call("/", { headers: { authorization: "Bearer wrong-token-wrong-token-00" } })).status).toBe(401);
    expect((await call("/?token=wrong-token-wrong-token-00", { auth: false })).status).toBe(401);
  });

  it("trades the token in the URL for a strict cookie and a redirect to the clean URL", async () => {
    const r = await call(`/ledger?book=real&token=${TOKEN}`, { auth: false });
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/ledger?book=real");
    const cookie = String(r.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    const pair = cookie.split(";")[0]!;
    const page = await call("/ledger?book=real", { auth: false, headers: { cookie: `other=1; ${pair}` } });
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/<h1>real book — ledger<\/h1>/);
    // An off-route path is never echoed into the redirect.
    expect((await call(`/.//evil.example/?token=${TOKEN}`, { auth: false })).headers.location).toBe("/");
  });

  it("accepts a bearer token, even next to a stale cookie", async () => {
    const r = await call("/api/watch", { headers: { cookie: "ultrastock_serve=stale" } });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
  });

  it("refuses a foreign Host (DNS rebinding), a cross-origin request, a write method and an unknown path", async () => {
    expect((await call("/", { headers: { host: "evil.example" } })).status).toBe(403);
    expect((await call("/", { headers: { host: `evil.example:${d.port}` } })).status).toBe(403);
    expect((await call("/watch", { headers: { host: `localhost:${d.port}` } })).status).toBe(200);
    expect((await call("/watch", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    // Another local server is the same site for the cookie, but not the same origin.
    expect((await call("/watch", { headers: { origin: "http://localhost:3000" } })).status).toBe(403);
    const post = await call("/", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
    for (const m of ["PUT", "DELETE", "OPTIONS"]) expect((await call("/", { method: m })).status).toBe(405);
    expect((await call("/etc/passwd")).status).toBe(404);
    expect((await call("/../profile.json")).status).toBe(404);
    expect((await call("/api/")).status).toBe(404);
    const head = await call("/watch", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });

  it("sends the security headers on every answer, and no CORS header", async () => {
    for (const r of [await call("/watch"), await call("/", { auth: false }), await call("/nope"), await call("/", { method: "POST" })]) {
      expect(r.headers["content-security-policy"]).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(Object.keys(r.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    }
  });

  it("refuses an unknown book and an unknown ledger filter", async () => {
    expect((await call("/?book=../../etc")).status).toBe(400);
    const r = await call("/ledger?book=paper&account=nope");
    expect(r.status).toBe(400);
    expect(r.body).not.toMatch(/at \w+ \(|\.ts:\d+/); // the message, never a stack
    expect((await call("/api/ledger?symbol=nope")).status).toBe(400);
  });

  it("keeps a given token to the MCP rule, and makes one when none is given", () => {
    expect(() => serveToken("short")).toThrow(/24\+ characters/);
    expect(() => serveToken("has spaces and is long enough!!")).toThrow(/24\+ characters/);
    expect(serveToken(undefined)).toMatch(/^[0-9a-f]{48}$/);
  });
});

describe("serve: the pages", () => {
  it("shows the paper book marked to market: the total and the weights `portfolio risk` starts from", async () => {
    await withFixture("portfolio-analytics-paper", async () => {
      const m = await loadMarkedBook("paper", new Findings(), clockNow());
      const r = await call("/?book=paper");
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toMatch(/text\/html/);
      expect(r.body).toContain(`${fmt(m.totalBase)} EUR`);
      for (const h of m.holdings) expect(r.body).toContain(`${fmt(h.weightPct)} %`);
      expect(r.body).toMatch(/<th scope="row">MC\.PA<\/th>/);
      expect(r.body).toMatch(/<nav aria-label="Dashboard">/);
      expect(r.body).toMatch(/As of <time datetime="2026-10-24T16:24:54\.844Z">/);
      expect(r.body).toMatch(/Money-weighted return \(XIRR\)/);
      expect(r.body).toMatch(/Circuit breaker/);
      // No store in this home (or no node:sqlite, as on Node 20): the one-line hint.
      const storeHint = sqliteSupported() ? /portfolio db init/ : /needs Node ≥ 22\.5/;
      expect(r.body).toMatch(storeHint);
      expect(r.body).not.toMatch(/<script/i);
      expect(r.body).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)[^"]*"\s*(src|href)=/);

      const api = JSON.parse((await call("/api/portfolio?book=paper")).body);
      expect(api.total).toBeCloseTo(m.totalBase, 6);
      expect(api.positions.map((p: { symbol: string }) => p.symbol)).toEqual(["MC.PA", "NVDA"]);
      expect(api.positions[0].weightPct).toBeCloseTo(m.holdings[0]!.weightPct!, 6);
      expect(api.performance.breaker).toHaveProperty("tripped");
      expect(api.history.hint).toMatch(storeHint);
    });
  }, 60_000);

  it("shows no XIRR, and says why, when a deposit's rate on its own date cannot be read", async () => {
    // The 5 000 USD deposit of 2026-09-01 needs that day's ECB rate, which the fixture never recorded:
    // counting the dollars as euros would show a wrong return as a fact.
    await withFixture("portfolio-analytics-paper", async () => {
      const api = JSON.parse((await call("/api/portfolio?book=paper")).body);
      expect(api.performance.xirr).toBeUndefined();
      expect(api.performance.xirrNotes.join("\n")).toMatch(/not computed: no EUR rate for USD on 2026-09-01/);
      const r = await call("/?book=paper");
      expect(r.body).toMatch(/Money-weighted return \(XIRR\)<\/dt><dd>n\/a<\/dd>/);
      expect(r.body).toMatch(/not computed: no EUR rate for USD on 2026-09-01/);
    });
  }, 60_000);

  it("renders each analysis from the same fixture", async () => {
    await withFixture("portfolio-analytics-paper", async () => {
      const expected: Record<string, RegExp[]> = {
        risk: [/annualised volatility of today&#39;s portfolio/, /1-day historical VaR 95 %/, /position limit — MC\.PA/],
        stress: [/COVID crash/, /portfolio move under the shock: equities −20 %/],
        income: [/NVDA dividends received/],
        location: [/MC\.PA ideal envelope \(French resident\)/, /room left under the PEA deposit ceiling/],
        lookthrough: [/no ETF or fund in the book: nothing to look through/],
      };
      for (const [a, res] of Object.entries(expected)) {
        const r = await call(`/analysis/${a}?book=paper`);
        expect(r.status, a).toBe(200);
        for (const re of res) expect(r.body, a).toMatch(re);
        expect(r.body).toMatch(/<h2>Sources<\/h2>/);
        const api = JSON.parse((await call(`/api/analysis/${a}?book=paper`)).body);
        expect(api.analysis).toBe(a);
        expect(Array.isArray(api.sections)).toBe(true);
      }
    });
  }, 60_000);

  it("lists the ledger newest first, filtered by account or symbol", async () => {
    const all = JSON.parse((await call("/api/ledger?book=paper")).body);
    expect(all.transactions.map((t: Transaction) => t.date)).toEqual([...PAPER.map((t) => t.date)].sort().reverse());
    const cto = JSON.parse((await call("/api/ledger?book=paper&account=cto")).body);
    expect(cto.transactions.every((t: Transaction) => t.account === "cto")).toBe(true);
    const nvda = await call("/ledger?book=paper&symbol=NVDA");
    expect(nvda.status).toBe(200);
    expect(nvda.body).toMatch(/2 of 7 transaction\(s\)/);
    expect(nvda.body).toMatch(/<option value="NVDA" selected>/);
  });

  it("shows the journal, the watchlist and rules, and the tickets", async () => {
    const j = await call("/journal");
    expect(j.status).toBe(200);
    expect(j.body).toMatch(/OVERDUE/);
    expect(JSON.parse((await call("/api/journal")).body).theses[0].overdue).toBe(true);
    const w = await call("/watch");
    expect(w.body).toMatch(/listed here, not evaluated/);
    const t = await call("/tickets");
    expect(t.body).toMatch(/draft/);
    expect(JSON.parse((await call("/api/tickets")).body).audit).toHaveLength(1);
  });

  it("escapes a hostile account, symbol, note, rule, decision, lesson, thesis and ticket on every page that shows them", async () => {
    await withFixture("portfolio-analytics-paper", async () => {
      for (const path of ["/?book=real", "/ledger?book=real", `/ledger?book=real&account=${encodeURIComponent(XSS)}`, "/journal", "/watch", "/tickets"]) {
        const r = await call(path);
        expect(r.status, path).toBe(200);
        expect(r.body, path).toContain(XSS_ESCAPED);
        expect(r.body, path).not.toMatch(/<script/i);
      }
    });
  }, 60_000);

  it("leaves the home directory byte for byte as it was, after every route", async () => {
    const before = hashTree(home);
    await withFixture("portfolio-analytics-paper", async () => {
      for (const book of ["paper", "real"])
        for (const r of ROUTES) {
          for (const path of [r, apiOf(r)]) expect((await call(`${path}?book=${book}`)).status, `${path} ${book}`).toBe(200);
          expect((await call(`${r}?book=${book}`, { method: "HEAD" })).status).toBe(200);
        }
    });
    expect(hashTree(home)).toEqual(before);
    expect(readdirSync(join(home, "state")).filter((f) => f.startsWith("equity-"))).toEqual([]);
    expect(existsSync(join(home, "runs"))).toBe(false);
  }, 120_000);
});

describe("serve: hints instead of errors", () => {
  it("says what to run when there is no profile, or the book is empty", async () => {
    newHome("noprofile");
    const none = await call("/");
    expect(none.status).toBe(200);
    expect(none.body).toMatch(/No profile yet: run <code>ultrastock profile init<\/code>/);
    expect(JSON.parse((await call("/api/analysis/risk")).body).hint).toMatch(/profile init/);
    saveProfile(defaultProfile("FR", "EUR"));
    const empty = await call("/analysis/risk?book=paper");
    expect(empty.status).toBe(200);
    expect(empty.body).toMatch(/The paper book is empty/);
  });

  it("names the Node the store needs when node:sqlite is missing", async () => {
    setSqliteLoaderForTests(() => {
      throw new Error("No such built-in module: node:sqlite");
    });
    await withFixture("portfolio-analytics-paper", async () => {
      const r = await call("/?book=paper");
      expect(r.status).toBe(200);
      expect(r.body).toMatch(/needs Node ≥ 22\.5/);
    });
  }, 60_000);

  it.skipIf(!sqliteSupported())(
    "draws the value over time from the store, opened read-only",
    async () => {
      const h = newHome("store");
      saveProfile(defaultProfile("FR", "EUR"));
      await appendTransactions(PAPER, "paper");
      const row = (date: string, value: number) => ({
        date,
        book: "paper",
        account: "pea",
        symbol: "MC.PA",
        quantity: 6,
        price: value / 6,
        currency: "EUR",
        cost: 3605,
        value_base: value,
        fx: 1,
        source: "test",
      });
      withStore((db) => writeSnapshots(db, [row("2026-10-01", 3600), row("2026-10-02", 3700), row("2026-10-03", 3650)]), { create: true });
      const before = hashTree(h);
      await withFixture("portfolio-analytics-paper", async () => {
        const r = await call("/?book=paper");
        expect(r.status).toBe(200);
        expect(r.body).toMatch(/<svg viewBox="0 0 720 220" role="img" aria-label="Portfolio value in EUR from 2026-10-01 to 2026-10-03">/);
        expect(r.body).toMatch(/3 daily snapshot\(s\)/);
      });
      expect(hashTree(h)).toEqual(before);
    },
    60_000,
  );
});
