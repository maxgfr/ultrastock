// Tickets: the only way an order reaches a venue, paper or real.
//
//   draft  → (risk check) → checked | blocked
//   checked → (paper submit)            → filled | working → filled | expired
//   checked → (live submit, with an out-of-band code — later) → submitted → …
//   any open state → cancelled
//
// A ticket carries the order's fingerprint from its risk check: change one
// number of the order and the check no longer applies. A check older than
// CHECK_TTL_MS must be run again (prices move). Every transition is appended
// to the audit trail with fsync, before and after anything executes.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../engine.js";
import { withFileLock } from "../core/lock.js";
import { homeDir } from "../core/paths.js";
import { type GateResult, type Order, orderFingerprint } from "./riskgate.js";

export const CHECK_TTL_MS = 15 * 60_000;

export type TicketStatus = "draft" | "checked" | "blocked" | "working" | "filled" | "submitted" | "cancelled" | "expired";

export interface Fill {
  at: string;
  quantity: number;
  price: number;
  fee: number;
  venue: string;
  /** How the price was obtained: "order-book walk", "last ± slippage". */
  method: string;
}

export interface Ticket {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: TicketStatus;
  order: Order;
  fingerprint: string;
  /** The analysis run and decision behind the ticket, if any. */
  run?: string;
  note?: string;
  check?: { at: string; verdict: GateResult["verdict"]; fingerprint: string; checks: GateResult["checks"] };
  fills: Fill[];
  /** A working limit order lapses after this instant. */
  validUntil?: string;
  history: Array<{ at: string; from: TicketStatus | "none"; to: TicketStatus; why: string }>;
}

export const ticketsDir = () => join(homeDir(), "tickets");
const ticketPath = (id: string) => {
  if (!/^t-[a-z0-9-]{6,80}$/.test(id)) throw new Error(`"${id}" is not a ticket id`);
  return join(ticketsDir(), `${id}.json`);
};

/** Append one line to the order audit trail and flush it to disk before returning. */
export function audit(event: Record<string, unknown>): void {
  const dir = join(homeDir(), "audit");
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, "orders.jsonl"), "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readAudit(): Array<Record<string, unknown> & { at: string }> {
  const f = join(homeDir(), "audit", "orders.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function loadTicket(id: string): Ticket {
  const p = ticketPath(id);
  if (!existsSync(p)) throw new Error(`no ticket ${id}`);
  return JSON.parse(readFileSync(p, "utf8")) as Ticket;
}

function save(t: Ticket): void {
  mkdirSync(ticketsDir(), { recursive: true });
  writeFileAtomic(ticketPath(t.id), `${JSON.stringify(t, null, 2)}\n`, 0o600);
}

export function listTickets(filter?: (t: Ticket) => boolean): Ticket[] {
  if (!existsSync(ticketsDir())) return [];
  return readdirSync(ticketsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(ticketsDir(), f), "utf8")) as Ticket)
    .filter((t) => !filter || filter(t))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Change a ticket's state under its lock, recording why, and audit the transition. */
export async function transition(id: string, to: TicketStatus, why: string, mutate?: (t: Ticket) => void, now = new Date()): Promise<Ticket> {
  return withFileLock(`${ticketPath(id)}.lock`, () => {
    const t = loadTicket(id);
    const from = t.status;
    mutate?.(t);
    t.status = to;
    t.updatedAt = now.toISOString();
    t.history.push({ at: t.updatedAt, from, to, why });
    save(t);
    audit({ event: "ticket", id, from, to, why, fingerprint: t.fingerprint, order: t.order });
    return t;
  });
}

export function createTicket(order: Order, opts: { run?: string; note?: string; validUntil?: string; now?: Date } = {}): Ticket {
  const now = opts.now ?? new Date();
  const fingerprint = orderFingerprint(order);
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const t: Ticket = {
    id: `t-${stamp}-${fingerprint.slice(0, 8)}`,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "draft",
    order,
    fingerprint,
    run: opts.run,
    note: opts.note,
    fills: [],
    validUntil: opts.validUntil,
    history: [{ at: now.toISOString(), from: "none", to: "draft", why: "created" }],
  };
  if (existsSync(ticketPath(t.id))) throw new Error(`ticket ${t.id} already exists`);
  save(t);
  audit({ event: "ticket", id: t.id, from: "none", to: "draft", fingerprint, order });
  return t;
}

/** Record a risk-gate result on a ticket: checked if it passed, blocked otherwise. */
export async function recordCheck(id: string, gate: GateResult, now = new Date()): Promise<Ticket> {
  const t = loadTicket(id);
  if (!["draft", "checked", "blocked"].includes(t.status)) throw new Error(`ticket ${id} is ${t.status}: it can no longer be checked`);
  if (gate.fingerprint !== t.fingerprint) throw new Error(`the risk check was run on a different order than ticket ${id} holds`);
  const blocks = gate.checks.filter((c) => c.status === "block");
  return transition(
    id,
    gate.verdict === "pass" ? "checked" : "blocked",
    gate.verdict === "pass" ? "risk gate passed" : `risk gate blocked: ${blocks.map((b) => b.code).join(", ")}`,
    (x) => {
      x.check = { at: now.toISOString(), verdict: gate.verdict, fingerprint: gate.fingerprint, checks: gate.checks };
    },
    now,
  );
}

/** Why a ticket may not be executed now; undefined when it may. */
export function executionRefusal(t: Ticket, now = new Date()): string | undefined {
  if (t.status !== "checked") return `ticket ${t.id} is ${t.status}, not checked — run \`ultrastock ticket check ${t.id}\``;
  if (!t.check || t.check.verdict !== "pass") return "the ticket has no passing risk check";
  if (t.check.fingerprint !== orderFingerprint(t.order) || t.fingerprint !== t.check.fingerprint)
    return "the order changed after its risk check — check it again";
  if (now.getTime() - Date.parse(t.check.at) > CHECK_TTL_MS)
    return `the risk check is older than ${CHECK_TTL_MS / 60_000} minutes — prices move: check it again`;
  if (t.validUntil && now.getTime() > Date.parse(t.validUntil)) return "the ticket has expired";
  return undefined;
}
