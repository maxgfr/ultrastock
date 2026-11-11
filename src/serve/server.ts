// `ultrastock serve`: a local, read-only dashboard of the user's book and
// state. It serves a person's finances, so the HTTP layer is strict:
//
//   - it binds 127.0.0.1 only (no flag to bind elsewhere), and answers only a
//     Host of 127.0.0.1:<port> or localhost:<port> — a DNS-rebinding page
//     cannot reach it under its own name;
//   - every route needs the token: printed once in the start-up URL, traded on
//     the first visit for an HttpOnly, SameSite=Strict cookie and a redirect to
//     the clean URL (so it leaves the address bar), or sent as
//     `Authorization: Bearer`; compared in constant time;
//   - GET and HEAD only, no CORS header, a CSP that allows no script and no
//     external asset, no-store, no referrer;
//   - an error shows its message, never a stack, and never the absolute path of
//     the home or cache directory.
//
// Nothing a route runs writes to ULTRASTOCK_HOME (see views.ts for how).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { clockNow } from "../core/net.js";
import { argInt, argValue, type CommandArgs, EXIT_OK, jsonLine, UsageError } from "../engine.js";
import {
  analysisPage,
  analysisTitle,
  errorBody,
  hintBody,
  journalPage,
  layout,
  ledgerPage,
  type PageId,
  portfolioPage,
  ticketsPage,
  watchPage,
} from "./pages.js";
import {
  ANALYSES,
  type AnalysisName,
  type AnalysisView,
  analysisView,
  BadRequest,
  type BookName,
  BOOKS,
  isHint,
  journalView,
  type LedgerView,
  ledgerView,
  type PortfolioView,
  portfolioView,
  ticketsView,
  watchView,
  withoutLocalPaths,
} from "./views.js";

export const DEFAULT_SERVE_PORT = 8766;
// The cookie is named after the port: browsers do not separate cookies by port, so two dashboards on one machine
// would otherwise overwrite each other's.
const cookieName = (port: number) => `ultrastock_serve_${port}`;

/** Sent with every answer, whatever its status. */
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/**
 * The token: --token, else ULTRASTOCK_SERVE_TOKEN, else a fresh random one.
 * A given token needs 24+ characters (the MCP rule) and only URL- and
 * cookie-safe ones, since it travels in both.
 */
export function serveToken(given: string | undefined): string {
  const t = given ?? process.env.ULTRASTOCK_SERVE_TOKEN;
  if (t === undefined || t === "") return randomBytes(24).toString("hex");
  if (!/^[A-Za-z0-9._~-]{24,}$/.test(t))
    throw new UsageError("the dashboard token (--token or ULTRASTOCK_SERVE_TOKEN) needs 24+ characters among letters, digits and . _ ~ -");
  return t;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Equal-length digests, so the comparison takes the same time whatever the guess. */
const tokenMatches = (given: string | undefined, want: Buffer) => given !== undefined && timingSafeEqual(digest(given), want);

function cookieToken(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function bearerToken(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m?.[1];
}

interface Route {
  page: PageId;
  api: boolean;
}

/** Only these paths exist; anything else is a 404 — no path reaches the filesystem. */
function routeOf(pathname: string): Route | undefined {
  const api = pathname.startsWith("/api/");
  const rest = api ? pathname.slice(4) : pathname;
  const page: PageId | undefined = (api ? rest === "/portfolio" : rest === "/")
    ? "portfolio"
    : rest === "/ledger" || rest === "/journal" || rest === "/watch" || rest === "/tickets"
      ? (rest.slice(1) as PageId)
      : ANALYSES.find((a) => rest === `/analysis/${a}`)
        ? (rest.slice(1) as PageId)
        : undefined;
  if (!page) return undefined;
  return { page, api };
}

const pageLabel = (page: PageId) =>
  page === "portfolio"
    ? "Portfolio"
    : page.startsWith("analysis/")
      ? analysisTitle(page.slice(9) as AnalysisName)
      : `${page[0]!.toUpperCase()}${page.slice(1)}`;

interface Answer {
  status: number;
  type: "html" | "json" | "text";
  body: string;
  headers?: Record<string, string>;
}

function send(req: http.IncomingMessage, res: http.ServerResponse, a: Answer): void {
  const type = a.type === "html" ? "text/html; charset=utf-8" : a.type === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8";
  res.writeHead(a.status, { ...SECURITY_HEADERS, "content-type": type, "content-length": String(Buffer.byteLength(a.body)), ...a.headers });
  res.end(req.method === "HEAD" ? undefined : a.body);
}

const text = (status: number, body: string, headers?: Record<string, string>): Answer => ({ status, type: "text", body: `${body}\n`, headers });

export interface DashboardOptions {
  port?: number;
  token?: string;
  /** The book a page shows when the URL names none. */
  book?: BookName;
}

export interface Dashboard {
  /** The address to open, token included. */
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

/** Start the dashboard on 127.0.0.1. Resolves once it listens. */
export async function startDashboard(opts: DashboardOptions = {}): Promise<Dashboard> {
  const token = serveToken(opts.token);
  const want = digest(token);
  const defaultBook = opts.book ?? "real";
  // Known once the server listens (the port may be picked by the system).
  let hosts = new Set<string>();
  let origins = new Set<string>();
  let cookie = "";
  // One computation per (view, book, filter) at a time: concurrent requests share it (the net layer then shares
  // identical GETs for five minutes, so a refresh does not hammer the sources).
  const inFlight = new Map<string, Promise<unknown>>();
  const shared = <T>(key: string, fn: () => T | Promise<T>): Promise<T> => {
    let p = inFlight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = Promise.resolve()
        .then(fn)
        .finally(() => inFlight.delete(key));
      inFlight.set(key, p);
    }
    return p;
  };

  async function answer(req: http.IncomingMessage): Promise<Answer> {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!hosts.has(host)) return text(403, "Forbidden: this dashboard answers on 127.0.0.1 and localhost only.");
    // A browser names the page a request comes from: only the dashboard's own pages may ask — not another site, and
    // not another local server on a different port (same site for the cookie, but not the same origin).
    if (req.headers.origin !== undefined && !origins.has(req.headers.origin)) return text(403, "Forbidden: cross-origin request.");
    if (req.method !== "GET" && req.method !== "HEAD") return text(405, "Method not allowed: the dashboard is read-only.", { allow: "GET, HEAD" });
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${host}`);
    } catch {
      // A target the URL parser refuses (`//`, `http://[`) is the client's fault, not an internal error: a 400 that
      // repeats nothing of the parser's message, answered before anything reads the URL.
      return text(400, "Bad request: the request target is not a valid URL.");
    }
    const route = routeOf(url.pathname);
    const queryToken = url.searchParams.get("token");
    if (queryToken !== null) {
      if (!tokenMatches(queryToken, want)) return text(401, "Unauthorized: open the URL `ultrastock serve` printed.");
      url.searchParams.delete("token");
      const search = url.searchParams.toString();
      // A redirect target is a known route's path (routeOf matched it exactly) or the root — never `//elsewhere`.
      return text(303, "See other", {
        location: `${route ? url.pathname : "/"}${search ? `?${search}` : ""}`,
        "set-cookie": `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }
    if (!tokenMatches(cookieToken(req.headers.cookie, cookie), want) && !tokenMatches(bearerToken(req.headers.authorization), want))
      return route?.api
        ? {
            status: 401,
            type: "json",
            body: jsonLine({ error: "unauthorized: send Authorization: Bearer <token>" }),
            headers: { "www-authenticate": 'Bearer realm="ultrastock"' },
          }
        : text(401, "Unauthorized: open the URL `ultrastock serve` printed (it carries the token once).", { "www-authenticate": 'Bearer realm="ultrastock"' });
    if (!route) return text(404, "Not found.");

    const now = clockNow();
    const bookParam = url.searchParams.get("book") ?? defaultBook;
    const book = (BOOKS as readonly string[]).includes(bookParam) ? (bookParam as BookName) : undefined;
    const page = route.page;
    const htmlPage = (status: number, body: string): Answer => ({
      status,
      type: "html",
      body: layout({ title: pageLabel(page), page, book: book ?? defaultBook, asOf: now.toISOString(), body }),
    });
    const failed = (status: number, message: string): Answer =>
      route.api ? { status, type: "json", body: jsonLine({ error: message }) } : htmlPage(status, errorBody(message));
    if (!book) return failed(400, "the book is real or paper");
    try {
      let view: unknown;
      if (page === "portfolio") view = await shared(`${page}|${book}`, () => portfolioView(book, now));
      else if (page.startsWith("analysis/")) view = await shared(`${page}|${book}`, () => analysisView(book, page.slice(9) as AnalysisName, now));
      else if (page === "ledger") {
        // An empty value is the form's "all".
        const account = url.searchParams.get("account") || undefined;
        const symbol = url.searchParams.get("symbol") || undefined;
        view = await shared(JSON.stringify([page, book, account, symbol]), () => ledgerView(book, { account, symbol }, now));
      } else if (page === "journal") view = await shared(page, () => journalView(now));
      else if (page === "watch") view = await shared(page, () => watchView(now));
      else view = await shared(page, () => ticketsView(now));
      if (route.api) return { status: 200, type: "json", body: jsonLine(view) };
      if (isHint(view)) return htmlPage(200, hintBody(view));
      const body =
        page === "portfolio"
          ? portfolioPage(view as PortfolioView)
          : page.startsWith("analysis/")
            ? analysisPage(view as AnalysisView)
            : page === "ledger"
              ? ledgerPage(view as LedgerView)
              : page === "journal"
                ? journalPage(view as ReturnType<typeof journalView>, book)
                : page === "watch"
                  ? watchPage(view as ReturnType<typeof watchView>, book)
                  : ticketsPage(view as ReturnType<typeof ticketsView>, book);
      return { status: 200, type: "html", body };
    } catch (e) {
      return failed(e instanceof BadRequest ? 400 : 500, withoutLocalPaths(e instanceof Error ? e.message : String(e)));
    }
  }

  const server = http.createServer((req, res) => {
    answer(req).then(
      (a) => send(req, res, a),
      (e: unknown) => send(req, res, text(500, `Internal error: ${withoutLocalPaths(e instanceof Error ? e.message : String(e))}`)),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "EADDRINUSE" ? new Error(`port ${opts.port ?? DEFAULT_SERVE_PORT} is in use: pass --port <n> (0 picks a free one)`) : e),
    );
    server.listen(opts.port ?? DEFAULT_SERVE_PORT, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  origins = new Set([...hosts].map((h) => `http://${h}`));
  cookie = cookieName(port);
  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** `ultrastock serve [--port 8766] [--token <24+ chars>] [--book real|paper]`: start, say where, stop on SIGINT/SIGTERM. */
export async function serveCommand(args: CommandArgs): Promise<void> {
  const port = argInt(args, "port", { min: 0, max: 65_535 });
  const book = argValue(args, "book");
  if (book !== undefined && !(BOOKS as readonly string[]).includes(book)) throw new UsageError("--book is real or paper");
  const d = await startDashboard({ port, token: argValue(args, "token"), book: book as BookName | undefined });
  process.stderr.write(
    `ultrastock dashboard (read-only) on ${d.url}\n  open it in a browser — the token is traded for a cookie on the first visit; Ctrl-C stops it\n`,
  );
  const stop = () => {
    void d.close().then(() => process.exit(EXIT_OK));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
