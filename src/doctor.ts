// What this machine can do: the version, where state lives, whether Node is
// recent enough for live trading, which external tools are installed, and —
// with --probe — whether each data source answers right now, and how fast.
import { ENGINE_VERSION, have, sh } from "./engine.js";
import { dataCacheDir, homeDir } from "./core/paths.js";
import { fetchText } from "./core/net.js";
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
  tools: Record<string, ToolReport>;
  probes?: ProbeReport[];
}

function toolVersion(cmd: string, args: string[]): string | undefined {
  const r = sh(cmd, args, { timeoutMs: 10_000 });
  const line = r.ok ? r.stdout.trim().split("\n")[0] : undefined;
  return line || undefined;
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
  };
  if (tools["binance-historical"]!.installed) tools["binance-historical"]!.version = toolVersion("binance-historical", ["--version"]);
  const report: DoctorReport = {
    version: VERSION,
    engine: ENGINE_VERSION,
    node: { version: process.versions.node, major, liveCapable: major >= LIVE_NODE_MAJOR },
    home: homeDir(),
    cache: dataCacheDir(),
    tools,
  };
  if (opts.probe) {
    report.probes = await Promise.all(
      PROBES.map(async ({ source, url }) => {
        const t0 = Date.now();
        const r = await fetchText(url, { retries: 0, timeoutMs: 15_000 });
        const note =
          r.status === 451 ? "refused from this location (HTTP 451)" : r.rateLimited ? "rate limited" : r.ok ? undefined : (r.error ?? `HTTP ${r.status}`);
        return { source, url, ok: r.ok, status: r.status, ms: Date.now() - t0, ...(note ? { note } : {}) };
      }),
    );
  }
  return report;
}

export function formatDoctor(r: DoctorReport): string {
  const lines = [
    `ultrastock ${r.version} (webindex ${r.engine})`,
    `  node        ${r.node.version}${r.node.liveCapable ? "" : ` — analysis and paper only; live orders need Node >= ${LIVE_NODE_MAJOR}`}`,
    `  state       ${r.home}`,
    `  cache       ${r.cache}`,
    ...Object.entries(r.tools).map(
      ([name, t]) => `  ${name.padEnd(19)} ${t.installed ? `installed${t.version ? ` (${t.version})` : ""}` : "not installed"} — ${t.purpose}`,
    ),
  ];
  if (r.probes) {
    lines.push("  sources");
    for (const p of r.probes) lines.push(`    ${p.source.padEnd(10)} ${p.ok ? "ok" : "FAIL"} ${String(p.ms).padStart(5)} ms${p.note ? ` — ${p.note}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}
