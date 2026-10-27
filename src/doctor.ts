// What this machine can do: the version, where state lives, whether Node is
// recent enough for live trading, which external tools are installed, and —
// with --probe — whether each data source answers right now, and how fast.
import { MATURITY } from "./core/maturity.js";
import { checkDnsBlock, ruleStatus } from "./core/jurisdiction.js";
import { fetchText } from "./core/net.js";
import { dataCacheDir, homeDir } from "./core/paths.js";
import { loadProfile } from "./core/profile.js";
import { ENGINE_VERSION, have } from "./engine.js";
import { binanceHistoricalInfo } from "./providers/external/binance-historical.js";
import { localServices } from "./commands/stack.js";
import { CRIBLE_TAG, type CribleFreshness, cribleBootstrapped, cribleDataDir, cribleFreshness } from "./providers/external/crible.js";
import { VERSION } from "./version.js";

/** Live order submission refuses Node releases that no longer get security fixes. */
export const LIVE_NODE_MAJOR = 22;

export interface ToolReport {
  installed: boolean;
  version?: string;
  purpose: string;
}

export interface ProbeReport {
  source: string;
  url: string;
  ok: boolean;
  status: number;
  ms: number;
  note?: string;
}

export interface DoctorReport {
  version: string;
  engine: string;
  node: { version: string; major: number; liveCapable: boolean };
  home: string;
  cache: string;
  profile: { exists: boolean; jurisdiction?: string; riskScore?: number; envelopes?: number };
  tools: Record<string, ToolReport>;
  crible: { dataDir: string; bootstrapped: boolean; tag: string; freshness?: CribleFreshness };
  /** The optional local search containers, probed only with --probe. */
  services?: Array<{ name: string; url: string | null; up: boolean }>;
  /** SEC EDGAR asks automated clients for a contact in the User-Agent. */
  secContact: boolean;
  probes?: ProbeReport[];
  blocks?: Array<{ host: string; blocked: boolean; detail: string }>;
  /** Commands by maturity: stable, beta (unofficial sources), experimental (live venues). */
  maturity: Record<string, string[]>;
}

const PROBES: Array<{ source: string; url: string }> = [
  { source: "euronext", url: "https://live.euronext.com/en/instrumentSearch/searchJSON?q=FR0000121014" },
  { source: "nasdaq", url: "https://api.nasdaq.com/api/quote/AAPL/info?assetclass=stocks" },
  { source: "binance", url: "https://api.binance.com/api/v3/ping" },
];

export async function doctorReport(opts: { probe?: boolean; has?: (cmd: string) => boolean } = {}): Promise<DoctorReport> {
  const has = opts.has ?? have;
  const major = Number(process.versions.node.split(".")[0]);
  const tools: Record<string, ToolReport> = {
    "binance-historical": {
      installed: has("binance-historical"),
      purpose: "bulk crypto klines (years of bars, futures mark/index/premium)",
    },
    uvx: { installed: has("uvx"), purpose: "runs maxgfr/crible, the global fundamental screener" },
    pdftotext: { installed: has("pdftotext"), purpose: "optional: faster reading of Congress trade PDFs" },
    claude: {
      installed: has((process.env.ULTRASTOCK_CLAUDE_CMD ?? "claude").split(/\s+/)[0]!),
      purpose: "optional: research --search-with claude (Claude Code's web search, billed to your plan)",
    },
    ccs: { installed: has("ccs"), purpose: "optional: research --search-with ccs (Claude Code on your API key: `ccs with anthropic`)" },
    codex: {
      installed: has((process.env.ULTRASTOCK_CODEX_CMD ?? "codex").split(/\s+/)[0]!),
      purpose: "optional: research --search-with codex (Codex's web search, billed to your plan)",
    },
    docker: { installed: has("docker"), purpose: "optional: `ultrastock searxng up` — a local SearXNG for research --engine-search" },
  };
  if (tools["binance-historical"]!.installed && !opts.has) {
    const info = binanceHistoricalInfo();
    tools["binance-historical"]!.version =
      `${info.version ?? "?"}${info.compatible ? "" : ", describe contract changed — update ultrastock or pin binance-historical 2.x"}`;
  }
  let profile: DoctorReport["profile"] = { exists: false };
  try {
    const p = loadProfile();
    if (p) profile = { exists: true, jurisdiction: p.jurisdiction, riskScore: p.riskScore, envelopes: p.envelopes.length };
  } catch {
    profile = { exists: true };
  }
  const report: DoctorReport = {
    version: VERSION,
    engine: ENGINE_VERSION,
    node: { version: process.versions.node, major, liveCapable: major >= LIVE_NODE_MAJOR },
    home: homeDir(),
    cache: dataCacheDir(),
    profile,
    tools,
    crible: { dataDir: cribleDataDir(), bootstrapped: cribleBootstrapped(), tag: CRIBLE_TAG },
    secContact: !!process.env.ULTRASTOCK_SEC_CONTACT?.trim(),
    maturity: byMaturity(),
  };
  const fresh = report.crible.bootstrapped ? await cribleFreshness().catch(() => undefined) : undefined;
  if (fresh) report.crible.freshness = fresh;
  if (opts.probe) {
    report.services = await localServices();
    report.probes = await Promise.all(
      PROBES.map(async ({ source, url }) => {
        const t0 = Date.now();
        const r = await fetchText(url, { retries: 0, timeoutMs: 15_000 });
        const note =
          r.status === 451 ? "refused from this location (HTTP 451)" : r.rateLimited ? "rate limited" : r.ok ? undefined : (r.error ?? `HTTP ${r.status}`);
        return { source, url, ok: r.ok, status: r.status, ms: Date.now() - t0, ...(note ? { note } : {}) };
      }),
    );
    // Reported, never worked around: a regulator's block is the user's law.
    if (ruleStatus(profile.jurisdiction ?? "FR", "polymarket") !== "allowed") report.blocks = [await checkDnsBlock("gamma-api.polymarket.com")];
  }
  return report;
}

export function formatDoctor(r: DoctorReport): string {
  const lines = [
    `ultrastock ${r.version} (webindex ${r.engine})`,
    `  node        ${r.node.version}${r.node.liveCapable ? "" : ` — analysis and paper only; live orders need Node >= ${LIVE_NODE_MAJOR}`}`,
    `  state       ${r.home}`,
    `  cache       ${r.cache}`,
    `  profile     ${r.profile.exists ? `${r.profile.jurisdiction ?? "?"}, risk score ${r.profile.riskScore ?? "not assessed — run profile suitability"}, ${r.profile.envelopes ?? 0} envelope(s)` : "none — run `ultrastock profile init`"}`,
    `  sec         ${r.secContact ? "contact set (ULTRASTOCK_SEC_CONTACT)" : "no contact — set ULTRASTOCK_SEC_CONTACT to your e-mail: SEC EDGAR's fair-access policy asks for one and may block anonymous tools"}`,
    ...(r.services ?? []).map((s) => `  ${s.name.padEnd(11)} ${s.up ? `up at ${s.url}` : `not running — \`ultrastock ${s.name} up\` (optional, Docker)`}`),
    `  crible      ${r.crible.bootstrapped ? "dataset ready" : "no dataset yet (first `screen --engine crible` bootstraps it, ~1 min)"} in ${r.crible.dataDir} (pinned ${r.crible.tag})`,
    ...(r.crible.freshness ? [`              ${r.crible.freshness.stale ? "STALE — " : ""}${r.crible.freshness.message}`] : []),
    ...Object.entries(r.tools).map(
      ([name, t]) => `  ${name.padEnd(19)} ${t.installed ? `installed${t.version ? ` (${t.version})` : ""}` : "not installed"} — ${t.purpose}`,
    ),
  ];
  if (r.probes) {
    lines.push("  sources");
    for (const p of r.probes) lines.push(`    ${p.source.padEnd(10)} ${p.ok ? "ok" : "FAIL"} ${String(p.ms).padStart(5)} ms${p.note ? ` — ${p.note}` : ""}`);
  }
  for (const b of r.blocks ?? []) lines.push(`  block       ${b.host}: ${b.blocked ? `BLOCKED — ${b.detail}` : b.detail}`);
  for (const [level, cmds] of Object.entries(r.maturity)) lines.push(`  ${level.padEnd(13)}${cmds.join(" ")}`);
  return `${lines.join("\n")}\n`;
}

function byMaturity(): Record<string, string[]> {
  const out: Record<string, string[]> = { stable: [], beta: [], experimental: [] };
  for (const [cmd, level] of Object.entries(MATURITY)) out[level]!.push(cmd);
  return out;
}
